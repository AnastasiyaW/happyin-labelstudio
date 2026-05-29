import { observer } from "mobx-react";
import { getRoot } from "mobx-state-tree";
import { useCallback, useContext, useMemo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import AutoSizer from "react-virtualized-auto-sizer";
import { FixedSizeGrid } from "react-window";
import InfiniteLoader from "react-window-infinite-loader";
import { cn } from "../../../utils/bem";
import { Checkbox, cnm } from "@humansignal/ui";
import { Space } from "../../Common/Space/Space";
import { getProperty, prepareColumns } from "../../Common/Table/utils";
import * as DataGroups from "../../DataGroups";
import { FF_LOPS_E_3, isFF } from "../../../utils/feature-flags";
import { SkeletonLoader } from "../../Common/SkeletonLoader";
import { GridViewContext, GridViewProvider } from "./GridPreview";
import "./GridView.prefix.css";
import { groupBy } from "../../../utils/utils";
import { IMAGE_SIZE_COEFFICIENT } from "../../DataGroups/ImageDataGroup";
import { createBulkCacher, fetchAllImageUrls } from "../../DataGroups/carsImageCache";

const NO_IMAGE_CELL_HEIGHT = 250;
const CELL_HEADER_HEIGHT = 32;

// =========================================================================
//  Verification mode — click-to-toggle-reject (NOT open editor).
//  Optimistic UI: visual flips INSTANTLY на click, API call в фоне, rollback
//  при ошибке. Annotation IDs cached в module Map чтобы un-reject не делал
//  лишний GET (хватает одного DELETE). Multi-user: state в row.cancelled_annotations
//  (LS DB) + локальный overlay для optimistic + cross-render persistence.
// =========================================================================
const VERIF_ENABLED_KEY = "cars:verif:enabled";
const REJECT_DARKNESS_KEY = "cars:reject-darkness"; // 0..100 (0 = normal dim, 100 = pure black)
const CHROMELESS_KEY = "cars:chromeless"; // bool

function getRejectDarkness() {
  const raw = localStorage.getItem(REJECT_DARKNESS_KEY);
  if (raw === null) return 45; // default ~ current .55 opacity → ~brightness 0.55 ≈ darkness 45
  const v = parseInt(raw, 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 45;
}
function setRejectDarknessLS(v) {
  localStorage.setItem(REJECT_DARKNESS_KEY, String(v));
  window.dispatchEvent(new CustomEvent("cars:reject-darkness-changed"));
  try { carsAudit("ui.darkness", { value: v }); } catch (_) {}
}
function getChromeless() {
  return localStorage.getItem(CHROMELESS_KEY) === "true";
}
function setChromelessLS(v) {
  localStorage.setItem(CHROMELESS_KEY, v ? "true" : "false");
  window.dispatchEvent(new CustomEvent("cars:chromeless-changed"));
  try { carsAudit("ui.chromeless", { enabled: v }); } catch (_) {}
}
// cars-mods v48: small-screen mode — collapse the whole interface (hide DM tabs/toolbar +
// our verif-bar via body.cars-ui-collapsed) and/or hide the folder strips, so the grid gets
// the full screen. A thin fixed strip with "развернуть интерфейс" restores the chrome.
const UI_COLLAPSED_KEY = "cars:ui-collapsed";
const FOLDERS_HIDDEN_KEY = "cars:folders-hidden";
function getUiCollapsed() {
  return localStorage.getItem(UI_COLLAPSED_KEY) === "true";
}
// Inject the collapse CSS once via a runtime <style> (literal lsf- selectors) so it bypasses
// the build-time class prefixer — these target cross-component DM classes + a plain body class.
function ensureCollapseStyle() {
  if (typeof document === "undefined" || document.getElementById("cars-ui-collapse-style")) return;
  const s = document.createElement("style");
  s.id = "cars-ui-collapse-style";
  s.textContent =
    "body.cars-ui-collapsed .lsf-tabs-dm-content__tab > *:not(:last-child){display:none !important;}" +
    "body.cars-ui-collapsed .lsf-grid-view__verif-bar{display:none !important;}" +
    "body.cars-ui-collapsed .lsf-grid-view{padding-top:26px;}";
  document.head.appendChild(s);
}
function applyUiCollapsedClass(v) {
  try {
    ensureCollapseStyle();
    document.body.classList.toggle("cars-ui-collapsed", !!v);
  } catch (_) {}
}
function setUiCollapsedLS(v) {
  localStorage.setItem(UI_COLLAPSED_KEY, v ? "true" : "false");
  applyUiCollapsedClass(v);
  window.dispatchEvent(new CustomEvent("cars:ui-collapsed-changed"));
  try { carsAudit("ui.collapse-interface", { enabled: v }); } catch (_) {}
}
function getFoldersHidden() {
  return localStorage.getItem(FOLDERS_HIDDEN_KEY) === "true";
}
function setFoldersHiddenLS(v) {
  localStorage.setItem(FOLDERS_HIDDEN_KEY, v ? "true" : "false");
  window.dispatchEvent(new CustomEvent("cars:folders-hidden-changed"));
  try { carsAudit("ui.hide-folders", { enabled: v }); } catch (_) {}
}

// Module-level cache: taskId -> cancelled annotation ID.
// Persists between cell re-renders within same SPA session.
const annotationIdCache = new Map();

// "Folders" feature — stack of cutoffs with timestamps for review history.
// v38: SERVER-SIDE persistence через `view.cars_folders` (Tab MST → view.data JSONB).
// Per-(user, project, view) scope automatic — каждая View имеет user_id + project_id.
// Каждый click "📁↑" добавляет новую папку → можно смотреть когда какие диапазоны
// обработала, развернуть конкретную (вернуть только этот chunk).
const FOLDERS_PREFIX = "cars:folders:";
// Legacy localStorage keys (v37 and earlier) — used only for ONE-TIME migration to server.
function currentUserId() {
  return window.APP_SETTINGS?.user?.id ?? "anon";
}
function legacyFoldersKey(projectId) {
  return `${FOLDERS_PREFIX}${projectId}:u${currentUserId()}`;
}
// Read folders from MST View — Tab.cars_folders is types.array(CustomJSON).
// v39: filter to current user's folders only (when view is shared between annotators).
// Folder entries: {taskId, ts, expanded, userId?}. Legacy entries without userId visible to all.
// v43 CRITICAL: do NOT use .toJSON() — CustomJSON snapshot is a JSON STRING, not object.
// Spread on string `{...string}` produces `{0:'{', 1:'"', ...}` — corrupts entries.
// Use iterator (`[...arr]` or array index access) — MST returns parsed objects via fromSnapshot.
function parseFolderEntries(serverFolders) {
  if (!serverFolders) return [];
  const out = [];
  try {
    // Iterate via length+index (MST observable arrays support this; each access yields parsed item)
    const len = serverFolders.length ?? 0;
    for (let i = 0; i < len; i++) {
      const item = serverFolders[i];
      // Defensive: if somehow this is a string (CustomJSON snapshot leaked), parse it.
      if (typeof item === "string") {
        try { out.push(JSON.parse(item)); } catch (_) {}
      } else if (item && typeof item === "object") {
        // Plain object — could be MST snapshot proxy. Re-pluck known fields to drop any junk keys.
        out.push({
          taskId: item.taskId,
          ts: item.ts,
          expanded: !!item.expanded,
          userId: item.userId,
        });
      }
    }
  } catch (_) {}
  return out;
}
function getFolders(view) {
  if (!view) return [];
  const arr = parseFolderEntries(view.cars_folders);
  const uid = currentUserId();
  return arr.filter((f) => f && (!f.userId || String(f.userId) === String(uid)));
}
// All folders raw (no user filter) — used internally by setFolders to preserve other users' entries.
function getAllFoldersRaw(view) {
  if (!view) return [];
  return parseFolderEntries(view.cars_folders);
}
// v39: setFolders merges current user's slice with other users' folders preserved.
// `folders` should be the FILTERED list (current user only). Other users' entries
// are read from the existing server state and re-appended.
function setFolders(view, folders) {
  if (!view?.setCarsFolders) return;
  try {
    const uid = String(currentUserId());
    const all = getAllFoldersRaw(view);
    // Keep folders belonging to OTHER users (and orphans with no userId stay too — they're shared/legacy)
    const others = all.filter((f) => f && f.userId && String(f.userId) !== uid);
    // Tag own folders with userId so future reads filter correctly
    const own = (folders ?? []).map((f) => ({ ...f, userId: uid }));
    view.setCarsFolders([...others, ...own]);
    window.dispatchEvent(new CustomEvent("cars:folders-changed"));
  } catch (_) {}
}
// One-time migration: read legacy localStorage folders, push to server if server is empty.
// Idempotent per session via `_migrated` flag attached to view.
function migrateLocalStorageFolders(view, projectId) {
  if (!view || !projectId || view._carsFoldersMigrated) return;
  try {
    const raw = localStorage.getItem(legacyFoldersKey(projectId));
    if (!raw) {
      view._carsFoldersMigrated = true;
      return;
    }
    const local = JSON.parse(raw);
    if (!Array.isArray(local) || local.length === 0) {
      view._carsFoldersMigrated = true;
      return;
    }
    const serverNow = getFolders(view);
    if (serverNow.length === 0) {
      // Server empty + local has data → push to server (single API call via Tab.save)
      view.setCarsFolders?.(local);
    }
    // Always mark migrated after attempt; legacy entry stays as backup (no removal)
    view._carsFoldersMigrated = true;
  } catch (_) {
    view._carsFoldersMigrated = true;
  }
}
// Returns task IDs of currently collapsed folders (expanded !== true).
// Filter uses ARRAY POSITION (findIndex), not id-comparison — sort-order agnostic.
function collapsedFolderIds(folders) {
  return folders.filter((f) => !f.expanded).map((f) => f.taskId);
}
function logAudit(view, action, payload) {
  try {
    view?.carsAuditAppend?.({
      action,
      userId: String(currentUserId()),
      ts: Date.now(),
      ...(payload || {}),
    });
  } catch (_) {}
}

// cars-mods v42: central audit helper via CustomEvent.
// From anywhere (LSF tools, components): `carsAudit("action.name", {extra:...})`.
// Label.jsx mounts a listener that consumes events and appends to view.cars_audit_log + console.log.
// This decouples LSF-side code (Brush.jsx, OutlinerTree.tsx) from DataManager MST tree.
export function carsAudit(action, payload) {
  try {
    window.dispatchEvent(
      new CustomEvent("cars:audit", { detail: { action, payload } }),
    );
  } catch (_) {}
}
// Make available globally so non-imported code can fire events too (Brush.jsx via window).
try {
  if (typeof window !== "undefined") window.carsAudit = carsAudit;
} catch (_) {}
function addFolder(view, taskId) {
  const folders = getFolders(view);
  if (folders.some((f) => f.taskId === taskId)) return folders;
  const next = [...folders, { taskId, ts: Date.now(), expanded: false }];
  carsAudit("folder.add", { taskId });
  setFolders(view, next);
  return next;
}
function toggleFolder(view, taskId) {
  const target = getFolders(view).find((f) => f.taskId === taskId);
  const next = getFolders(view).map((f) =>
    f.taskId === taskId ? { ...f, expanded: !f.expanded } : f,
  );
  carsAudit("folder.toggle", { taskId, newExpanded: !target?.expanded });
  setFolders(view, next);
  return next;
}
function clearFolders(view) {
  const count = getFolders(view).length;
  carsAudit("folders.clear", { count });
  setFolders(view, []);
}
function formatFolderTs(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Module-level optimistic overlay: taskId -> bool (overrides row.cancelled_annotations for the cell).
// Cleared after API confirms or rolls back.
const optimisticRejected = new Map();
const optimisticListeners = new Set();
function setOptimistic(taskId, value) {
  if (value === null) optimisticRejected.delete(taskId);
  else optimisticRejected.set(taskId, value);
  optimisticListeners.forEach((cb) => cb(taskId));
}

function getVerifEnabled() {
  return localStorage.getItem(VERIF_ENABLED_KEY) === "true";
}
function setVerifEnabled(v) {
  localStorage.setItem(VERIF_ENABLED_KEY, v ? "true" : "false");
  window.dispatchEvent(new CustomEvent("cars:verif:enabled-changed"));
  try { carsAudit("verif.toggle", { enabled: v }); } catch (_) {}
}
function getCsrf() {
  const m = document.cookie.match(/csrftoken=([^;]+)/);
  return m ? m[1] : "";
}

async function apiRejectTask(taskId) {
  const resp = await fetch(`/api/tasks/${taskId}/annotations/`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRFToken": getCsrf() },
    body: JSON.stringify({ result: [], was_cancelled: true, ground_truth: false, lead_time: 0 }),
  });
  if (!resp.ok) {
    throw new Error(`reject ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
  }
  const ann = await resp.json();
  annotationIdCache.set(taskId, ann.id);
}

async function apiUnrejectTask(taskId) {
  // Fetch ALL annotations for this task and DELETE every cancelled one.
  // This cleans up duplicates from rapid-click bugs and ensures un-reject
  // truly clears the rejection regardless of how many cancelled annotations exist.
  const list = await fetch(`/api/tasks/${taskId}/`, {
    credentials: "same-origin",
  }).then((r) => (r.ok ? r.json() : {}));
  const anns = (list?.annotations || []).filter((a) => a.was_cancelled);
  await Promise.all(anns.map((a) =>
    fetch(`/api/annotations/${a.id}/`, {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "X-CSRFToken": getCsrf() },
    }),
  ));
  annotationIdCache.delete(taskId);
  return anns.length;
}

// Per-task busy set — prevents concurrent toggles for the same task.
// If user clicks rapidly, second click is ignored until first POST/DELETE finishes.
const busyTasks = new Set();

// Called from click handler. Optimistic: flip immediately, API в фоне.
// On error — rollback (clear optimistic, will revert to row state).
async function toggleSkipForTaskOptimistic(row) {
  if (busyTasks.has(row.id)) return; // ignore — concurrent toggle in flight
  busyTasks.add(row.id);

  // Read fresh state at action time, not from React closure (which can be stale)
  const optimistic = optimisticRejected.get(row.id);
  const currentRejected = optimistic !== undefined
    ? optimistic
    : (row.cancelled_annotations ?? 0) > 0;
  const newValue = !currentRejected;
  setOptimistic(row.id, newValue);

  try {
    if (newValue) {
      await apiRejectTask(row.id);
      try { row.cancelled_annotations = (row.cancelled_annotations ?? 0) + 1; } catch {}
      carsAudit("verif.reject", { taskId: row.id });
    } else {
      const deletedCount = await apiUnrejectTask(row.id);
      try { row.cancelled_annotations = Math.max(0, (row.cancelled_annotations ?? deletedCount) - deletedCount); } catch {}
      carsAudit("verif.restore", { taskId: row.id, deletedCount });
    }
  } catch (err) {
    console.error("[verif] toggle failed, rolling back:", err);
    setOptimistic(row.id, null);
    carsAudit("verif.error", { taskId: row.id, error: String(err).slice(0, 200) });
    throw err;
  } finally {
    busyTasks.delete(row.id);
  }
}

export const GridHeader = observer(({ row, selected, onSelect, view }) => {
  const isSelected = selected.isSelected(row.id);
  // view.project не существует на MST модели (присваивается только локально в payload API).
  // Canonical: getRoot(view).SDK.projectId — root.SDK хранит numeric projectId.
  const projectId = view ? getRoot(view)?.SDK?.projectId : undefined;
  return (
    <div className={cn("grid-view").elem("cell-header").toClassName()}>
      <Checkbox
        checked={isSelected}
        ariaLabel={`${isSelected ? "Unselect" : "Select"} Task ${row.id}`}
        onChange={() => onSelect?.(row.id)}
      />
      {/* cars-mods: hover-button — collapse everything ABOVE THIS card. Direct manipulation
          (user видит карточку → клик → cutoff = эта карточка). Position absolute top-right
          того же header'а — не перекрывает checkbox, появляется на hover. */}
      <button
        className={cn("grid-view").elem("hide-up-to-here").toClassName()}
        onClick={(e) => {
          e.stopPropagation();
          // v38: pass MST view (not projectId) — folder state is on view.cars_folders
          if (view && row.id) addFolder(view, row.id);
        }}
        title={`Скрыть всё выше этой карточки (cutoff до task #${row.id})`}
      >
        📁↑
      </button>
    </div>
  );
});

// Hash field id → HSL hue. Deterministic per field — `stones_total` всегда same color.
function fieldHue(fieldId) {
  let h = 0;
  for (let i = 0; i < fieldId.length; i++) h = (h * 31 + fieldId.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function shortFieldLabel(field) {
  const id = field.alias || field.id.split(":").pop() || field.id;
  // Common: stones_large → stones·L, stones_medium → stones·M, etc.
  return id
    .replace(/^stones_large$/, "L")
    .replace(/^stones_medium$/, "M")
    .replace(/^stones_small$/, "S")
    .replace(/^stones_total$/, "Σ")
    .replace(/^jewelry_count$/, "🧿")
    .replace(/_/g, " ");
}

export const GridBody = observer(({ row, fields, columnCount }) => {
  const { hasImage } = useContext(GridViewContext);
  const dataFields = fields.filter((f) => f.parent?.alias === "data");

  // cars-mods: bucket fields → Image / numeric chips / text rows.
  // Numeric chips = compact colored badges в одной flex-row под фото.
  const imageFields = dataFields.filter((f) => f.currentType === "Image");
  const numericFields = dataFields.filter((f) => {
    if (f.currentType === "Image") return false;
    const v = getProperty(row, f.id.split(":")[1] ?? f.id);
    return typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v));
  });
  const textFields = dataFields.filter(
    (f) => f.currentType !== "Image" && !numericFields.includes(f),
  );

  const renderField = (field, index) => {
    const valuePath = field.id.split(":")[1] ?? field.id;
    let value = getProperty(row, valuePath);
    if (Array.isArray(value)) value = value[0];
    return (
      <GridDataGroup
        key={`${row.id}-${index}`}
        type={field.currentType}
        value={value}
        hasImage={hasImage}
        field={field}
        row={row}
        columnCount={columnCount}
      />
    );
  };

  return (
    <>
      {imageFields.length > 0 && (
        <div className={cn("grid-view").elem("body-image").toClassName()}>
          {imageFields.map(renderField)}
        </div>
      )}
      {textFields.length > 0 && (
        <div className={cn("grid-view").elem("body-text").toClassName()}>
          {textFields.map(renderField)}
        </div>
      )}
      {numericFields.length > 0 && (
        <div className={cn("grid-view").elem("body-chips").toClassName()}>
          {numericFields.map((field) => {
            const valuePath = field.id.split(":")[1] ?? field.id;
            let value = getProperty(row, valuePath);
            if (Array.isArray(value)) value = value[0];
            const hue = fieldHue(valuePath);
            const label = shortFieldLabel(field);
            return (
              <span
                key={field.id}
                className={cn("grid-view").elem("chip").toClassName()}
                style={{
                  borderColor: `oklch(0.55 0.14 ${hue})`,
                  color: `oklch(0.85 0.08 ${hue})`,
                  background: `oklch(0.22 0.04 ${hue})`,
                }}
                title={`${valuePath}: ${value}`}
              >
                <span className={cn("grid-view").elem("chip-k").toClassName()}>{label}</span>
                <span className={cn("grid-view").elem("chip-v").toClassName()}>{value ?? "—"}</span>
              </span>
            );
          })}
        </div>
      )}
    </>
  );
});

export const GridDataGroup = observer(({ type, value, field, row, columnCount, hasImage }) => {
  const DataTypeComponent = DataGroups[type];

  return isFF(FF_LOPS_E_3) && row.loading === field.alias ? (
    <SkeletonLoader />
  ) : DataTypeComponent ? (
    <DataTypeComponent value={value} field={field} original={row} columnCount={columnCount} hasImage={hasImage} />
  ) : (
    <DataGroups.TextDataGroup value={value} field={field} original={row} hasImage={hasImage} />
  );
});

export const GridCell = observer(({ view, selected, row, fields, onClick, columnCount, ...props }) => {
  const { setCurrentTaskId, imageField, hasImage } = useContext(GridViewContext);

  // Verification mode: combined source of truth = optimistic overlay (if set)
  // OR row.cancelled_annotations (shared LS state). Optimistic forces instant
  // visual flip on click; API call resolves in background and either confirms
  // (keep optimistic) or rolls back (clear optimistic → revert).
  const [, forceRender] = useState(0);
  useEffect(() => {
    const cb = (id) => {
      if (id === row.id) forceRender((n) => n + 1);
    };
    optimisticListeners.add(cb);
    return () => optimisticListeners.delete(cb);
  }, [row.id]);
  const optimistic = optimisticRejected.get(row.id);
  const isRejected = optimistic !== undefined
    ? optimistic
    : (row.cancelled_annotations ?? 0) > 0;

  // Common interceptor: if verif mode is on, toggle skip instead of opening preview/task.
  // Deps: [row] only — toggleSkipForTaskOptimistic reads CURRENT state itself (avoids closure trap on rapid clicks).
  const interceptIfVerif = useCallback(async (e) => {
    if (!getVerifEnabled()) return false;
    e.preventDefault();
    e.stopPropagation();
    toggleSkipForTaskOptimistic(row).catch((err) => {
      console.error("[verif] toggle failed:", err);
    });
    return true;
  }, [row]);

  const handleBodyClick = useCallback(
    async (e) => {
      if (await interceptIfVerif(e)) return;
      if (!imageField) return;
      e.stopPropagation();
      setCurrentTaskId(row.id);
    },
    [imageField, row.id, interceptIfVerif],
  );

  const handleCellClick = useCallback(
    async (e) => {
      if (await interceptIfVerif(e)) return;
      onClick?.(e);
    },
    [onClick, interceptIfVerif],
  );

  return (
    <div
      {...props}
      className={cn("grid-view")
        .elem("cell")
        .mod({ selected: selected.isSelected(row.id), rejected: isRejected })
        .toClassName()}
      onClick={handleCellClick}
    >
      <div className={cn("grid-view").elem("cell-content").toClassName()}>
        <GridHeader
          view={view}
          row={row}
          fields={fields}
          selected={view.selected}
          onSelect={view.selected.toggleSelected}
        />
        <div
          className={`${cn("grid-view").elem("cell-body").mod({ responsive: !view.gridFitImagesToWidth }).toClassName()} ${cnm({ "overflow-auto": !hasImage })}`}
          onClick={handleBodyClick}
        >
          <GridBody view={view} row={row} fields={fields} columnCount={columnCount} />
        </div>
      </div>
    </div>
  );
});

// Toggle button + grid-size presets rendered at top of GridView. Classes go
// through BEM cn() helper so webpack `lsf-` prefix applies symmetrically.
//
// Size presets call `view.setGridWidth(N)` directly — persists in tab/view
// config (LS DB), so all annotators see same density per view.
const VerifToggle = observer(({ view, visibleTopRef, hiddenCount }) => {
  const [enabled, setEnabled] = useState(getVerifEnabled);
  const [darkness, setDarkness] = useState(getRejectDarkness);
  const [chromeless, setChromeless] = useState(getChromeless);
  const [uiCollapsed, setUiCollapsed] = useState(getUiCollapsed);
  const [foldersHidden, setFoldersHidden] = useState(getFoldersHidden);
  useEffect(() => {
    const refresh = () => setEnabled(getVerifEnabled());
    window.addEventListener("cars:verif:enabled-changed", refresh);
    return () => window.removeEventListener("cars:verif:enabled-changed", refresh);
  }, []);
  useEffect(() => {
    const refresh = () => {
      setDarkness(getRejectDarkness());
      setChromeless(getChromeless());
      setUiCollapsed(getUiCollapsed());
      setFoldersHidden(getFoldersHidden());
    };
    // v48: re-apply persisted collapse state to <body> on mount (survives reload).
    applyUiCollapsedClass(getUiCollapsed());
    window.addEventListener("cars:reject-darkness-changed", refresh);
    window.addEventListener("cars:chromeless-changed", refresh);
    window.addEventListener("cars:ui-collapsed-changed", refresh);
    window.addEventListener("cars:folders-hidden-changed", refresh);
    return () => {
      window.removeEventListener("cars:reject-darkness-changed", refresh);
      window.removeEventListener("cars:chromeless-changed", refresh);
      window.removeEventListener("cars:ui-collapsed-changed", refresh);
      window.removeEventListener("cars:folders-hidden-changed", refresh);
    };
  }, []);
  const currentWidth = view?.gridWidth ?? 4;
  const sizePresets = [
    { label: "XL", cols: 3, title: "Очень крупные (3 колонки) — детальный осмотр" },
    { label: "L", cols: 5, title: "Крупные (5 колонок)" },
    { label: "M", cols: 8, title: "Средние превью (8 колонок)" },
    { label: "S", cols: 12, title: "Мелкие превью (12 колонок) — массовый обзор" },
  ];
  // Apply size + force contain mode (картинка целиком).
  // LS semantic: fitImagesToWidth=TRUE → image stretches to fill cell width (vertical crop possible).
  //              fitImagesToWidth=FALSE → contain (preserve aspect, letterbox top/bottom or sides).
  // User wants full image always → fitImagesToWidth=false.
  const applyPreset = (cols) => {
    view?.setGridWidth?.(cols);
    view?.setFitImagesToWidth?.(false);
    carsAudit("ui.grid-size", { cols });
  };

  // cars-mods v46: bulk preview cache — ВСЕ фото проекта, resized до preview-размера,
  // в Web Worker (off main thread). Pause/Resume. Persists в IndexedDB (survives sessions).
  // phase: "idle" | "collecting" (paginating API) | "running" | "paused" | "done"
  const [cacheState, setCacheState] = useState({ phase: "idle", done: 0, total: 0, collected: 0 });
  const cacherRef = useRef(null);

  const startBulkCache = useCallback(async () => {
    if (cacheState.phase === "running" || cacheState.phase === "collecting") return;
    const projectId = view ? getRoot(view)?.SDK?.projectId : undefined;
    if (!projectId) {
      alert("Project ID не найден");
      return;
    }
    // maxDim derived from current grid size — больше колонок = мельче cell = меньше maxDim.
    // Берём с запасом для retina: XL(3 cols)≈512, S(12)≈256. Use 512 fixed (covers all).
    const maxDim = 512;
    setCacheState({ phase: "collecting", done: 0, total: 0, collected: 0 });
    carsAudit("cache.bulk-start", { projectId, maxDim });
    // 1) collect ALL image URLs via API pagination
    const urls = await fetchAllImageUrls(projectId, (n) => {
      setCacheState((s) => ({ ...s, collected: n }));
    });
    if (!urls.length) {
      alert("Не удалось получить список фото (0 URL)");
      setCacheState({ phase: "idle", done: 0, total: 0, collected: 0 });
      return;
    }
    // 2) spin worker
    const cacher = createBulkCacher({
      maxDim,
      concurrency: 6,
      onProgress: (m) => {
        const phase = m.type === "paused" ? "paused" : m.type === "stopped" ? "idle" : "running";
        setCacheState({ phase, done: m.done, total: m.total, collected: urls.length });
      },
      onComplete: (m) => {
        setCacheState({ phase: "done", done: m.done, total: m.total, collected: urls.length });
        carsAudit("cache.bulk-done", { done: m.done, ok: m.ok, cached: m.cached, err: m.err });
        try { cacher.terminate(); } catch (_) {}
        cacherRef.current = null;
      },
    });
    if (cacher.unsupported) {
      alert("Web Worker / OffscreenCanvas не поддерживается в этом браузере");
      setCacheState({ phase: "idle", done: 0, total: 0, collected: 0 });
      return;
    }
    cacherRef.current = cacher;
    setCacheState({ phase: "running", done: 0, total: urls.length, collected: urls.length });
    cacher.start(urls);
  }, [view, cacheState.phase]);

  const pauseBulkCache = useCallback(() => {
    cacherRef.current?.pause();
    carsAudit("cache.bulk-pause", {});
  }, []);
  const resumeBulkCache = useCallback(() => {
    cacherRef.current?.resume();
    setCacheState((s) => ({ ...s, phase: "running" }));
    carsAudit("cache.bulk-resume", {});
  }, []);
  const stopBulkCache = useCallback(() => {
    cacherRef.current?.stop();
    try { cacherRef.current?.terminate(); } catch (_) {}
    cacherRef.current = null;
    setCacheState({ phase: "idle", done: 0, total: 0, collected: 0 });
    carsAudit("cache.bulk-stop", {});
  }, []);

  // Cleanup worker on unmount
  useEffect(() => () => { try { cacherRef.current?.terminate(); } catch (_) {} }, []);
  // cars-mods: layout-agnostic hotkeys table (works for EN & RU раскладка).
  // Arrow keys/Enter/Space/Escape — same в обеих раскладках (physical keys).
  // E (открыть редактор) — мапится через event.code === "KeyE", не зависит от layout.
  const hotkeysHelp = [
    { keys: "↑ / ↓", desc: "Следующая / предыдущая карточка (в редакторе)" },
    { keys: "Enter / E", desc: "Открыть редактор (в preview)" },
    { keys: "← / →", desc: "Перелистать preview" },
    { keys: "Space (preview)", desc: "Выделить/снять чекбокс" },
    { keys: "Esc", desc: "Закрыть preview" },
    { keys: "Click", desc: enabled ? "Verif ON: выкинуть/вернуть карточку" : "Verif OFF: открыть preview" },
    { keys: "📁↑", desc: "Скрыть всё выше этой карточки (создать папку)" },
    { keys: "Shift+↑/↓", desc: "LSF: сдвинуть выделенный регион (region nudge)" },
    { keys: "— Brush —", desc: "только в редакторе масок (project 10)" },
    { keys: "Alt+drag", desc: "Временный ластик в Brush (как Photoshop)" },
    { keys: "Ctrl+Alt+drag", desc: "Сквозной ластик — стирает все маски под курсором" },
    { keys: "Space (canvas)", desc: "Завершить штрих + сбросить выделение → следующий = новая маска" },
    { keys: "X", desc: "Поменять Brush ↔ Eraser tool" },
    { keys: "1-9", desc: "Перенаречь последнюю нарисованную маску (5 сек после mouseup)" },
  ];
  return (
    <div className={cn("grid-view").elem("verif-bar").toClassName()}>
      <button
        className={cn("grid-view").elem("verif-toggle").mod({ on: enabled }).toClassName()}
        onClick={() => setVerifEnabled(!enabled)}
        title="Click on grid card to mark as rejected (no preview). Second click — restore."
      >
        {enabled ? "✓ Verif ON — клик = выкинуть" : "Verif OFF (клик открывает preview)"}
      </button>
      <details className={cn("grid-view").elem("hotkeys-help").toClassName()}>
        <summary
          className={cn("grid-view").elem("hotkeys-summary").toClassName()}
          title="Горячие клавиши"
        >
          ⌨ Hotkeys
        </summary>
        <div className={cn("grid-view").elem("hotkeys-panel").toClassName()}>
          <div className={cn("grid-view").elem("hotkeys-title").toClassName()}>
            Работает в обеих раскладках (EN / RU)
          </div>
          {hotkeysHelp.map((h) => (
            <div key={h.keys} className={cn("grid-view").elem("hotkeys-row").toClassName()}>
              <kbd className={cn("grid-view").elem("hotkeys-key").toClassName()}>{h.keys}</kbd>
              <span className={cn("grid-view").elem("hotkeys-desc").toClassName()}>{h.desc}</span>
            </div>
          ))}
        </div>
      </details>
      <ColumnsDropdown view={view} />
      {enabled && (
        <label
          className={cn("grid-view").elem("dark-slider").toClassName()}
          title="Чем правее — тем темнее выкинутые карточки. 100 = совсем чёрный."
        >
          <span className={cn("grid-view").elem("dark-slider-l").toClassName()}>⚫ Затемнение</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={darkness}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              setDarkness(v);
              setRejectDarknessLS(v);
            }}
            className={cn("grid-view").elem("dark-slider-input").toClassName()}
          />
          <span className={cn("grid-view").elem("dark-slider-v").toClassName()}>{darkness}</span>
        </label>
      )}
      <button
        className={cn("grid-view").elem("chromeless-btn").mod({ on: chromeless }).toClassName()}
        onClick={() => {
          const next = !chromeless;
          setChromeless(next);
          setChromelessLS(next);
        }}
        title="Минималистичный режим: только фото на фоне без рамок. Иконки появляются при наведении."
      >
        {chromeless ? "▣ Без рамок" : "▢ Рамки"}
      </button>
      {/* cars-mods v48: hide folder strips (small screen) */}
      <button
        className={cn("grid-view").elem("collapse-btn").mod({ on: foldersHidden }).toClassName()}
        onClick={() => {
          const next = !foldersHidden;
          setFoldersHidden(next);
          setFoldersHiddenLS(next);
        }}
        title="Скрыть/показать полосы папок (для маленького экрана)."
      >
        {foldersHidden ? "🗂 Показать папки" : "🗂 Свернуть папки"}
      </button>
      {/* cars-mods v48: collapse whole interface → thin top strip restores it */}
      <button
        className={cn("grid-view").elem("collapse-btn").toClassName()}
        onClick={() => setUiCollapsedLS(true)}
        title="Свернуть весь интерфейс (панели сверху). Останется тонкая полоса «развернуть». Для маленького экрана."
      >
        ⤢ Свернуть интерфейс
      </button>
      {/* cars-mods v46: bulk preview cache — все фото, resized, pause/resume */}
      <div className={cn("grid-view").elem("cache-controls").toClassName()}>
        {cacheState.phase === "idle" && (
          <button
            className={cn("grid-view").elem("warm-cache-btn").toClassName()}
            onClick={startBulkCache}
            title="Закешировать ВСЕ превью проекта (resized для скорости) в IndexedDB. Переживёт перезагрузку и сессии."
          >
            📥 Кешировать все превью
          </button>
        )}
        {cacheState.phase === "collecting" && (
          <span className={cn("grid-view").elem("warm-cache-btn").mod({ running: true }).toClassName()}>
            🔎 Сбор списка… {cacheState.collected}
          </span>
        )}
        {cacheState.phase === "running" && (
          <>
            <span className={cn("grid-view").elem("warm-cache-btn").mod({ running: true }).toClassName()}>
              ⏳ {cacheState.done}/{cacheState.total}
            </span>
            <button
              className={cn("grid-view").elem("warm-cache-btn").toClassName()}
              onClick={pauseBulkCache}
              title="Пауза"
            >
              ⏸
            </button>
            <button
              className={cn("grid-view").elem("warm-cache-btn").toClassName()}
              onClick={stopBulkCache}
              title="Остановить"
            >
              ✕
            </button>
          </>
        )}
        {cacheState.phase === "paused" && (
          <>
            <span className={cn("grid-view").elem("warm-cache-btn").toClassName()}>
              ⏸ {cacheState.done}/{cacheState.total}
            </span>
            <button
              className={cn("grid-view").elem("warm-cache-btn").mod({ running: true }).toClassName()}
              onClick={resumeBulkCache}
              title="Продолжить"
            >
              ▶ Продолжить
            </button>
            <button
              className={cn("grid-view").elem("warm-cache-btn").toClassName()}
              onClick={stopBulkCache}
              title="Остановить"
            >
              ✕
            </button>
          </>
        )}
        {cacheState.phase === "done" && (
          <button
            className={cn("grid-view").elem("warm-cache-btn").toClassName()}
            onClick={startBulkCache}
            title="Готово. Нажми чтобы догрузить новые (cached пропустятся)."
          >
            ✅ Кеш готов ({cacheState.done}) — обновить
          </button>
        )}
      </div>
      <div className={cn("grid-view").elem("size-presets").toClassName()}>
        <span className={cn("grid-view").elem("size-label").toClassName()}>Размер:</span>
        {sizePresets.map((p) => (
          <button
            key={p.cols}
            className={cn("grid-view").elem("size-preset").mod({ active: currentWidth === p.cols }).toClassName()}
            onClick={() => applyPreset(p.cols)}
            title={p.title}
          >
            {p.label}
          </button>
        ))}
        <span className={cn("grid-view").elem("size-current").toClassName()}>{currentWidth} кол.</span>
      </div>
    </div>
  );
});

// Thin horizontal strip per folder. Click toggles collapsed <-> expanded.
// v38: server-side persistence через view.cars_folders (Tab MST). Observer reactive.
// One-time migration from legacy localStorage on first mount per view.
const FolderStrips = observer(({ view }) => {
  const projectId = view ? getRoot(view)?.SDK?.projectId : undefined;
  useEffect(() => {
    if (view && projectId) migrateLocalStorageFolders(view, projectId);
  }, [view, projectId]);
  // Read reactively from view.cars_folders — observer triggers re-render on change
  const folders = getFolders(view);
  if (!folders.length) return null;
  const sorted = folders.slice().sort((a, b) => b.taskId - a.taskId);
  return (
    <div className={cn("grid-view").elem("folder-strips").toClassName()}>
      {sorted.map((f) => (
        <button
          key={f.taskId}
          className={cn("grid-view").elem("folder-strip").mod({ expanded: !!f.expanded }).toClassName()}
          onClick={() => toggleFolder(view, f.taskId)}
          title={
            f.expanded
              ? `Свернуть обратно (cutoff до task #${f.taskId}, создано ${formatFolderTs(f.ts)})`
              : `Развернуть этот диапазон (скрыто до task #${f.taskId}, создано ${formatFolderTs(f.ts)})`
          }
        >
          <span className={cn("grid-view").elem("folder-strip-icon").toClassName()}>{f.expanded ? "📂" : "🗂"}</span>
          <span className={cn("grid-view").elem("folder-strip-ts").toClassName()}>{formatFolderTs(f.ts)}</span>
          <span className={cn("grid-view").elem("folder-strip-id").toClassName()}>
            {f.expanded ? `развёрнуто до #${f.taskId}` : `скрыто до #${f.taskId}`}
          </span>
          <span className={cn("grid-view").elem("folder-strip-action").toClassName()}>
            {f.expanded ? "↷ свернуть" : "↶ развернуть"}
          </span>
        </button>
      ))}
      <button
        className={cn("grid-view").elem("folder-strip-reset").toClassName()}
        onClick={() => {
          if (confirm("Сбросить все папки? Отметки об отклонении сохраняются — только полосы исчезнут.")) {
            clearFolders(view);
          }
        }}
        title="Удалить все папки (verdict'ы об отклонении не трогает)"
      >
        ✕ Сбросить папки
      </button>
    </div>
  );
});

// Compact dropdown — toggle visibility of fields shown UNDER thumbnail.
// Default state for project 7 = everything hidden (set via view config initially).
// view.fieldsAsColumns returns plain spread objects ({...self, original: self}), NOT MST instances.
// MST reference array (hiddenColumns.activeList) needs identity match — must use col.original.
// col.original.toggleVisibility() — canonical MST action, internally calls parentView.toggleColumn + save.
const ColumnsDropdown = observer(({ view }) => {
  const [open, setOpen] = useState(false);
  // Exclude image column — dropdown управляет подписями ПОД фото, а не самим фото.
  // currentType="Image" canonical detector (same as hasImage check в GridView).
  const cols = (view?.fieldsAsColumns ?? []).filter(
    (c) =>
      (c.parent?.alias === "data" && c.currentType !== "Image") ||
      c.id === "annotations_results",
  );
  // Auto-close on outside click
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (!e.target.closest(`.${cn("grid-view").elem("cols-dropdown").toClassName()}`)) {
        setOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [open]);
  const visibleCount = cols.filter((c) => !(c.original?.is_hidden ?? c.hidden)).length;
  return (
    <div className={cn("grid-view").elem("cols-dropdown").toClassName()}>
      <button
        className={cn("grid-view").elem("cols-trigger").mod({ open }).toClassName()}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title="Что показывать под превью"
      >
        Подписи {visibleCount > 0 ? `(${visibleCount})` : ""} ▾
      </button>
      {open && (
        <div className={cn("grid-view").elem("cols-menu").toClassName()}>
          <div className={cn("grid-view").elem("cols-menu-h").toClassName()}>Подписи под превью</div>
          {cols.length === 0 ? (
            <div className={cn("grid-view").elem("cols-menu-empty").toClassName()}>нет доступных полей</div>
          ) : (
            cols.map((col) => {
              // col is plain spread from asField; col.original is the live MST TabColumn.
              const mstCol = col.original ?? col;
              const isHidden = mstCol?.is_hidden ?? col.hidden;
              const label = col.title || col.id;
              return (
                <label
                  key={col.id}
                  className={cn("grid-view").elem("cols-menu-item").toClassName()}
                >
                  <input
                    type="checkbox"
                    checked={!isHidden}
                    onChange={() => mstCol?.toggleVisibility?.()}
                  />
                  <span>{label}</span>
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
});

// cars-mods v51: update-notification banner. The deploy writes the build marker into
// web/dist/apps/labelstudio/cars-build.json — LS serves that dir at /react-app/ (core/urls.py
// REACT_APP_ROOT), and the dist ROOT itself is NOT http-served, so the file must live there.
// We fetch /react-app/cars-build.json at mount (baseline) and poll every 3 min. When `build`
// changes (a new deploy happened) we show a reload banner with the changelog so annotators
// force-reload instead of getting stuck on a stale cached bundle (root cause of the v48 stuck-
// collapse). The URL is derived from a loaded /react-app/*.js <script> src (base.html loads
// /react-app/main.js etc.) so it works regardless of FRONTEND_HOSTNAME. Banner is portaled to
// body + inline-styled (escapes LS's transformed containers and the lsf- CSS prefixer).
function carsBuildUrl() {
  try {
    const src = Array.from(document.scripts)
      .map((s) => s.src)
      .find((u) => /\/react-app\/[^/]+\.js/.test(u));
    return src ? src.replace(/\/react-app\/[^/]*$/, "/react-app/cars-build.json") : null;
  } catch (_) {
    return null;
  }
}
const CarsUpdateBanner = () => {
  const [note, setNote] = useState(null);
  useEffect(() => {
    const url = carsBuildUrl();
    if (!url) return;
    let baseline = null;
    let stopped = false;
    const check = async () => {
      try {
        const r = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
        if (!r.ok) return;
        const d = await r.json();
        if (baseline === null) {
          baseline = d.build;
          return;
        }
        if (d.build && d.build !== baseline) {
          setNote(d.note || "интерфейс обновлён");
          try { carsAudit("ui.update-available", { build: d.build }); } catch (_) {}
        }
      } catch (_) {}
    };
    check();
    const id = setInterval(() => { if (!stopped) check(); }, 180000);
    return () => { stopped = true; clearInterval(id); };
  }, []);
  if (!note) return null;
  return createPortal(
    <div
      style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 2147483647,
        background: "#1d4ed8", color: "#fff", padding: "9px 16px", display: "flex",
        alignItems: "center", justifyContent: "center", gap: "16px",
        font: "600 13px/1.3 system-ui, sans-serif", boxShadow: "0 2px 10px rgba(0,0,0,.45)",
      }}
    >
      <span>🔄 Интерфейс обновлён: {note}</span>
      <button
        onClick={() => window.location.reload()}
        style={{
          background: "#fff", color: "#1d4ed8", border: "none", borderRadius: "5px",
          padding: "6px 14px", font: "700 13px system-ui, sans-serif", cursor: "pointer", whiteSpace: "nowrap",
        }}
      >
        Перезагрузить
      </button>
    </div>,
    document.body,
  );
};

export const GridView = observer(({ data, view, loadMore, fields, onChange, hiddenFields }) => {
  const columnCount = view.gridWidth ?? 4;
  const prevColumnCountRef = useRef(columnCount);
  const visibleTopRef = useRef(0); // task.id at currently visible top row (для "Скрыть выше")
  const projectId = view ? getRoot(view)?.SDK?.projectId : undefined;

  // Reactive folders state — applied as position-based filter to react-window.
  // v38: read via observer from view.cars_folders (MST) — auto re-render on change.
  useEffect(() => {
    if (view && projectId) migrateLocalStorageFolders(view, projectId);
  }, [view, projectId]);
  // v38: read once per render, derive a stable string key for useMemo deps so it
  // recomputes only when content actually changes (not on every observer-trigger).
  const foldersState = getFolders(view);
  const folderDepKey = foldersState
    .map((f) => `${f.taskId}${f.expanded ? "E" : ""}`)
    .join(",");

  const getCellIndex = useCallback((row, column) => columnCount * row + column, [columnCount]);

  // cars-mods: image column ALWAYS включаем в fieldsData, независимо от hiddenColumns.
  // Dropdown «Подписи» управляет ТОЛЬКО текстовыми подписями ПОД фото — не самим фото.
  // Если image был ранее спрятан (старое состояние или native LS toolbar) — локально
  // force-include здесь чтобы рендер всегда показывал картинку. Server-side hidden state
  // не трогаем (не мутируем view.hiddenColumns) — пользователь может оставить как есть.
  const fieldsData = useMemo(() => {
    const prepared = prepareColumns(fields, hiddenFields);
    if (prepared.some((f) => f.currentType === "Image")) return prepared;
    const imageCol = fields.find((f) => f.currentType === "Image");
    return imageCol ? [imageCol, ...prepared] : prepared;
  }, [fields, hiddenFields]);
  const hasImage = fieldsData.some((f) => f.currentType === "Image");

  // v40: ID-comparison filter с auto-detect направления sort'а.
  // Position-based (v26-v39) ломался для lazy-loaded data: anchor task мог быть
  // на 5000-й позиции, а загружены первые 30 → cutoffIdx=-1, filter не применялся.
  // Теперь: max(collapsed.taskId), detect direction по first/last id в loaded data,
  // применяем `id >= cutoff` (asc) или `id <= cutoff` (desc).
  const filteredData = useMemo(() => {
    const ids = collapsedFolderIds(foldersState);
    if (!ids.length || data.length === 0) return data;
    const cutoffId = Math.max(...ids);
    // Detect sort direction from first vs last loaded item ids
    const firstId = data[0]?.id;
    const lastId = data[data.length - 1]?.id;
    if (firstId == null || lastId == null) return data;
    const isAsc = firstId <= lastId;
    // ASC sort: top of grid = lowest id. Tasks visually ABOVE cutoff have id < cutoff → hide.
    // DESC sort: top = highest id. Tasks ABOVE cutoff have id > cutoff → hide.
    return isAsc
      ? data.filter((t) => t?.id >= cutoffId)
      : data.filter((t) => t?.id <= cutoffId);
  }, [data, data.length, folderDepKey]);
  const hiddenCount = data.length - filteredData.length;

  const rowHeight = hasImage
    ? fieldsData
        .filter((f) => f.parent?.alias === "data")
        .reduce((res, f) => {
          const height = (DataGroups[f.currentType] ?? DataGroups.TextDataGroup).height;

          return res + height;
        }, 16)
    : NO_IMAGE_CELL_HEIGHT;
  const finalRowHeight =
    CELL_HEADER_HEIGHT + rowHeight * (hasImage ? Math.max(1, (IMAGE_SIZE_COEFFICIENT - columnCount) * 0.5) : 1);

  // Calculate the total number of rows needed to display all items.
  // When folders active — itemCount must be derived from filteredData, не raw data:
  // react-window-infinite-loader uses itemCount to decide which indices to query;
  // если itemCount = raw total, loader thinks indices < data.length are loaded (через
  // isItemLoaded) и не запускает loadMore, в то время как rendered grid читает
  // filteredData[index] которое возвращает undefined → пустые карточки внизу.
  // Pagination pattern: filteredData.length + (hasNextPage ? 1 : 0) — стандарт
  // react-window-infinite-loader для streamed data.
  const itemCount = filteredData.length + (view.dataStore.hasNextPage ? 1 : 0);
  // Use only loaded data for grid dimensions to avoid long scrollbar
  const loadedRows = Math.ceil(filteredData.length / columnCount);

  const renderItem = useCallback(
    ({ style, rowIndex, columnIndex }) => {
      const index = getCellIndex(rowIndex, columnIndex);
      const row = filteredData[index];
      if (!row) return null;

      const props = {
        style: {
          ...style,
          marginLeft: "1em",
        },
      };

      return (
        <GridCell
          {...props}
          view={view}
          row={row}
          fields={fieldsData}
          columnCount={columnCount}
          selected={view.selected}
          onClick={() => onChange?.(row.id)}
        />
      );
    },
    [filteredData, columnCount, fieldsData, view, onChange, getCellIndex],
  );

  const onItemsRenderedWrap = useCallback(
    (cb) =>
      ({ visibleRowStartIndex, visibleRowStopIndex, overscanRowStopIndex, overscanRowStartIndex }) => {
        // cars-mods: track currently visible top task for "Скрыть выше" button.
        const topIdx = visibleRowStartIndex * columnCount;
        const topTask = filteredData[topIdx];
        if (topTask) visibleTopRef.current = topTask.id;

        // Check if we're near the end and need to load more
        const visibleItemStopIndex = getCellIndex(visibleRowStopIndex, columnCount - 1);

        // Calculate how many items are visible in the current view
        const visibleItemsCount = (visibleRowStopIndex - visibleRowStartIndex + 1) * columnCount;

        // If we're showing items near the end of our loaded data, trigger loading
        // Use a threshold of 2 rows worth of items to trigger loading
        const threshold = Math.max(columnCount * 2, 8); // At least 8 items or 2 rows

        // cars-mods: all length checks against filteredData, не raw data — иначе
        // после применения folder filter loader не "видит" что мы у границы
        // visible items и не подгружает следующую страницу tasks.
        const effectiveLen = filteredData.length;
        const shouldLoadMore = visibleItemStopIndex >= effectiveLen - threshold && view.dataStore.hasNextPage;
        const hasEnoughItemsForVisibleArea = visibleItemStopIndex < effectiveLen;
        const needsMoreItemsForDisplay = !hasEnoughItemsForVisibleArea && view.dataStore.hasNextPage;
        const hasInsufficientItems = effectiveLen < columnCount && view.dataStore.hasNextPage;
        const hasVeryFewItems = effectiveLen < columnCount * 0.5 && view.dataStore.hasNextPage;

        if (shouldLoadMore || needsMoreItemsForDisplay || hasInsufficientItems || hasVeryFewItems) {
          loadMore?.();
        }

        cb({
          overscanStartIndex: overscanRowStartIndex,
          overscanStopIndex: overscanRowStopIndex,
          visibleStartIndex: visibleRowStartIndex,
          visibleStopIndex: visibleRowStopIndex,
        });
      },
    [filteredData.length, columnCount, view.dataStore.hasNextPage, view.dataStore.loading, loadMore, getCellIndex],
  );

  // Check if a specific item index is loaded — против filteredData, не raw data.
  // InfiniteLoader использует это решая нужно ли запросить loadMoreItems(start, stop).
  const isItemLoaded = useCallback(
    (index) => {
      const rowExists = index < filteredData.length && !!filteredData[index];
      const hasNextPage = view.dataStore.hasNextPage;
      return !hasNextPage || rowExists;
    },
    [filteredData.length, view.dataStore.hasNextPage],
  );

  // cars-mods: все gap-fill effects используют filteredData.length (что видит юзер),
  // не raw data.length. Без этого после folder cutoff data.length остаётся большим
  // (loaded total tasks), gap-fill думает "всё ок" → loadMore не вызывается → пустые
  // карточки в нижней части viewport остаются нулевыми.
  const visibleLen = filteredData.length;

  // Handle column count changes
  useEffect(() => {
    const prevColumnCount = prevColumnCountRef.current;
    const currentColumnCount = columnCount;

    if (prevColumnCount !== currentColumnCount) {
      prevColumnCountRef.current = currentColumnCount;

      const estimatedVisibleRows = Math.ceil(window.innerHeight / finalRowHeight);
      const estimatedVisibleItems = estimatedVisibleRows * currentColumnCount;

      if (visibleLen < estimatedVisibleItems && view.dataStore.hasNextPage) {
        loadMore?.();
      }
      if (visibleLen < currentColumnCount * 2 && view.dataStore.hasNextPage) {
        loadMore?.();
      }
      if (visibleLen < currentColumnCount && view.dataStore.hasNextPage) {
        loadMore?.();
      }
    }
  }, [columnCount, visibleLen, view.dataStore.hasNextPage, view.dataStore.loading, loadMore, finalRowHeight]);

  // Gap between content and screen bottom — фолдер сжимает grid, viewport не успевает
  // заполниться, scroll-event'ы не приходят, поэтому полагаемся на этот useEffect.
  useEffect(() => {
    const estimatedVisibleRows = Math.ceil(window.innerHeight / finalRowHeight);
    const estimatedVisibleItems = estimatedVisibleRows * columnCount;

    if (visibleLen < estimatedVisibleItems * 0.8 && view.dataStore.hasNextPage) {
      loadMore?.();
    }
  }, [visibleLen, columnCount, view.dataStore.hasNextPage, loadMore, finalRowHeight]);

  // Custom loadMore function that bypasses InfiniteLoader when needed
  const customLoadMore = useCallback(() => {
    if (view.dataStore.hasNextPage && !view.dataStore.loading) {
      loadMore?.();
    }
  }, [view.dataStore.hasNextPage, view.dataStore.loading, loadMore]);

  // Aggressive initial loading - trigger loading immediately when we don't have enough content
  useEffect(() => {
    const estimatedVisibleRows = Math.ceil(window.innerHeight / finalRowHeight);
    const estimatedVisibleItems = estimatedVisibleRows * columnCount;

    // If we don't have enough items to fill the screen, start loading immediately
    if (data.length < estimatedVisibleItems && view.dataStore.hasNextPage && !view.dataStore.loading) {
      loadMore?.();
    }
  }, [data.length, columnCount, view.dataStore.hasNextPage, view.dataStore.loading, loadMore, finalRowHeight]);

  // cars-mods: reactive darkness + chromeless settings for visual customization.
  // CSS var `--reject-darkness` (0..1) drives filter:brightness on rejected cells.
  // `chromeless` modifier removes borders + hides controls until hover.
  const [rejectDarkness, setRejectDarknessState] = useState(getRejectDarkness);
  const [chromeless, setChromelessState] = useState(getChromeless);
  const [foldersHidden, setFoldersHiddenState] = useState(getFoldersHidden);
  const [uiCollapsed, setUiCollapsedState] = useState(getUiCollapsed);
  useEffect(() => {
    const refresh = () => {
      setRejectDarknessState(getRejectDarkness());
      setChromelessState(getChromeless());
      setFoldersHiddenState(getFoldersHidden());
      setUiCollapsedState(getUiCollapsed());
    };
    applyUiCollapsedClass(getUiCollapsed());
    window.addEventListener("cars:reject-darkness-changed", refresh);
    window.addEventListener("cars:chromeless-changed", refresh);
    window.addEventListener("cars:ui-collapsed-changed", refresh);
    window.addEventListener("cars:folders-hidden-changed", refresh);
    return () => {
      window.removeEventListener("cars:reject-darkness-changed", refresh);
      window.removeEventListener("cars:chromeless-changed", refresh);
      window.removeEventListener("cars:ui-collapsed-changed", refresh);
      window.removeEventListener("cars:folders-hidden-changed", refresh);
    };
  }, []);

  return (
    <GridViewProvider data={data} view={view} fields={fieldsData}>
      <div
        className={cn("grid-view").mod({ columnCount, chromeless }).toClassName()}
        style={{ "--reject-darkness": (rejectDarkness / 100).toFixed(2) }}
      >
        <CarsUpdateBanner />
        {/* v49: restore bar via PORTAL to document.body + inline styles. v48's in-grid
            strip used position:fixed inside LS's transformed/virtualized containers, where
            fixed is relative to the ancestor (not viewport) -> the bar became invisible and
            annotators got stuck collapsed. Portal escapes those containers; inline styles
            bypass the CSS prefixer. Guaranteed visible at the very top of the screen. */}
        {uiCollapsed && createPortal(
          <button
            onClick={() => setUiCollapsedLS(false)}
            title="Развернуть интерфейс обратно"
            style={{
              position: "fixed", top: 0, left: 0, right: 0, height: "28px",
              zIndex: 2147483647, display: "flex", alignItems: "center",
              justifyContent: "center", gap: "8px", background: "#b45309",
              color: "#fff", border: "none", borderBottom: "2px solid #f59e0b",
              font: "700 13px/1 system-ui, sans-serif", cursor: "pointer",
            }}
          >
            ⤡ Развернуть интерфейс
          </button>,
          document.body,
        )}
        <VerifToggle view={view} visibleTopRef={visibleTopRef} hiddenCount={hiddenCount} />
        {!foldersHidden && <FolderStrips view={view} />}
        <AutoSizer className={cn("grid-view").elem("resize").toClassName()}>
          {({ width, height }) => {
            // cars-mods: for high column counts (XS=16, S=12), legacy formula
            // (line 414) clamps multiplier=1 and rowHeight stays ~200px while cell
            // width shrinks to ~110px. Result: tall narrow cell with image as
            // thin contained strip + huge empty area. Fix: when cols > IMAGE_SIZE_COEFFICIENT,
            // make cell height proportional to actual cell width (square aspect).
            const cellWidth = width / columnCount - 9.5;
            // Унифицированно для ВСЕХ размеров (XL/L/M/S): cell aspect ratio ~4:3 landscape
            // соответствует car photos. Это плюс ImageDataGroup всегда отдающая width:100%
            // height:100% object-fit:contain гарантирует что фото целиком помещается в cell
            // независимо от columnCount.
            const dynamicRowHeight = hasImage
              ? CELL_HEADER_HEIGHT + Math.max(80, Math.round(cellWidth * 0.75))
              : finalRowHeight;
            return (
              <InfiniteLoader
                itemCount={itemCount}
                isItemLoaded={isItemLoaded}
                loadMoreItems={customLoadMore}
                threshold={Math.max(1, Math.floor(view.dataStore.pageSize / 4))}
                minimumBatchSize={Math.max(1, Math.floor(view.dataStore.pageSize / 2))}
              >
                {({ onItemsRendered, ref }) => (
                  <FixedSizeGrid
                    className={cn("grid-view").elem("list").toClassName()}
                    ref={ref}
                    width={width}
                    height={height}
                    rowHeight={dynamicRowHeight}
                    overscanRowCount={Math.max(2, Math.floor(view.dataStore.pageSize / 2))}
                    columnCount={columnCount}
                    rowCount={loadedRows}
                    columnWidth={cellWidth}
                    onItemsRendered={onItemsRenderedWrap(onItemsRendered)}
                    style={{ overflowX: "hidden" }}
                  >
                    {renderItem}
                  </FixedSizeGrid>
                )}
              </InfiniteLoader>
            );
          }}
        </AutoSizer>
      </div>
    </GridViewProvider>
  );
});
