"""generate_thumbs.py — впечатать SAM3 bbox+маски в thumbnail-картинки для LS grid view.

Читает ls_tasks.with_predictions.jsonl, для каждой задачи открывает оригинал из
cars-local/, рисует overlay (rectangle + filled polygon с alpha) для каждого
prediction, сохраняет JPEG ≤768px в cars-thumbs/.

На выходе - ls_tasks.with_thumbs.jsonl с добавленным data.thumb URL.

Запуск:
    /opt/diamant-runpod/cars-filter/venv-merge/bin/python generate_thumbs.py
"""
from __future__ import annotations

import json
import multiprocessing as mp
import os
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT_FILES = Path('/opt/diamant-runpod/label-studio/files')
CARS_LOCAL = ROOT_FILES / 'cars-local'
CARS_THUMBS = ROOT_FILES / 'cars-thumbs'

JSONL_IN = Path('/opt/diamant-runpod/cars-filter/ls_tasks.with_predictions.jsonl')
JSONL_OUT = Path('/opt/diamant-runpod/cars-filter/ls_tasks.with_thumbs.jsonl')

# class -> BGR (cv2 uses BGR not RGB)
CLASS_COLOR = {
    'car':           (0, 107, 255),    # #FF6B00 orange
    'car window':    (255, 182, 31),   # #1FB6FF sky blue
    'car wheel':     (102, 206, 19),   # #13CE66 green
    'car interior':  (0, 180, 244),    # #F4B400 yellow
    'license plate': (254, 19, 144),   # #9013FE purple
}

ALPHA = 0.35
RECT_THICKNESS = 3
MAX_DIM = 768
JPEG_QUALITY = 85
WORKERS = max(2, mp.cpu_count() - 2)


def render_one(task_dict):
    image_url = task_dict['data']['image']
    qs = image_url.split('?d=', 1)[1]  # cars-local/images/машины/<id>.jpg
    src = ROOT_FILES / qs
    # output path: cars-thumbs preserves structure under cars-local
    rel = qs.replace('cars-local/', '', 1)
    dst = CARS_THUMBS / rel
    dst.parent.mkdir(parents=True, exist_ok=True)

    if dst.exists() and dst.stat().st_size > 0:
        return ('skip', str(rel))

    img = cv2.imread(str(src), cv2.IMREAD_COLOR)
    if img is None:
        return ('read_fail', str(src))
    h, w = img.shape[:2]

    overlay = img.copy()
    preds = task_dict.get('predictions') or []
    if preds:
        for r in preds[0].get('result', []):
            t = r['type']
            v = r['value']
            if t == 'rectanglelabels':
                cls = v['rectanglelabels'][0]
                color = CLASS_COLOR.get(cls)
                if color is None:
                    continue
                x1 = int(v['x'] / 100.0 * w)
                y1 = int(v['y'] / 100.0 * h)
                x2 = int((v['x'] + v['width']) / 100.0 * w)
                y2 = int((v['y'] + v['height']) / 100.0 * h)
                cv2.rectangle(img, (x1, y1), (x2, y2), color, RECT_THICKNESS)
            elif t == 'polygonlabels':
                cls = v['polygonlabels'][0]
                color = CLASS_COLOR.get(cls)
                if color is None:
                    continue
                pts = np.array(
                    [[int(p[0] / 100.0 * w), int(p[1] / 100.0 * h)] for p in v['points']],
                    dtype=np.int32,
                )
                cv2.fillPoly(overlay, [pts], color)
        img = cv2.addWeighted(overlay, ALPHA, img, 1 - ALPHA, 0)

    # downscale
    scale = MAX_DIM / max(h, w)
    if scale < 1.0:
        new_w = int(w * scale)
        new_h = int(h * scale)
        img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)

    ok = cv2.imwrite(str(dst), img, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    if not ok:
        return ('write_fail', str(dst))
    return ('ok', str(rel))


def task_iter():
    with JSONL_IN.open(encoding='utf-8') as f:
        for line in f:
            task = json.loads(line)
            yield task


def main():
    CARS_THUMBS.mkdir(parents=True, exist_ok=True)
    print(f'workers={WORKERS}  alpha={ALPHA}  max_dim={MAX_DIM}px  jpeg_q={JPEG_QUALITY}')

    n_ok = n_skip = n_fail = n_total = 0
    t0 = time.time()
    out_fh = JSONL_OUT.open('w', encoding='utf-8')

    tasks = list(task_iter())
    print(f'total tasks: {len(tasks):,}')

    with mp.Pool(WORKERS) as pool:
        for task, (status, info) in zip(tasks, pool.imap(render_one, tasks, chunksize=64)):
            n_total += 1
            if status == 'ok' or status == 'skip':
                # add data.thumb URL
                rel = task['data']['image'].split('?d=', 1)[1].replace('cars-local/', 'cars-thumbs/', 1)
                task['data']['thumb'] = f'/data/local-files/?d={rel}'
                if status == 'ok':
                    n_ok += 1
                else:
                    n_skip += 1
            else:
                n_fail += 1
            out_fh.write(json.dumps(task, ensure_ascii=False) + '\n')
            if n_total % 5000 == 0:
                dt = time.time() - t0
                rate = n_total / dt if dt else 0
                eta = (len(tasks) - n_total) / rate / 60 if rate else 0
                print(f'  {n_total:,}/{len(tasks):,}  ok={n_ok:,} skip={n_skip:,} fail={n_fail:,} rate={rate:.0f}/s ETA={eta:.1f}m')

    out_fh.close()
    print(f'\nDONE: ok={n_ok:,} skip={n_skip:,} fail={n_fail:,} of {n_total:,} in {time.time()-t0:.0f}s')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    main()
