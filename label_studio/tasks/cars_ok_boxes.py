"""cars-mods (backend-fork 2026-06): seed an OK-verdict annotation with the prediction's boxes.

The SAM3 jewelry verify workflow shows the model's prediction (rectangle boxes) for the annotator
to judge OK / WRONG / BAD_PHOTO. When she marks OK, her annotation must carry the boxes she
approved — otherwise the OK is saved empty (no geometry) and the verification is lost (the
"empty-OK" bug: 35 of Наташа's 2635 annotations were OK with no boxes although the prediction
HAD boxes).

This helper copies the prediction's rectangle regions into an OK annotation that has none. It is
used by BOTH:
  - the pre_save signal on Annotation (tasks/cars_signals.py) — prevents NEW empty-OK at the
    source: every OK save for a cars project that lacks boxes gets the prediction's boxes; and
  - the ``cars_fix_empty_ok_boxes`` management command — backfills already-saved empty OKs.

It only ever ADDS geometry to an OK that has none; it never removes anything, never touches
WRONG / BAD_PHOTO (no OK choice) and never touches an annotation that already has a rectangle.
"""

from __future__ import annotations

import copy
import logging
import uuid

logger = logging.getLogger(__name__)

# SAM3 verify projects (jewelry/stones). Same set used across the cars-mods backend.
CARS_PROJECTS = {8, 9, 10}


def _is_rectangle(item) -> bool:
    if not isinstance(item, dict):
        return False
    if item.get('type') == 'rectanglelabels':
        return True
    v = item.get('value')
    return isinstance(v, dict) and 'width' in v and 'height' in v


def has_rectangle(result) -> bool:
    return any(_is_rectangle(i) for i in (result or []))


def has_ok_choice(result) -> bool:
    """True if the result carries a Choices region whose value includes "OK" (the verdict)."""
    for i in (result or []):
        if not isinstance(i, dict):
            continue
        v = i.get('value') or {}
        choices = v.get('choices')
        if isinstance(choices, list) and any(str(c).strip().upper() == 'OK' for c in choices):
            return True
    return False


def _prediction_rectangles(prediction_results) -> list:
    """Rectangle items from the first prediction result-list that has any."""
    for result in (prediction_results or []):
        rects = [i for i in (result or []) if _is_rectangle(i)]
        if rects:
            return rects
    return []


def boxes_for_ok(result, prediction_results):
    """If ``result`` is an OK verdict with NO boxes, return ``result`` + the prediction's
    rectangle regions (fresh region ids, model ``score`` stripped). Otherwise return ``None``
    (leave the annotation unchanged). Fully defensive: any malformed input returns ``None``.
    """
    try:
        if has_rectangle(result):
            return None
        if not has_ok_choice(result):
            return None
        rects = _prediction_rectangles(prediction_results)
        if not rects:
            return None
        out = list(result or [])
        for r in rects:
            nr = copy.deepcopy(r)
            # fresh region id so it never collides with the prediction's region; it's now a real
            # annotated region, not a model suggestion → drop prediction-only fields.
            nr['id'] = uuid.uuid4().hex[:10]
            nr.pop('score', None)
            nr.pop('readonly', None)
            out.append(nr)
        return out
    except Exception:
        logger.exception('cars boxes_for_ok failed')
        return None
