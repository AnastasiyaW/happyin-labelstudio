# happyin Label Studio Fork — Annotator UX & Audit System

A fork of [HumanSignal/label-studio](https://github.com/HumanSignal/label-studio) that adds a
**high-throughput verification/annotation UX** for large image datasets: a fast grid view with
reject-toggle, collapsible "processed" folder strips, per-card hotkeys, a Photoshop-style brush
for mask editing, multi-annotator claim/release, an IndexedDB image cache, and a per-view JSONB
**audit log** of every annotator action.

Built and run in production by **happyin** for verifying SAM3 detections on Pinterest-scale
photo sets (cars, jewelry, stones). It is published so anyone can self-host the same UX on their
own Label Studio data.

- **Active branch:** `cars-mods` (the default branch; clone this to get the mods).
- **Self-host & secret safety:** see [SELF-HOST.md](SELF-HOST.md). Never commit a real `.env` —
  a `gitleaks` pre-commit hook (`.gitleaks.toml` + `.pre-commit-config.yaml`) blocks accidental
  secret commits.
- The `cars/` directory is **our reference deployment glue** (SAM3→Label-Studio pipeline,
  Contabo/Cloudflare-Tunnel compose). Treat its hardcoded paths/hostnames as examples and adapt
  them to your environment.

> Naming note: several code identifiers and DB JSONB fields are still prefixed `cars_*`
> (`cars_folders`, `cars_audit_log`, `CarsClaimAPI`, …). These are kept as-is so existing
> deployments and stored data keep working; they are internal names, not anything you must match.

---

## What's modified vs upstream

### DataManager (grid view)
| File | What |
|---|---|
| `web/libs/datamanager/src/components/MainView/GridView/GridView.jsx` | Most cars-mods: VerifBar (toggle reject mode), folder strips (collapse "processed" ranges), darkness slider, chromeless mode, hotkeys help panel, ColumnsDropdown (labels visibility), `📁↑` per-card folder button, bucketed body (image + chips + text), force-include Image col |
| `web/libs/datamanager/src/components/MainView/GridView/GridView.prefix.css` | Styles for verif bar, folder strips, chips, chromeless overrides, darkness slider, hotkeys panel, edit button |
| `web/libs/datamanager/src/components/MainView/GridView/GridPreview.tsx` | Edit button in preview modal, layout-agnostic E hotkey, audit hooks |
| `web/libs/datamanager/src/components/MainView/GridView/GridPreview.module.css` | Edit button styles |
| `web/libs/datamanager/src/components/MainView/DataView/Table.jsx` | Reorder columns (image first in labeling pane), apply cars_folders filter at DataView level (works for both list+grid types), CARS-LOG diagnostic console output |
| `web/libs/datamanager/src/components/Common/Table/Table.jsx` | Insert checkbox column AFTER image when image is first (per-user reorder) |
| `web/libs/datamanager/src/components/Label/Label.jsx` | Arrow nav ↑/↓ in labeling pane, brush hotkeys (Space/X/digit/Delete), CarsAddLabelButton, central audit listener |
| `web/libs/datamanager/src/components/Label/Label.prefix.css` | CarsAddLabelButton styles |
| `web/libs/datamanager/src/stores/Tabs/tab.js` | Added MST fields: `cars_folders` (folder strip state), `cars_audit_log` (action log). New actions: `setCarsFolders`, `carsAuditAppend` |
| `web/libs/datamanager/src/stores/DataStores/tasks.js` | Declare `meta: types.frozen()` on TaskModelBase so `row.meta` survives the MST snapshot (claim/processed state + `cars_pred_coverage`). Without it MST silently drops the undeclared key |

### Pre-annotation coverage (big/small sections)
| File | What |
|---|---|
| `label_studio/data_manager/cars_coverage.py` | Pure helper: max single-region coverage (fraction 0..1) of a prediction `result`. Handles `rectanglelabels` (w·h), `polygonlabels` (shoelace), `brushlabels` (LS RLE decode). Project-agnostic |
| `label_studio/tasks/management/commands/cars_backfill_pred_coverage.py` | One-time/idempotent backfill: writes `Task.data['pred_coverage']` (float 0..1) per project **and registers the `pred_coverage` DM column** on the project summary (so it shows + filters/sorts). `--dry-run` prints the distribution histogram; `--only-missing` for post-import top-ups |
| `label_studio/data_manager/api.py` · `CarsBulkAcceptAPI` | `POST /api/dm/tasks/bulk-accept/` `{project, min_coverage, dry_run}` — creates one annotation from each task's latest prediction for ALL project tasks with coverage ≥ min_coverage. Recomputes coverage server-side; skips already-annotated; `dry_run` returns counts only |
| `label_studio/data_manager/urls.py` · `sdk/api-config.js` | Route + `carsBulkAccept` client endpoint |
| `web/libs/datamanager/src/components/MainView/GridView/GridView.jsx` | Defines+exports `CovSectionBar` (threshold input + `[Все\|Крупные ≥N%\|Мелкие]` + `✓ Принять все крупные`) and `hasCovColumn`. Buttons set a NATIVE server-side filter on the `pred_coverage` column (column type → Number for numeric cast); active mode derived from the view's filters. Per-card coverage badge reads `data.pred_coverage`. Threshold per-(user,project) in localStorage |
| `web/libs/datamanager/src/components/MainView/DataView/Table.jsx` | Renders `<CovSectionBar>` above BOTH list and grid (when `hasCovColumn(view)`), so the coverage bar works in either view type |
| `web/libs/datamanager/src/components/MainView/GridView/GridView.prefix.css` | Styles for `cov-bar`, threshold input, mode switch, bulk-accept button, big-coverage cell outline + badge |

### LSF (labeling editor)
| File | What |
|---|---|
| `web/libs/editor/src/tools/Brush.jsx` | Alt+drag = temp eraser, Ctrl+Alt+drag = cross-layer erase, sticky label (re-select after region commit), `relabelLastDrawnByIndex` action, `forceCommitNewRegion` action, `lastDrawnRegion` tracker (5s TTL), audit hooks |
| `web/libs/editor/src/components/SidePanels/OutlinerPanel/OutlinerTree.tsx` | Per-row delete icon (🗑) between Lock and Visibility, calls `annotation.deleteRegion` |
| `web/libs/editor/src/tags/control/Choice.jsx` | Fast-verify: picking a verdict by HOTKEY auto-submits the annotation (one key instead of key + Ctrl+Enter). Scoped to a `Choices` control **named `verdict`** (hotkey path only, not clicks) so normal/multi-step labeling is unaffected. Mirrors the BottomBar submit/update decision. Stops verification verdicts piling up as un-submitted drafts |

---

## Audit log

All annotator actions log to `data_manager_view.data.cars_audit_log` (JSONB array, capped at 500
entries, rotates oldest).

**Query last actions of a specific user:**
```sql
SELECT jsonb_pretty(elem)
FROM data_manager_view,
     jsonb_array_elements(data->'cars_audit_log') elem
WHERE id = 28
  AND elem->>'userId' = '22'  -- Natasha = 22
ORDER BY (elem->>'ts')::bigint DESC
LIMIT 50;
```

**Action namespaces:**
- `verif.toggle` — Verif ON/OFF (enabled bool)
- `verif.reject` — task rejected (taskId)
- `verif.restore` — task un-rejected (taskId, deletedCount)
- `verif.error` — rejection API failed (taskId, error)
- `folder.add` — new folder created (taskId = cutoff anchor)
- `folder.toggle` — folder expanded/collapsed (taskId, newExpanded)
- `folders.clear` — wipe all folders (count)
- `ui.darkness` — rejected card opacity (0-100)
- `ui.chromeless` — minimalist mode (enabled)
- `ui.grid-size` — grid column count change (cols)
- `preview.next` / `preview.prev` — preview navigation (taskId)
- `preview.select` — checkbox toggle in preview (taskId)
- `preview.close` — close preview modal
- `preview.open-editor` — switch to full LSF editor (taskId)
- `editor.arrow-nav` — task switch via ↑/↓ in labeling pane (direction, from/toTaskId)
- `hotkey.space-new-region` — Space pressed → commit + deselect
- `hotkey.swap-tool` — X pressed → brush ↔ eraser (toEraser bool)
- `hotkey.digit-relabel` — digit 1-9 → relabel last drawn (idx)
- `hotkey.delete-regions` — Delete/Backspace → remove selected regions (count)
- `brush.alt-erase-start` — Alt+drag eraser stroke begins (regionId)
- `brush.cross-erase-start` — Ctrl+Alt+drag cross-layer eraser (hitCount)
- `brush.continue-stroke` — additional stroke on existing region (regionId)
- `brush.new-region-start` — first stroke of a new region
- `region.delete-icon` — region removed via 🗑 icon in Regions panel (regionId)
- `cov.threshold` — coverage threshold changed (value, 0-100)
- `cov.mode` — coverage view mode switched (mode: all/big/small)
- `cov.bulk-accept` — bulk-accepted big pre-annotations (min_coverage, accepted count)

Each entry: `{action, userId, ts, ...payload}`. `userId` matches `htx_user.id`.

---

## Hotkeys reference

Reflected in the **⌨ Hotkeys** panel (verif bar) in the UI. Layout-agnostic (RU/EN).

### Grid view
- `Click` — Verif ON: toggle reject • Verif OFF: open preview
- `📁↑` — create folder cutoff at this card

### Preview modal
- `← / →` — navigate prev/next task
- `Space` — toggle task checkbox
- `Esc` — close preview
- `E` / `Enter` — open full editor (event.code === "KeyE" → layout-agnostic)

### Labeling editor (per-row Table on left)
- `↑ / ↓` — focus prev/next task (calls `dataStore.focusPrev/Next` + `startLabeling`)
- `Shift+↑/↓` — LSF region nudge (default LS behavior — reserved)

### Brush tool (project 10 masks)
- `Alt+drag` — temporary eraser (Photoshop-style)
- `Ctrl+Alt+drag` — cross-layer eraser (erases all overlapping regions at cursor)
- `Space` — finalize current draw + deselect → next stroke = new region
- `X` — swap Brush ↔ Eraser active tool
- `1-9` — relabel last drawn region (5s window after mouseup)
- `Delete` / `Backspace` — delete selected region(s)

---

## Folder system (`cars_folders`)

Per-(user, project, view) scoped folder strips that visually collapse processed-task ranges.

**Schema** (`view.data.cars_folders` JSONB array):
```json
[
  {
    "taskId": 882046,        // anchor task — everything visually "above" is hidden
    "ts": 1779880349901,     // creation timestamp (ms since epoch)
    "expanded": false,       // user toggled visible
    "userId": "22"           // creator (htx_user.id as string) — for filter isolation
  }
]
```

**Filter** (applied in `MainView/DataView/Table.jsx`):
- Detect sort direction by comparing `data[0].id` vs `data[last].id`
- `cutoffId = Math.max(...collapsedFolders.taskId)` (only my folders, only collapsed)
- ASC sort: `data.filter(t => t.id >= cutoffId)` (hide ids < cutoff = visually above)
- DESC sort: `data.filter(t => t.id <= cutoffId)` (hide ids > cutoff)

Works with lazy-loaded data because uses id comparison, not array index.

**Per-user isolation** (`getFolders(view)`):
```js
arr.filter(f => f && (!f.userId || String(f.userId) === String(currentUserId())))
```
Legacy entries without `userId` visible to all (backward compat).

---

## Pre-annotation coverage (`pred_coverage`)

Lets an annotator split tasks whose **biggest pre-annotation fills ≥ N% of the photo** (default
70% — whole-frame detections / whole-image false positives) from the small ones, and stamp a
verdict on the big set at once. Works for any project type — coverage is computed geometrically
from the prediction `result` (`rectanglelabels` → w·h, `polygonlabels` → shoelace, `brushlabels`
→ RLE pixel count), so it is class- and project-agnostic.

**Coverage is a real DM column (`task.data.pred_coverage`).** The DataManager list endpoint drops
full `predictions` unless `?fields=all` (heavy at scale), `predictions_results` is a truncated,
quote-stripped string, and a lazy-loaded view can't filter a task it hasn't loaded. So coverage is
precomputed into `Task.data['pred_coverage']` (a stock JSONField) and **registered as a DM column**
on the project summary (`all_data_columns`). That makes it a first-class, server-side
filterable + sortable column — so "Крупные" returns *all* matching tasks across the project, in
both the list and grid, and native `Filters` / `Order by` on `pred_coverage` work too. (Trade-off:
the value appears in exports — a harmless numeric field. `Task.meta` is read as a fallback for
backward compat but `meta` is not natively filterable.)

**Backfill + column registration** (run on the LS host, in the venv/container, per project):
```bash
# dry-run: coverage distribution + how many tasks are ≥70%
python label_studio/manage.py cars_backfill_pred_coverage --project <PROJECT_ID> --dry-run
# commit: writes task.data.pred_coverage AND registers the pred_coverage column
python label_studio/manage.py cars_backfill_pred_coverage --project <PROJECT_ID>
# after a later re-import, only fill new tasks
python label_studio/manage.py cars_backfill_pred_coverage --project <PROJECT_ID> --only-missing
```
Re-run per project to enable the bar there. New imports need a `--only-missing` pass (or a full
re-run) so freshly imported predictions get a coverage value + stay registered.

**UI:** a `📐 Размер преданнотации` bar appears above the data (BOTH list and grid) for any project
that has the `pred_coverage` column. Set the threshold, then `[Все | Крупные ≥N% | Мелкие]` — the
buttons set a native server-side filter on `pred_coverage` (column type → Number), so "Крупные"
shows every big task in the project. In the grid, each card also carries a `⛶ NN%` badge (amber for
big, muted for small) and big cards get an amber outline.

**Bulk accept:** the `✓ Принять все крупные ≥N%` button accepts the pre-annotation for **every task
in the project** with coverage ≥ threshold (not just loaded cards) — it creates one annotation from
each task's latest SAM3 prediction. It dry-runs first to show an accurate count, asks for
confirmation, then commits; already-annotated tasks are skipped (idempotent), and it only creates
annotations (no deletes). Backed by `CarsBulkAcceptAPI`, which recomputes coverage server-side so
the result is correct regardless of backfill state.

## Deploy pipeline

Replace `<your-server>`, `<repo-dir>`, and the image name with your own. We use the
`Dockerfile.thin` overlay (≈3 min rebuild) — it only re-bundles the frontend on top of the
upstream image, so Python/Django/venv stay from `heartexlabs/label-studio:latest`.

```bash
# 1. Push code changes (already on the cars-mods branch)
# 2. SSH to your build host, then build + recreate the container:
ssh <your-server> '
cd <repo-dir> &&
docker run --rm -v "$(pwd):/work" -w /work node:22-alpine sh -c "rm -rf web/.nx web/dist" &&
docker run --rm -v "$(pwd):/work" -w /work -e CI=true node:22-alpine sh -c "corepack enable && cd web && yarn ls:build" &&
docker build --no-cache -f Dockerfile.thin -t happyin-labelstudio:vNN -t happyin-labelstudio:latest . &&
cd <deploy-dir> && docker compose up -d --force-recreate ls-backend
'
# 3. Verify: curl https://<your-domain>/ → 302
```

`Dockerfile.thin` overlays `web/dist` on top of `heartexlabs/label-studio:latest`:
```dockerfile
FROM heartexlabs/label-studio:latest
USER 0
COPY --chown=1001:0 web/dist /label-studio/web/dist
USER 1001
```

The compose stack (ls-backend + postgres + cloudflared + nginx) lives in
[`cars/deployment/docker-compose.yml`](cars/deployment/docker-compose.yml); copy it next to a
filled-in `.env` (see [`cars/deployment/.env.example`](cars/deployment/.env.example)).

---

## Diagnostic queries

**Folder state for a specific view:**
```sql
SELECT jsonb_pretty(data->'cars_folders')
FROM data_manager_view
WHERE id = 28;
```

**Audit log filtered by user (Natasha = 22):**
```sql
SELECT to_timestamp((elem->>'ts')::bigint / 1000)::timestamptz as when,
       elem->>'action' as action,
       elem - 'action' - 'userId' - 'ts' as payload
FROM data_manager_view, jsonb_array_elements(data->'cars_audit_log') elem
WHERE id = 28 AND elem->>'userId' = '22'
ORDER BY (elem->>'ts')::bigint DESC LIMIT 100;
```

**Per-user verdict counts (uses LS-native `task_completion`):**
```sql
SELECT t.project_id, tc.completed_by_id,
       COUNT(*) FILTER (WHERE tc.was_cancelled) as rejected,
       COUNT(*) FILTER (WHERE NOT tc.was_cancelled) as accepted,
       MAX(t.id) as max_task_id, MAX(tc.created_at) as last_activity
FROM task_completion tc
JOIN task t ON tc.task_id = t.id
WHERE t.project_id IN (6, 7, 8, 9, 10)
GROUP BY t.project_id, tc.completed_by_id
ORDER BY t.project_id, last_activity DESC;
```

---

## Version history (key versions)

- **v23** (initial bundle): folder buttons, verif toggle, reject styling
- **v25**: ColumnsDropdown via `col.original.toggleVisibility` (MST identity fix)
- **v26**: folder toggle (collapsed/expanded), reset button, timestamps
- **v27-v30**: lazy-loading + useMemo stale-proxy fixes, gap-fill loadMore
- **v31**: bucketed body (image fills cell, numeric chips, text rows)
- **v32**: Edit button in preview, E/Enter hotkey
- **v33**: LSF per-region delete icon, darkness slider, chromeless mode
- **v35**: image column first in labeling pane Table
- **v36**: checkbox after image, ⌨ Hotkeys help panel, layout-agnostic E
- **v37**: brush Photoshop hotkeys (Alt-erase, Ctrl+Alt cross, Space, X, digit relabel)
- **v38**: server-side `cars_folders` via Tab MST field (replaces localStorage)
- **v39**: per-user folder filtering (`userId` tag in each entry)
- **v40**: id-comparison folder filter (fixes lazy-loaded data), CarsAddLabelButton, Delete key, sticky brush label, `cars_audit_log` field
- **v41**: filter at DataView level (works for both list + grid view types)
- **v42**: comprehensive audit logging (~20 action types), central `carsAudit` helper via CustomEvent, README documentation

---

## License & attribution

This is a fork of [HumanSignal/label-studio](https://github.com/HumanSignal/label-studio), licensed
under the **Apache License 2.0** (© Heartex/HumanSignal). The original [`LICENSE`](LICENSE) and
[`NOTICE`](NOTICE) are retained unchanged. Per Apache-2.0 §4(b), the modifications this fork makes are
stated above ("What's modified vs upstream"). "Label Studio" is a trademark of HumanSignal; this fork
is independent and not endorsed by them (Apache-2.0 grants no trademark rights, §6). The fork's own
additions are released under the same Apache-2.0 license.
