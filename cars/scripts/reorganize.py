"""reorganize.py — переразбить cars/<folder> на новую схему.

Старая схема (apply_moves): корень = машины, подпапка _no_car/ = брак.
Новая схема (этот скрипт), 3 фазы:
  - Фаза A: вернуть всё из _no_car/ (старая схема apply_moves) в корень.
  - Фаза B: keep-фото -> подпапку "машины" (SAM3 распознал машину).
  - Фаза C: move-фото -> подпапку "не машины" (SAM3-брак).
Итог: машины/ = машины, "не машины"/ = брак, корень = непросмотренное
(прилетевшее после снимка манифеста). Распознана не вся папка — поэтому
явные корзины, а не «корень = машины».

Перенос через Drive API (addParents/removeParents) — метаданные, контент не
перезаливается. Resumable: id успешно перенесённых пишутся в reorganize_*.log.

    python reorganize.py --folder images               # все фазы a,b,c
    python reorganize.py --folder images --phase c      # только move -> не машины
    python reorganize.py --folder images --dry-run
"""
from __future__ import annotations

import argparse
import csv
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from googleapiclient.discovery import build

from drive_common import drive_service, load_creds, resolve_folder

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent
VERDICTS = ROOT / "verdicts.csv"
CARS_FOLDER = "машины"
NOT_CARS_FOLDER = "не машины"
REJECT_FOLDER = "_no_car"
WORKERS = 8

_local = threading.local()


def thread_svc():
    """Свой Drive-клиент на поток — googleapiclient service не потокобезопасен."""
    if not hasattr(_local, "svc"):
        _local.svc = build("drive", "v3", credentials=load_creds(),
                            cache_discovery=False)
    return _local.svc


def find_subfolder(svc, parent_id: str, name: str, create: bool) -> str | None:
    """Найти подпапку name в parent_id. create=True — создать, если нет."""
    safe = name.replace("\\", "\\\\").replace("'", "\\'")
    q = (f"'{parent_id}' in parents and name = '{safe}' and "
         "mimeType = 'application/vnd.google-apps.folder' and trashed = false")
    found = (svc.files().list(q=q, fields="files(id)", pageSize=2)
             .execute(num_retries=5).get("files", []))
    if found:
        return found[0]["id"]
    if not create:
        return None
    meta = {"name": name, "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id]}
    return svc.files().create(body=meta, fields="id").execute(num_retries=5)["id"]


def list_children(svc, parent_id: str) -> list[str]:
    """id всех файлов (не папок) в parent_id."""
    ids: list[str] = []
    token = None
    while True:
        resp = svc.files().list(
            q=(f"'{parent_id}' in parents and trashed = false and "
               "mimeType != 'application/vnd.google-apps.folder'"),
            fields="nextPageToken, files(id)", pageSize=1000, pageToken=token,
        ).execute(num_retries=5)
        ids += [f["id"] for f in resp.get("files", [])]
        token = resp.get("nextPageToken")
        if not token:
            break
    return ids


def move_one(file_id: str, src_id: str, dst_id: str) -> tuple[str, str]:
    """Перенести файл src_id -> dst_id."""
    try:
        thread_svc().files().update(
            fileId=file_id, addParents=dst_id, removeParents=src_id, fields="id",
        ).execute(num_retries=5)
        return file_id, "ok"
    except Exception as exc:
        return file_id, f"error:{exc.__class__.__name__}"


def run_phase(name: str, log_path: Path, jobs: list[tuple[str, str, str]]) -> dict:
    """jobs = [(file_id, src_id, dst_id)]. Resumable через log_path."""
    done = set()
    if log_path.exists():
        done = set(log_path.read_text(encoding="utf-8").split())
    pending = [j for j in jobs if j[0] not in done]
    print(f"[{name}] всего {len(jobs)}, уже {len(done)}, к переносу {len(pending)}",
          flush=True)
    counts: dict[str, int] = {}
    n = 0
    with log_path.open("a", encoding="utf-8") as log, \
            ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(move_one, *j) for j in pending]
        for fut in as_completed(futures):
            fid, status = fut.result()
            key = "ok" if status == "ok" else "error"
            counts[key] = counts.get(key, 0) + 1
            if status == "ok":
                log.write(fid + "\n")
            n += 1
            if n % 500 == 0 or n == len(pending):
                log.flush()
                print(f"[{name}] {n}/{len(pending)}  {counts}", flush=True)
    print(f"[{name}] готово  итог={counts}", flush=True)
    return counts


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--folder", default="images", help="папка cars/ (images / images2)")
    ap.add_argument("--phase", default="abc",
                    help="фазы: a (_no_car->корень) b (keep->машины) c (move->не машины)")
    ap.add_argument("--verdicts", default=str(VERDICTS), help="путь к verdicts.csv")
    ap.add_argument("--dry-run", action="store_true", help="только посчитать")
    args = ap.parse_args()
    phases = args.phase.lower()
    verdicts = Path(args.verdicts)

    if not verdicts.exists():
        sys.exit(f"[reorg] нет {verdicts}")
    with verdicts.open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    keep = [r["id"] for r in rows if r["verdict"] == "keep"]
    move = [r["id"] for r in rows if r["verdict"] == "move"]
    log_dir = verdicts.parent

    svc = drive_service()
    images_path = ["pinterest-scrape-backup", "cars", args.folder]
    images_id = resolve_folder(svc, images_path)
    print(f"[reorg] {'/'.join(images_path)} -> {images_id}  фазы={phases}", flush=True)

    no_car_id = (find_subfolder(svc, images_id, REJECT_FOLDER, create=False)
                 if "a" in phases else None)
    back = list_children(svc, no_car_id) if no_car_id else []
    if "a" in phases:
        print(f"[reorg] A: {REJECT_FOLDER}/ -> корень — {len(back)}", flush=True)
    if "b" in phases:
        print(f"[reorg] B: keep -> {CARS_FOLDER}/ — {len(keep)}", flush=True)
    if "c" in phases:
        print(f"[reorg] C: move -> {NOT_CARS_FOLDER}/ — {len(move)}", flush=True)

    if args.dry_run:
        print("[reorg] dry-run — переносы не выполнялись")
        return

    # Фаза A — _no_car/ -> корень
    if "a" in phases and back:
        run_phase("A-возврат", log_dir / f"reorganize_A_{args.folder}.log",
                  [(fid, no_car_id, images_id) for fid in back])
        if not list_children(svc, no_car_id):
            svc.files().update(fileId=no_car_id, body={"trashed": True}).execute(num_retries=5)
            print(f"[reorg] пустую {REJECT_FOLDER}/ — в корзину", flush=True)

    # Фаза B — keep -> машины/
    if "b" in phases:
        cars_id = find_subfolder(svc, images_id, CARS_FOLDER, create=True)
        run_phase("B-машины", log_dir / f"reorganize_B_{args.folder}.log",
                  [(fid, images_id, cars_id) for fid in keep])

    # Фаза C — move -> не машины/
    if "c" in phases:
        not_cars_id = find_subfolder(svc, images_id, NOT_CARS_FOLDER, create=True)
        run_phase("C-не_машины", log_dir / f"reorganize_C_{args.folder}.log",
                  [(fid, images_id, not_cars_id) for fid in move])

    print("[reorg] ГОТОВО", flush=True)


if __name__ == "__main__":
    main()
