#!/bin/bash
# Подготовлен 2026-05-24: rewrite JSONL paths + replace storage. Запускать ПОСЛЕ SYNC_ALL_DONE.
set -e

JSONL=/opt/diamant-runpod/cars-filter/ls_tasks.jsonl
BACKUP=/opt/diamant-runpod/cars-filter/ls_tasks.jsonl.backup_cars-mount
TOKEN="${LABEL_STUDIO_TOKEN:?missing}"

echo === STEP 10: backup + rewrite JSONL ===
cp -v $JSONL $BACKUP
sed -i 's|cars-mount/|cars-local/|g' $JSONL
echo cars-local count after sed:
grep -c 'cars-local/' $JSONL
echo cars-mount remnants:
grep -c 'cars-mount/' $JSONL || true
echo first 2 lines:
head -2 $JSONL

echo
echo === STEP 11: DELETE storage id=6 cars-mount ===
docker exec diamant-labelstudio-label-studio-1 bash -lc   'curl -sS -X DELETE -H "Authorization: Token '$TOKEN'" http://localhost:8080/api/storages/localfiles/6 -w "\nHTTP=%{http_code}\n"'

echo
echo === STEP 11b: CREATE storage cars-local ===
cat > /tmp/create_local_storage.py <<PYEOF
import json, urllib.request, urllib.error
TOKEN = '$TOKEN'
body = {
    'project': 6,
    'path': '/label-studio/files/cars-local',
    'regex_filter': r'.*\.jpg$',
    'use_blob_urls': True,
    'recursive_scan': False,
    'title': 'cars local sync (post-rclone)',
}
req = urllib.request.Request(
    'http://localhost:8080/api/storages/localfiles',
    data=json.dumps(body).encode(),
    headers={'Authorization': f'Token {TOKEN}', 'Content-Type': 'application/json'},
    method='POST',
)
try:
    with urllib.request.urlopen(req) as r:
        print('status', r.status)
        print(r.read().decode())
except urllib.error.HTTPError as e:
    print('HTTPError', e.code)
    print(e.read().decode())
PYEOF
docker cp /tmp/create_local_storage.py diamant-labelstudio-label-studio-1:/tmp/create_local_storage.py
docker exec diamant-labelstudio-label-studio-1 python3 /tmp/create_local_storage.py

echo
echo === STEP 12: one-file serve check ===
head -1 $JSONL > /tmp/one_task.jsonl
docker cp /tmp/one_task.jsonl diamant-labelstudio-label-studio-1:/tmp/one_task.jsonl
docker cp /opt/diamant-runpod/label-studio/files/setup_unified.py diamant-labelstudio-label-studio-1:/tmp/none.py 2>/dev/null || true
cat > /tmp/serve_one.py <<PYEOF
import json, time, urllib.parse, urllib.request, urllib.error
TOKEN = '$TOKEN'
with open('/tmp/one_task.jsonl', encoding='utf-8') as f:
    image_url = json.loads(f.readline())['data']['image']
qs = image_url.split('?d=', 1)[1]
encoded = urllib.parse.quote(qs, safe='')
full = f'http://localhost:8080/data/local-files/?d={encoded}'
t0 = time.time()
req = urllib.request.Request(full, headers={'Authorization': f'Token {TOKEN}'})
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        bytes_read = len(r.read())
        dt = time.time() - t0
        print(f'OK status={r.status} bytes={bytes_read} time_ms={dt*1000:.0f} path={qs}')
except urllib.error.HTTPError as e:
    print(f'FAIL status={e.code} body={e.read()[:200].decode(errors=chr(114)+chr(101)+chr(112)+chr(108)+chr(97)+chr(99)+chr(101))} path={qs}')
PYEOF
docker cp /tmp/serve_one.py diamant-labelstudio-label-studio-1:/tmp/serve_one.py
docker exec diamant-labelstudio-label-studio-1 python3 /tmp/serve_one.py

echo
echo === ALL POST-SYNC PREP DONE ===
echo Next: run bulk import:
echo "  LABEL_STUDIO_TOKEN=$TOKEN nohup python3 /opt/diamant-runpod/cars-filter/import_ls_tasks.py --project 6 --input $JSONL > /var/log/ls_import.log 2>&1 &"
