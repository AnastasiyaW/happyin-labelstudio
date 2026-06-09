"""cars-mods (backend-fork 2026-06): pre-annotation coverage computation.

Computes, for a Label Studio prediction ``result`` list, the maximum fraction of the
image area covered by any single region. Project-agnostic: handles ``rectanglelabels``,
``polygonlabels`` and ``brushlabels`` (RLE). Used to bucket tasks into "big" (region
fills >= threshold of the frame — e.g. a jewelry item / car shot close-up, or a
whole-image false detection) vs "small" pre-annotations in the DataManager grid.

Coverage is a float fraction in ``[0, 1]``. The grid stores/reads it from
``Task.meta['cars_pred_coverage']`` (no schema migration — ``meta`` already exists on
stock ``Task`` and is exposed via ``DataManagerTaskSerializer``).

Why MAX single-region (not sum/union): the user-facing question is "does the markup
occupy more than N% of the photo?". A single region filling the frame is the exact
signal; summing overlapping regions can exceed 1 and over-count, union needs
rasterization. Max is cheap, bounded to [0,1] and matches the intent.

Pure-Python except for the brush branch, which lazily imports numpy (only needed when a
project actually uses brush masks — the SAM3 pipeline converts masks to polygons, so
predictions are usually rectangle/polygon and numpy is never touched).
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def _clamp01(x: float) -> float:
    if x != x:  # NaN
        return 0.0
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def _rect_area_frac(value: dict) -> float:
    """rectanglelabels: value.width / value.height are percentages (0..100)."""
    try:
        w = float(value.get('width', 0) or 0)
        h = float(value.get('height', 0) or 0)
    except (TypeError, ValueError):
        return 0.0
    return _clamp01((w * h) / 10000.0)


def _polygon_area_frac(value: dict) -> float:
    """polygonlabels: value.points = [[x%, y%], ...] in percentages. Shoelace formula.

    Area in percent^2 / 10000 -> fraction of the image. Handles self-closing and
    arbitrary winding (abs)."""
    pts = value.get('points') or []
    if not isinstance(pts, (list, tuple)) or len(pts) < 3:
        return 0.0
    area2 = 0.0
    n = len(pts)
    try:
        for i in range(n):
            x1, y1 = float(pts[i][0]), float(pts[i][1])
            x2, y2 = float(pts[(i + 1) % n][0]), float(pts[(i + 1) % n][1])
            area2 += x1 * y2 - x2 * y1
    except (TypeError, ValueError, IndexError):
        return 0.0
    return _clamp01(abs(area2) / 2.0 / 10000.0)


def _brush_area_frac(item: dict, value: dict) -> float:
    """brushlabels: value.rle is Label Studio's run-length-encoded RGBA mask.

    Decodes to a flat uint8 array of length W*H*4; the painted area is where the alpha
    channel (every 4th byte) is non-zero. coverage = painted_pixels / (W*H).

    Lazily imports numpy; returns 0.0 (logged) if numpy or the rle is unavailable so the
    caller degrades gracefully instead of crashing a whole backfill batch.
    """
    rle = value.get('rle')
    if not rle:
        return 0.0
    w = int(item.get('original_width') or 0)
    h = int(item.get('original_height') or 0)
    if w <= 0 or h <= 0:
        return 0.0
    try:
        import numpy as np
    except Exception:  # numpy not installed in this context
        logger.warning('cars_coverage: numpy unavailable, skipping brush region')
        return 0.0
    try:
        out = _decode_ls_rle(rle, np)
        if out is None or out.size < w * h * 4:
            return 0.0
        alpha = out[3 : w * h * 4 : 4]
        painted = int((alpha > 0).sum())
        return _clamp01(painted / float(w * h))
    except Exception as exc:  # malformed rle — don't kill the batch
        logger.warning('cars_coverage: brush rle decode failed: %s', exc)
        return 0.0


def _decode_ls_rle(rle: list, np) -> Any:
    """Label Studio brush RLE decoder (access-bit stream format). Returns a uint8 array."""

    class _InputStream:
        __slots__ = ('data', 'i')

        def __init__(self, data: str):
            self.data = data
            self.i = 0

        def read(self, size: int) -> int:
            out = self.data[self.i : self.i + size]
            self.i += size
            return int(out, 2)

    def _access_bit(data, num):
        base = num // 8
        shift = 7 - (num % 8)
        return (data[base] & (1 << shift)) >> shift

    bits = ''.join(str(_access_bit(rle, i)) for i in range(len(rle) * 8))
    stream = _InputStream(bits)
    num = stream.read(32)
    word_size = stream.read(5) + 1
    rle_sizes = [stream.read(4) + 1 for _ in range(4)]
    out = np.zeros(num, dtype=np.uint8)
    i = 0
    while i < num:
        x = stream.read(1)
        j = i + 1 + stream.read(rle_sizes[stream.read(2)])
        if x:
            val = stream.read(word_size)
            out[i:j] = val
            i = j
        else:
            while i < j:
                out[i] = stream.read(word_size)
                i += 1
    return out


def region_coverage(item: dict) -> float:
    """Coverage fraction (0..1) of a single LS result item. 0.0 for non-geometry items."""
    if not isinstance(item, dict):
        return 0.0
    value = item.get('value')
    if not isinstance(value, dict):
        return 0.0
    rtype = item.get('type')
    if rtype == 'rectanglelabels' or (rtype is None and 'width' in value and 'height' in value):
        return _rect_area_frac(value)
    if rtype == 'polygonlabels' or (rtype is None and 'points' in value):
        return _polygon_area_frac(value)
    if rtype == 'brushlabels' or 'rle' in value:
        return _brush_area_frac(item, value)
    return 0.0


def result_max_coverage(result: list) -> float:
    """Max single-region coverage across one prediction's ``result`` list."""
    if not isinstance(result, (list, tuple)):
        return 0.0
    best = 0.0
    for item in result:
        c = region_coverage(item)
        if c > best:
            best = c
    return best


def predictions_max_coverage(predictions: list) -> float:
    """Max single-region coverage across all of a task's predictions.

    ``predictions`` is a list of prediction dicts (each with a ``result`` list) OR a list
    of raw result-lists. The max over everything is the task's "biggest pre-annotation".
    """
    if not predictions:
        return 0.0
    best = 0.0
    for p in predictions:
        result = p.get('result') if isinstance(p, dict) else p
        c = result_max_coverage(result)
        if c > best:
            best = c
    return best
