"""import_ls_tasks.py — батчевый импорт ls_tasks.jsonl в Label Studio project 6.

Запускается на Contabo (LS API на localhost:8080). Token из env.

  LABEL_STUDIO_TOKEN=... python3 import_ls_tasks.py --project 6 \
      --input /opt/diamant-runpod/cars-filter/ls_tasks.jsonl
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

LS = os.environ.get("LABEL_STUDIO_URL", "http://127.0.0.1:8080")
TOKEN = os.environ.get("LABEL_STUDIO_TOKEN", "")
BATCH = 1000  # tasks per import POST (LS handles ~5k без проблем, 1k безопаснее)


def post(path: str, body: list | dict) -> dict:
    req = urllib.request.Request(
        f"{LS}{path}",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Token {TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read() or b"{}")


def get(path: str) -> dict:
    req = urllib.request.Request(
        f"{LS}{path}", headers={"Authorization": f"Token {TOKEN}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def main() -> None:
    if not TOKEN:
        sys.exit("ERROR: LABEL_STUDIO_TOKEN не задан")

    ap = argparse.ArgumentParser()
    ap.add_argument("--project", type=int, required=True)
    ap.add_argument("--input", required=True)
    ap.add_argument("--batch", type=int, default=BATCH)
    ap.add_argument("--resume-from", type=int, default=0,
                    help="пропустить первые N строк (re-run после ошибки)")
    args = ap.parse_args()

    p = Path(args.input)
    if not p.exists():
        sys.exit(f"ERROR: нет {p}")

    # verify project
    proj = get(f"/api/projects/{args.project}/")
    print(f"project {args.project}: '{proj.get('title', '?')}'  "
          f"current task_count={proj.get('task_number', '?')}")

    # stream + batch
    batch: list[dict] = []
    n_sent = n_imported = n_lines = 0
    t0 = time.time()
    with p.open(encoding="utf-8") as f:
        for line in f:
            n_lines += 1
            if n_lines <= args.resume_from:
                continue
            try:
                task = json.loads(line)
            except json.JSONDecodeError:
                continue
            batch.append(task)  # full task incl predictions/annotations
            if len(batch) >= args.batch:
                resp = post(f"/api/projects/{args.project}/import", batch)
                cnt = int(resp.get("task_count", len(batch)))
                n_imported += cnt
                n_sent += len(batch)
                batch = []
                if n_sent % 10000 == 0:
                    dt = time.time() - t0
                    rate = n_sent / dt if dt else 0
                    eta_min = (192333 - n_sent) / rate / 60 if rate else 0
                    print(f"  sent {n_sent:,}  imported {n_imported:,}  "
                          f"rate {rate:.0f}/s  ETA {eta_min:.0f}m")
    if batch:
        resp = post(f"/api/projects/{args.project}/import", batch)
        n_imported += int(resp.get("task_count", len(batch)))
        n_sent += len(batch)

    print(f"\nDONE: sent {n_sent:,}  imported {n_imported:,}  in {time.time()-t0:.0f}s")
    proj = get(f"/api/projects/{args.project}/")
    print(f"  project task_count now: {proj.get('task_number')}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
