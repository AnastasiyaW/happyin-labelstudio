# Reference pipeline — SAM3 detections → Label Studio

Maintainer-specific glue used by **happyin** to turn SAM3 detections into Label Studio tasks +
predictions and to deploy this fork. Published as a working **example** — paths, hostnames and
project ids below are from our deployment; adapt them to your environment. The reusable UX lives
in the fork itself (see [../HAPPYIN-FORK.md](../HAPPYIN-FORK.md)); this directory is optional.

## Структура

```
cars/
  deployment/
    docker-compose.yml      # стек на contabo-us-stlouis-diamant
  nginx-overlay/
    nginx.conf              # reverse proxy + script injection
    static/
      overlay.js            # custom JS, модификатор LS UI
  scripts/
    drive_common.py         # Drive auth helper
    reorganize.py           # Drive metadata moves per SAM3 verdicts
    merge_predictions.py    # SAM3 detections → LS predictions (RLE→polygon)
    generate_thumbs.py      # rendered bbox+masks JPEG thumbs (5 colors, alpha 0.35)
    import_ls_tasks.py      # bulk import via LS API
    restore_ls_ui.py        # idempotent label_config + storages + views
    filter_15pct.py         # filter tasks где car-class ≥15% площади кадра
    prepare_after_sync.sh
```

## Frontend modifications (TODO)

Изменения LS frontend происходят в:
- `web/libs/datamanager/src/components/MainView/GridView/GridView.jsx` — 3-режим density toggle (small/large/list)
- `web/libs/datamanager/src/components/DataManager/Toolbar/Toolbar.jsx` — custom controls
- `web/libs/datamanager/src/components/Common/Card.jsx` — click=toggle skip, Edit/Edit Lite buttons

После правок: `cd web && yarn ls:build` → build:production → новый docker image.

## Build custom Docker image

```bash
docker build -t happyin-labelstudio:latest .
```

## Deploy (example)

```bash
ssh <your-server>
cd <deploy-dir>
# In docker-compose set image: heartexlabs/label-studio:latest → happyin-labelstudio:latest
docker compose up -d ls-backend
```

Full self-host walkthrough: [../SELF-HOST.md](../SELF-HOST.md).

## Status (2026-05-25)

- ✅ Stack deployed (ls-backend + nginx-overlay + postgres + cloudflared)
- ✅ 192,333 tasks с predictions+thumbs (98.6% coverage)
- ✅ 5 классов SAM3: car / car window / car wheel / car interior / license plate
- ✅ Filter `>=15% car body`: 174,125 файлов → копируются на Drive в `gdrive-diamant:diamant-data/cars-filter/copies-car-body-15pct/`
- ⏳ Frontend forks для click=toggle, density toggle, Lite mask editor (этот branch)
