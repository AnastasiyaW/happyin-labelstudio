"""filter_15pct.py — собрать список фото где class='car' занимает >=15% кадра.

Читает ls_tasks.with_predictions.jsonl, для каждой задачи суммирует площадь всех
bbox класса 'car' (только кузов, не части), пишет 2 файла:
- car_15pct_list.txt — пути файлов под cars-local/, по одному на строку (rclone --files-from)
- car_15pct_stats.tsv — pin_id, car_score, total_car_area для аудита
"""
import json, sys
from collections import Counter

JSONL = '/opt/diamant-runpod/cars-filter/ls_tasks.with_predictions.jsonl'
OUT_LIST = '/opt/diamant-runpod/cars-filter/car_15pct_list.txt'
OUT_STATS = '/opt/diamant-runpod/cars-filter/car_15pct_stats.tsv'
THRESHOLD = 0.15  # 15%

n_total = n_with_pred = n_kept = n_no_pred = 0
buckets = Counter()  # debug histogram

with open(JSONL, encoding='utf-8') as fin, \
     open(OUT_LIST, 'w', encoding='utf-8') as flist, \
     open(OUT_STATS, 'w', encoding='utf-8') as fstats:
    fstats.write('pin_id\troot\tcar_score\ttotal_car_area_pct\tn_car_boxes\n')
    for line in fin:
        n_total += 1
        t = json.loads(line)
        preds = t.get('predictions') or []
        if not preds:
            n_no_pred += 1
            continue
        n_with_pred += 1
        # collect 'car' rectanglelabels only
        car_boxes = []
        for r in preds[0].get('result', []):
            if r['type'] != 'rectanglelabels':
                continue
            if 'car' not in r['value'].get('rectanglelabels', []):
                continue
            # value.width and value.height are in % (0-100), area is fraction width*height/10000
            w_pct = r['value'].get('width', 0)
            h_pct = r['value'].get('height', 0)
            area_frac = (w_pct * h_pct) / 10000.0  # both in %, so /10000 to get fraction
            # filter to exact 'car' (not 'car window' or 'car wheel')
            if r['value']['rectanglelabels'] == ['car']:
                car_boxes.append(area_frac)
        total = sum(car_boxes)
        # bucket for debug
        bucket = int(total * 20) * 5  # bins of 5%
        buckets[bucket] += 1
        if total >= THRESHOLD:
            # extract path from data.image: /data/local-files/?d=cars-local/images/машины/<id>.jpg
            img_url = t['data']['image']
            qs = img_url.split('?d=', 1)[1] if '?d=' in img_url else img_url
            # strip cars-local/ prefix — we copy relative to cars-local
            rel = qs.replace('cars-local/', '', 1)
            flist.write(rel + '\n')
            n_kept += 1
            fstats.write(f"{t['data'].get('pin_id','')}\t{t['data'].get('root','')}\t{t['data'].get('car_score',0):.4f}\t{total:.4f}\t{len(car_boxes)}\n")

print(f'total tasks:       {n_total:,}')
print(f'  no predictions:  {n_no_pred:,}')
print(f'  with predictions:{n_with_pred:,}')
print(f'  KEPT (>={THRESHOLD*100:.0f}%):  {n_kept:,}')
print()
print('distribution of total car area (% bins):')
for b in sorted(buckets):
    bar = '█' * min(50, buckets[b] // 1000)
    print(f'  {b:>3}-{b+5:>3}%: {buckets[b]:>7,}  {bar}')
print()
print(f'list written to: {OUT_LIST}')
print(f'stats written to: {OUT_STATS}')
