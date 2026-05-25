"""merge_predictions.py — мерж SAM3 detections в LS-таски.

multiclass (5 классов) приоритет; fallback на single-class car. RLE→polygon
через pycocotools+cv2, конверт px→% относительно width/height из detection.
"""
from __future__ import annotations

import glob
import json
import os
import sys
import time
from collections import Counter

import cv2
import numpy as np
from pycocotools import mask as cocomask

CARS_FILTER = '/opt/diamant-runpod/cars-filter'
MULTICLASS_DIR = f'{CARS_FILTER}/multiclass'
SINGLE_CLASS_DIR = f'{CARS_FILTER}/labels'
JSONL_IN = os.environ.get('JSONL_IN', f'{CARS_FILTER}/ls_tasks.jsonl')
JSONL_OUT = os.environ.get('JSONL_OUT', f'{CARS_FILTER}/ls_tasks.with_predictions.jsonl')

POLY_EPSILON_RATIO = 0.002
MIN_POLY_POINTS = 4

CLASSES = ['car', 'car window', 'car wheel', 'car interior', 'license plate']


def rle_to_polygons(rle_dict):
    h, w = rle_dict['size']
    counts = rle_dict['counts']
    if isinstance(counts, str):
        counts = counts.encode('utf-8')
    rle = {'size': [h, w], 'counts': counts}
    binary = cocomask.decode(rle)
    if binary.sum() == 0:
        return []
    contours, _ = cv2.findContours(binary.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    polygons = []
    for cnt in contours:
        if len(cnt) < MIN_POLY_POINTS:
            continue
        peri = cv2.arcLength(cnt, True)
        eps = POLY_EPSILON_RATIO * peri
        simplified = cv2.approxPolyDP(cnt, eps, True)
        if len(simplified) < MIN_POLY_POINTS:
            continue
        pts = simplified.reshape(-1, 2).tolist()
        polygons.append(pts)
    return polygons


def make_prediction_result(detections_by_class, width, height):
    result = []
    for cls, dets in detections_by_class.items():
        if cls not in CLASSES:
            continue
        for det in dets:
            x1, y1, x2, y2 = det['box']
            result.append({
                'from_name': 'bbox', 'to_name': 'image',
                'type': 'rectanglelabels',
                'original_width': width, 'original_height': height,
                'value': {
                    'x': 100.0 * x1 / width,
                    'y': 100.0 * y1 / height,
                    'width': 100.0 * (x2 - x1) / width,
                    'height': 100.0 * (y2 - y1) / height,
                    'rotation': 0,
                    'rectanglelabels': [cls],
                },
            })
            if 'mask' in det:
                polys = rle_to_polygons(det['mask'])
                for poly in polys:
                    points_pct = [[100.0 * p[0] / width, 100.0 * p[1] / height] for p in poly]
                    result.append({
                        'from_name': 'mask', 'to_name': 'image',
                        'type': 'polygonlabels',
                        'original_width': width, 'original_height': height,
                        'value': {
                            'points': points_pct,
                            'polygonlabels': [cls],
                        },
                    })
    return result


def load_index():
    idx = {}
    n_multi = 0
    for f in sorted(glob.glob(os.path.join(MULTICLASS_DIR, 'detections_*.jsonl'))):
        with open(f) as fh:
            for line in fh:
                d = json.loads(line)
                idx[d['name']] = {
                    'classes': d['classes'],
                    'width': d['width'], 'height': d['height'],
                    'source': 'multi',
                }
                n_multi += 1
    print(f'  multiclass indexed: {n_multi:,}')
    n_single = 0
    for f in sorted(glob.glob(os.path.join(SINGLE_CLASS_DIR, 'detections_*.jsonl'))):
        with open(f) as fh:
            for line in fh:
                d = json.loads(line)
                if d['name'] in idx:
                    continue
                idx[d['name']] = {
                    'classes': {'car': d['detections']},
                    'width': d['width'], 'height': d['height'],
                    'source': 'single',
                }
                n_single += 1
    print(f'  single-class indexed (new): {n_single:,}')
    print(f'  total in index: {len(idx):,}')
    return idx


def main():
    print('=== building detection index ===')
    t0 = time.time()
    idx = load_index()
    print(f'  index built in {time.time()-t0:.1f}s')

    print('\n=== merging into LS tasks ===')
    n = with_pred = no_pred = 0
    src_count = Counter()
    cls_count = Counter()
    err_count = Counter()
    t0 = time.time()
    with open(JSONL_IN) as fin, open(JSONL_OUT, 'w') as fout:
        for line in fin:
            n += 1
            task = json.loads(line)
            name = task['data']['name']
            det_record = idx.get(name)
            if det_record:
                try:
                    result = make_prediction_result(
                        det_record['classes'], det_record['width'], det_record['height'])
                    if result:
                        task['predictions'] = [{
                            'model_version': 'sam3-' + det_record['source'],
                            'score': task['data'].get('car_score', 1.0),
                            'result': result,
                        }]
                        with_pred += 1
                        src_count[det_record['source']] += 1
                        for r in result:
                            if r['type'] == 'rectanglelabels':
                                cls_count[r['value']['rectanglelabels'][0]] += 1
                    else:
                        no_pred += 1
                except Exception as exc:
                    err_count[exc.__class__.__name__] += 1
                    no_pred += 1
            else:
                no_pred += 1
            fout.write(json.dumps(task, ensure_ascii=False) + '\n')
            if n % 20000 == 0:
                dt = time.time() - t0
                rate = n / dt
                eta = (192333 - n) / rate / 60
                print(f'  {n:,}  with_pred={with_pred:,} no_pred={no_pred:,} rate={rate:.0f}/s ETA={eta:.1f}m')

    print(f'\nDONE: total={n:,} with_pred={with_pred:,} no_pred={no_pred:,} in {time.time()-t0:.0f}s')
    print(f'sources: {dict(src_count)}')
    print(f'errors: {dict(err_count)}')
    print(f'class detection counts (bbox):')
    for c, k in cls_count.most_common():
        print(f'  {c:<20} {k:>8,}')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    main()
