import { observer } from "mobx-react";
import { getRoot } from "mobx-state-tree";
import { useCallback, useContext, useMemo, useEffect, useRef, useState } from "react";
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
}
function getChromeless() {
  return localStorage.getItem(CHROMELESS_KEY) === "true";
}
function setChromelessLS(v) {
  localStorage.setItem(CHROMELESS_KEY, v ? "true" : "false");
  window.dispatchEvent(new CustomEvent("cars:chromeless-changed"));
}

// Module-level cache: taskId -> cancelled annotation ID.
// Persists between cell re-renders within same SPA session.
const annotationIdCache = new Map();

// "Folders" feature — stack of cutoffs with timestamps for review history.
// localStorage хранит array of {taskId, ts} per project. Active cutoff = max(taskId).
// Каждый click "Скрыть выше" добавляет новую папку → можно потом смотреть когда какие
// диапазоны обработала, развернуть конкретную (вернуть только этот chunk).
const FOLDERS_PREFIX = "cars:folders:";
// Scope folders by current user id — each annotator имеет свои папки на той же машине,
// никто не сбрасывает чужое. window.APP_SETTINGS.user.id injected в base.html (LS auth).
function currentUserId() {
  return window.APP_SETTINGS?.user?.id ?? "anon";
}
function foldersKey(projectId) {
  return `${FOLDERS_PREFIX}${projectId}:u${currentUserId()}`;
}
function getFolders(projectId) {
  if (!projectId) return [];
  try {
    const raw = localStorage.getItem(foldersKey(projectId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function setFolders(projectId, folders) {
  if (!projectId) return;
  if (folders.length > 0) {
    localStorage.setItem(foldersKey(projectId), JSON.stringify(folders));
  } else {
    localStorage.removeItem(foldersKey(projectId));
  }
  window.dispatchEvent(new CustomEvent("cars:folders-changed"));
}
// Returns task IDs of currently collapsed folders (expanded !== true).
// Filter uses ARRAY POSITION (findIndex), not id-comparison — sort-order agnostic.
// Mы идём сверху вниз делая разметку → надо hide everything ABOVE clicked card,
// keep clicked card and everything BELOW visible.
function collapsedFolderIds(folders) {
  return folders.filter((f) => !f.expanded).map((f) => f.taskId);
}
function addFolder(projectId, taskId) {
  const folders = getFolders(projectId);
  if (folders.some((f) => f.taskId === taskId)) return folders;
  const next = [...folders, { taskId, ts: Date.now(), expanded: false }];
  setFolders(projectId, next);
  return next;
}
function toggleFolder(projectId, taskId) {
  const next = getFolders(projectId).map((f) =>
    f.taskId === taskId ? { ...f, expanded: !f.expanded } : f,
  );
  setFolders(projectId, next);
  return next;
}
function clearFolders(projectId) {
  setFolders(projectId, []);
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
    } else {
      const deletedCount = await apiUnrejectTask(row.id);
      try { row.cancelled_annotations = Math.max(0, (row.cancelled_annotations ?? deletedCount) - deletedCount); } catch {}
    }
  } catch (err) {
    console.error("[verif] toggle failed, rolling back:", err);
    setOptimistic(row.id, null);
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
          if (projectId && row.id) addFolder(projectId, row.id);
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
  useEffect(() => {
    const refresh = () => setEnabled(getVerifEnabled());
    window.addEventListener("cars:verif:enabled-changed", refresh);
    return () => window.removeEventListener("cars:verif:enabled-changed", refresh);
  }, []);
  useEffect(() => {
    const refresh = () => {
      setDarkness(getRejectDarkness());
      setChromeless(getChromeless());
    };
    window.addEventListener("cars:reject-darkness-changed", refresh);
    window.addEventListener("cars:chromeless-changed", refresh);
    return () => {
      window.removeEventListener("cars:reject-darkness-changed", refresh);
      window.removeEventListener("cars:chromeless-changed", refresh);
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
  };
  return (
    <div className={cn("grid-view").elem("verif-bar").toClassName()}>
      <button
        className={cn("grid-view").elem("verif-toggle").mod({ on: enabled }).toClassName()}
        onClick={() => setVerifEnabled(!enabled)}
        title="Click on grid card to mark as rejected (no preview). Second click — restore."
      >
        {enabled ? "✓ Verif ON — клик = выкинуть" : "Verif OFF (клик открывает preview)"}
      </button>
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
// Expanded strip has tinted background — visual reminder того что папка
// existed and can be re-collapsed.
// Reset button — wipes all folders from localStorage (verdicts в DB stay intact).
const FolderStrips = observer(({ view }) => {
  const projectId = view ? getRoot(view)?.SDK?.projectId : undefined;
  const [folders, setFoldersState] = useState(() => getFolders(projectId));
  useEffect(() => {
    const refresh = () => setFoldersState(getFolders(projectId));
    window.addEventListener("cars:folders-changed", refresh);
    return () => window.removeEventListener("cars:folders-changed", refresh);
  }, [projectId]);
  if (!folders.length) return null;
  const sorted = folders.slice().sort((a, b) => b.taskId - a.taskId);
  return (
    <div className={cn("grid-view").elem("folder-strips").toClassName()}>
      {sorted.map((f) => (
        <button
          key={f.taskId}
          className={cn("grid-view").elem("folder-strip").mod({ expanded: !!f.expanded }).toClassName()}
          onClick={() => toggleFolder(projectId, f.taskId)}
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
            clearFolders(projectId);
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

export const GridView = observer(({ data, view, loadMore, fields, onChange, hiddenFields }) => {
  const columnCount = view.gridWidth ?? 4;
  const prevColumnCountRef = useRef(columnCount);
  const visibleTopRef = useRef(0); // task.id at currently visible top row (для "Скрыть выше")
  const projectId = view ? getRoot(view)?.SDK?.projectId : undefined;

  // Reactive folders state — applied as position-based filter to react-window.
  const [foldersState, setFoldersState] = useState(() => getFolders(projectId));
  useEffect(() => {
    const refresh = () => setFoldersState(getFolders(projectId));
    window.addEventListener("cars:folders-changed", refresh);
    return () => window.removeEventListener("cars:folders-changed", refresh);
  }, [projectId]);

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

  // Position-based filter: для каждой свёрнутой папки находим INDEX её anchor task в data.
  // Hide everything ABOVE (lower visual index) the max cutoff index.
  // Кликнутая карточка остаётся видимой (top границы непросмотренного диапазона).
  // Works regardless of view.ordering direction (asc/desc).
  // CRITICAL deps: `data` это MST observable array (stable proxy ref); push() в loadMore
  // мутирует in-place — ref не меняется. Без `data.length` в deps useMemo кэширует
  // первый snapshot data.slice() → новые подгруженные задачи не появляются в filteredData.
  const filteredData = useMemo(() => {
    const ids = collapsedFolderIds(foldersState);
    if (!ids.length) return data;
    let cutoffIdx = -1;
    for (let i = 0; i < data.length; i++) {
      if (ids.includes(data[i].id)) {
        if (i > cutoffIdx) cutoffIdx = i;
      }
    }
    if (cutoffIdx < 0) return data;
    return data.slice(cutoffIdx);
  }, [data, data.length, foldersState]);
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
  useEffect(() => {
    const refresh = () => {
      setRejectDarknessState(getRejectDarkness());
      setChromelessState(getChromeless());
    };
    window.addEventListener("cars:reject-darkness-changed", refresh);
    window.addEventListener("cars:chromeless-changed", refresh);
    return () => {
      window.removeEventListener("cars:reject-darkness-changed", refresh);
      window.removeEventListener("cars:chromeless-changed", refresh);
    };
  }, []);

  return (
    <GridViewProvider data={data} view={view} fields={fieldsData}>
      <div
        className={cn("grid-view").mod({ columnCount, chromeless }).toClassName()}
        style={{ "--reject-darkness": (rejectDarkness / 100).toFixed(2) }}
      >
        <VerifToggle view={view} visibleTopRef={visibleTopRef} hiddenCount={hiddenCount} />
        <FolderStrips view={view} />
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
