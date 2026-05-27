# Cars Label Studio Fork — Annotator UX & Audit System

Fork of [HumanSignal/label-studio](https://github.com/HumanSignal/label-studio) for the
**annotate.happyin.space** deployment (Diamant project). Branch: `cars-mods`.

Hosts **3 projects**:
- **Project 7** «Машины ≥15% — финальная проверка» (174,125 car photos verification, Pinterest)
- **Project 8** «SAM3 Jewelry Classes — verify» (28,246 jewelry photos with bbox predictions)
- **Project 9** «SAM3 Stones — verify masks» (20,181 stone photos, bbox + planned mask edit)
- **Project 10** «SAM3 Stones — edit masks» (20,181 photos, BrushLabels with 20k mask predictions)

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

### LSF (labeling editor)
| File | What |
|---|---|
| `web/libs/editor/src/tools/Brush.jsx` | Alt+drag = temp eraser, Ctrl+Alt+drag = cross-layer erase, sticky label (re-select after region commit), `relabelLastDrawnByIndex` action, `forceCommitNewRegion` action, `lastDrawnRegion` tracker (5s TTL), audit hooks |
| `web/libs/editor/src/components/SidePanels/OutlinerPanel/OutlinerTree.tsx` | Per-row delete icon (🗑) between Lock and Visibility, calls `annotation.deleteRegion` |

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

## Deploy pipeline

```bash
# 1. Push code changes (already in cars-mods branch)
# 2. SSH to contabo-us-stlouis-diamant
# 3. Build + container recreate:
ssh contabo-us-stlouis-diamant '
cd /opt/diamant-runpod/label-studio-fork/label-studio &&
docker run --rm -v "$(pwd):/work" -w /work node:22-alpine sh -c "rm -rf web/.nx web/dist" &&
docker run --rm -v "$(pwd):/work" -w /work -e CI=true node:22-alpine sh -c "corepack enable && cd web && yarn ls:build" &&
docker build --no-cache -f Dockerfile.thin -t cars-labelstudio:vNN -t cars-labelstudio:latest . &&
cd /opt/diamant-runpod/label-studio && docker compose up -d --force-recreate ls-backend
'
# 4. Verify: curl https://annotate.happyin.space/ → 302
```

`Dockerfile.thin` overlays `web/dist` on top of `heartexlabs/label-studio:latest`:
```dockerfile
FROM heartexlabs/label-studio:latest
USER 0
COPY --chown=1001:0 web/dist /label-studio/web/dist
USER 1001
```

Compose stack on Contabo: `/opt/diamant-runpod/label-studio/docker-compose.yml`
(ls-backend + postgres + cloudflared + nginx).

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
