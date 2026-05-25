"""restore_ls_ui.py — идемпотентная настройка LS project 6.

Что настраивает:
  - label_config (5 классов × bbox+polygon, цвета)
  - storages: cars-local (clean), cars-thumbs (с впечатанными overlay)
  - 4 grid views (gridWidth=8, hidden cols), grid показывает thumb а editor clean

Запуск (внутри LS-контейнера):
    docker exec <ls-container> python3 /tmp/restore_ls_ui.py

Идемпотентно — можно повторно запускать.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

import os
TOKEN = os.environ.get('LABEL_STUDIO_TOKEN','')
if not TOKEN: raise SystemExit('LABEL_STUDIO_TOKEN not set')
BASE = 'http://localhost:8080'
PID = 6

LABEL_CONFIG = '''<View>
  <Header value="Проверь SAM3-разметку: рамки и маски частей машины. Если фото не машина — Skip (Ctrl+Space). Если ok — Submit (Ctrl+Enter)."/>
  <Image name="image" value="$image" zoom="true" zoomControl="true" rotateControl="false" brightnessControl="false" contrastControl="false"/>
  <View style="display:none">
    <Image name="thumb" value="$thumb"/>
  </View>

  <RectangleLabels name="bbox" toName="image">
    <Label value="car" background="#FF6B00"/>
    <Label value="car window" background="#1FB6FF"/>
    <Label value="car wheel" background="#13CE66"/>
    <Label value="car interior" background="#F4B400"/>
    <Label value="license plate" background="#9013FE"/>
  </RectangleLabels>

  <PolygonLabels name="mask" toName="image">
    <Label value="car" background="#FF6B00"/>
    <Label value="car window" background="#1FB6FF"/>
    <Label value="car wheel" background="#13CE66"/>
    <Label value="car interior" background="#F4B400"/>
    <Label value="license plate" background="#9013FE"/>
  </PolygonLabels>
</View>'''

INTERNAL_COLUMNS = [
    'tasks:data.name', 'tasks:data.id', 'tasks:data.root', 'tasks:data.pin_id',
    'tasks:inner_id', 'tasks:annotations_results', 'tasks:annotations_ids',
    'tasks:predictions_score', 'tasks:predictions_model_versions', 'tasks:predictions_results',
    'tasks:file_upload', 'tasks:storage_filename',
    'tasks:created_at', 'tasks:updated_at', 'tasks:updated_by',
    'tasks:avg_lead_time', 'tasks:draft_exists',
]

# explore (grid): hide data.image -> grid auto-picks data.thumb (с overlay'ями)
HIDDEN_EXPLORE = INTERNAL_COLUMNS + ['tasks:data.image']
# labeling (editor): label_config использует $image, оба image-поля как колонки скрыть
HIDDEN_LABELING = INTERNAL_COLUMNS + ['tasks:data.image', 'tasks:data.thumb']

VIEWS_SPEC = [
    {'title': 'Все 192k', 'filters': None},
    {'title': 'Высокая ≥0.9',
     'filters': [('greater_or_equal', 0.9), ('less', 1.01)]},
    {'title': 'Средняя 0.7-0.9',
     'filters': [('greater_or_equal', 0.7), ('less', 0.9)]},
    {'title': 'Низкая 0.5-0.7 (проверь!)',
     'filters': [('greater_or_equal', 0.5), ('less', 0.7)]},
]

STORAGES_SPEC = [
    {'title': 'cars-local clean', 'path': '/label-studio/files/cars-local'},
    {'title': 'cars-thumbs with overlay', 'path': '/label-studio/files/cars-thumbs'},
]

HDR_AUTH = {'Authorization': f'Token {TOKEN}'}
HDR_JSON = {**HDR_AUTH, 'Content-Type': 'application/json'}


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f'{BASE}{path}', data=data,
        headers=HDR_JSON if data else HDR_AUTH, method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:600]


def build_view_data(spec):
    data = {
        'title': spec['title'],
        'type': 'grid',
        'target': 'tasks',
        'gridWidth': 8,
        'hiddenColumns': {
            'explore': list(HIDDEN_EXPLORE),
            'labeling': list(HIDDEN_LABELING),
        },
    }
    if spec.get('filters'):
        data['filters'] = {
            'conjunction': 'and',
            'items': [
                {'filter': 'filter:tasks:data.car_score',
                 'operator': op, 'value': val, 'type': 'Number'}
                for op, val in spec['filters']
            ],
        }
        data['ordering'] = ['tasks:data.car_score']
    return data


def main():
    print('=== STEP 1: label_config (idempotent PATCH) ===')
    code, _ = api('PATCH', f'/api/projects/{PID}/', {'label_config': LABEL_CONFIG})
    print(f'  status: {code}')

    print('\n=== STEP 2: storages (ensure cars-local + cars-thumbs exist) ===')
    code, existing_storages = api('GET', f'/api/storages/localfiles?project={PID}')
    existing_storages = existing_storages if isinstance(existing_storages, list) else []
    by_path = {s['path']: s for s in existing_storages}
    for spec in STORAGES_SPEC:
        if spec['path'] in by_path:
            print(f"  EXISTS id={by_path[spec['path']]['id']} path={spec['path']}")
            continue
        body = {
            'project': PID, 'path': spec['path'],
            'regex_filter': r'.*\.jpg$',
            'use_blob_urls': True, 'recursive_scan': False,
            'title': spec['title'],
        }
        code, v = api('POST', '/api/storages/localfiles', body)
        new_id = v.get('id') if isinstance(v, dict) else '?'
        print(f"  CREATE id={new_id} path={spec['path']}: {code}")

    print('\n=== STEP 3: enumerate views ===')
    code, existing_views = api('GET', f'/api/dm/views?project={PID}')
    existing_views = existing_views if isinstance(existing_views, list) else []
    print(f'  found {len(existing_views)} existing views')

    wanted_titles = {s['title'] for s in VIEWS_SPEC}
    by_title = {}
    to_delete = []
    for v in existing_views:
        title = v.get('data', {}).get('title', '')
        if title in wanted_titles and title not in by_title:
            by_title[title] = v
        else:
            to_delete.append(v)

    print('\n=== STEP 4: delete unwanted views ===')
    for v in to_delete:
        code, _ = api('DELETE', f'/api/dm/views/{v["id"]}/')
        print(f'  DELETE id={v["id"]} title={v.get("data",{}).get("title")!r}: {code}')

    print('\n=== STEP 5: ensure wanted views with current spec ===')
    for spec in VIEWS_SPEC:
        data = build_view_data(spec)
        title = spec['title']
        if title in by_title:
            vid = by_title[title]['id']
            code, _ = api('PATCH', f'/api/dm/views/{vid}/', {'data': data})
            print(f'  PATCH id={vid} {title!r}: {code}')
        else:
            code, v = api('POST', '/api/dm/views', {'project': PID, 'data': data})
            new_id = v.get('id') if isinstance(v, dict) else '?'
            print(f'  CREATE id={new_id} {title!r}: {code}')

    print('\n=== STEP 6: verify ===')
    code, final = api('GET', f'/api/dm/views?project={PID}')
    if isinstance(final, list):
        for v in final:
            d = v.get('data', {})
            hc = d.get('hiddenColumns', {})
            print(f'  id={v["id"]:>3}  title={d.get("title")!r:<32}  '
                  f'gridWidth={d.get("gridWidth")}  '
                  f'hidden_explore={len(hc.get("explore",[]))}  '
                  f'hidden_labeling={len(hc.get("labeling",[]))}')
    code, storages = api('GET', f'/api/storages/localfiles?project={PID}')
    if isinstance(storages, list):
        for s in storages:
            print(f'  storage id={s["id"]:>2}  path={s["path"]}')


if __name__ == '__main__':
    main()
