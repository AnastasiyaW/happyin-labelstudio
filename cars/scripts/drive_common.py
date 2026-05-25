"""drive_common.py — доступ к Google Drive API через OAuth-токен rclone-remote gdrive.

У rclone-remote `gdrive:` собственные client_id/client_secret и scope=drive,
поэтому Credentials умеют сами обновлять access_token.
"""
from __future__ import annotations

import json
import os
import subprocess

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

DRIVE_SCOPE = "https://www.googleapis.com/auth/drive"
# имя rclone-remote: локально "gdrive", на Contabo "gdrive-diamant" — через env
RCLONE_REMOTE = os.environ.get("RCLONE_REMOTE", "gdrive")


def load_creds() -> Credentials:
    """Собрать креды Drive API из конфига rclone-remote gdrive."""
    dump = subprocess.run(
        ["rclone", "config", "dump"],
        capture_output=True, text=True, check=True,
    ).stdout
    remote = json.loads(dump)[RCLONE_REMOTE]
    token = json.loads(remote["token"])
    return Credentials(
        token=token.get("access_token"),
        refresh_token=token.get("refresh_token"),
        client_id=remote["client_id"],
        client_secret=remote["client_secret"],
        token_uri="https://oauth2.googleapis.com/token",
        scopes=[DRIVE_SCOPE],
    )


def drive_service():
    """Готовый клиент Drive API v3."""
    return build("drive", "v3", credentials=load_creds(), cache_discovery=False)


def resolve_folder(svc, path: list[str]) -> str:
    """Пройти путь папок от корня My Drive, вернуть id последней папки."""
    parent = "root"
    for name in path:
        # имя может содержать апостроф — экранируем для query-языка Drive
        safe = name.replace("\\", "\\\\").replace("'", "\\'")
        q = (
            f"'{parent}' in parents and name = '{safe}' and "
            "mimeType = 'application/vnd.google-apps.folder' and trashed = false"
        )
        files = (
            svc.files()
            .list(q=q, fields="files(id,name)", pageSize=2)
            .execute(num_retries=5)
            .get("files", [])
        )
        if not files:
            raise FileNotFoundError(f"папка не найдена: {name}")
        parent = files[0]["id"]
    return parent
