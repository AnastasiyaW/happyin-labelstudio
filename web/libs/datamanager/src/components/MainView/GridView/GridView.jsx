import { observer } from "mobx-react";
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

// Module-level cache: taskId -> cancelled annotation ID.
// Persists between cell re-renders within same SPA session.
const annotationIdCache = new Map();

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

export const GridHeader = observer(({ row, selected, onSelect }) => {
  const isSelected = selected.isSelected(row.id);
  return (
    <div className={cn("grid-view").elem("cell-header").toClassName()}>
      <Space>
        <Checkbox
          checked={isSelected}
          ariaLabel={`${isSelected ? "Unselect" : "Select"} Task ${row.id}`}
          onChange={() => onSelect?.(row.id)}
        />
        <span>{row.id}</span>
      </Space>
    </div>
  );
});

export const GridBody = observer(({ row, fields, columnCount }) => {
  const { hasImage } = useContext(GridViewContext);
  const dataFields = fields.filter((f) => f.parent?.alias === "data");
  const group = groupBy(dataFields, (f) => f.currentType);

  return Object.entries(group).map(([type, fields]) => {
    return (
      <div
        key={type}
        className={cnm("h-full w-full", {
          "overflow-x-auto scrollbar-thin scrollbar-thumb-neutral-border scrollbar-track-transparent":
            type !== "Image" || type === "Unknown",
          "h-auto": !hasImage || hasImage,
        })}
      >
        {fields.map((field, index) => {
          const valuePath = field.id.split(":")[1] ?? field.id;
          const field_type = field.currentType;
          let value = getProperty(row, valuePath);

          /**
           * The value is an array...
           * In this case, we take the first element of the array
           */
          if (Array.isArray(value)) {
            value = value[0];
          }

          return (
            <GridDataGroup
              key={`${row.id}-${index}`}
              type={field_type}
              value={value}
              hasImage={hasImage}
              field={field}
              row={row}
              columnCount={columnCount}
            />
          );
        })}
      </div>
    );
  });
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
const VerifToggle = observer(({ view }) => {
  const [enabled, setEnabled] = useState(getVerifEnabled);
  useEffect(() => {
    const refresh = () => setEnabled(getVerifEnabled());
    window.addEventListener("cars:verif:enabled-changed", refresh);
    return () => window.removeEventListener("cars:verif:enabled-changed", refresh);
  }, []);
  const currentWidth = view?.gridWidth ?? 4;
  const sizePresets = [
    { label: "XL", cols: 3, title: "Очень крупные (3 колонки) — детальный осмотр" },
    { label: "L", cols: 5, title: "Крупные (5 колонок)" },
    { label: "M", cols: 8, title: "Средние превью (8 колонок)" },
    { label: "S", cols: 12, title: "Мелкие превью (12 колонок)" },
    { label: "XS", cols: 16, title: "Очень мелкие (16 колонок) — обзор массами" },
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

// Compact dropdown — toggle visibility of fields shown UNDER thumbnail.
// Default state for project 7 = everything hidden (set via view config initially).
// Uses view.hiddenColumns.add(col)/remove(col) (TabHiddenColumns MST actions).
const ColumnsDropdown = observer(({ view }) => {
  const [open, setOpen] = useState(false);
  const cols = (view?.fieldsAsColumns ?? []).filter(
    (c) => c.parent?.alias === "data" || c.id === "annotations_results",
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
  const visibleCount = cols.filter((c) => !view?.hiddenColumns?.hasColumn(c)).length;
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
              const isHidden = view.hiddenColumns?.hasColumn(col);
              const label = col.title || col.id;
              return (
                <label
                  key={col.id}
                  className={cn("grid-view").elem("cols-menu-item").toClassName()}
                >
                  <input
                    type="checkbox"
                    checked={!isHidden}
                    onChange={() => {
                      if (isHidden) view.hiddenColumns.remove(col);
                      else view.hiddenColumns.add(col);
                    }}
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

  const getCellIndex = useCallback((row, column) => columnCount * row + column, [columnCount]);

  const fieldsData = useMemo(() => {
    return prepareColumns(fields, hiddenFields);
  }, [fields, hiddenFields]);
  const hasImage = fieldsData.some((f) => f.currentType === "Image");

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

  // Calculate the total number of rows needed to display all items
  const itemCount = view.dataStore.total || data.length;
  // Use only loaded data for grid dimensions to avoid long scrollbar
  const loadedRows = Math.ceil(data.length / columnCount);

  const renderItem = useCallback(
    ({ style, rowIndex, columnIndex }) => {
      const index = getCellIndex(rowIndex, columnIndex);
      const row = data[index];
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
    [data, columnCount, fieldsData, view, onChange, getCellIndex],
  );

  const onItemsRenderedWrap = useCallback(
    (cb) =>
      ({ visibleRowStartIndex, visibleRowStopIndex, overscanRowStopIndex, overscanRowStartIndex }) => {
        // Check if we're near the end and need to load more
        const visibleItemStopIndex = getCellIndex(visibleRowStopIndex, columnCount - 1);

        // Calculate how many items are visible in the current view
        const visibleItemsCount = (visibleRowStopIndex - visibleRowStartIndex + 1) * columnCount;

        // If we're showing items near the end of our loaded data, trigger loading
        // Use a threshold of 2 rows worth of items to trigger loading
        const threshold = Math.max(columnCount * 2, 8); // At least 8 items or 2 rows

        // Check if we need to load more items
        const shouldLoadMore = visibleItemStopIndex >= data.length - threshold && view.dataStore.hasNextPage;

        // Also check if we don't have enough items to fill the visible area
        const hasEnoughItemsForVisibleArea = visibleItemStopIndex < data.length;
        const needsMoreItemsForDisplay = !hasEnoughItemsForVisibleArea && view.dataStore.hasNextPage;

        // More aggressive check: if we have fewer items than columns, always load more
        const hasInsufficientItems = data.length < columnCount && view.dataStore.hasNextPage;

        // Special case: if we have very few items compared to columns, be extra aggressive
        const hasVeryFewItems = data.length < columnCount * 0.5 && view.dataStore.hasNextPage;

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
    [data.length, columnCount, view.dataStore.hasNextPage, view.dataStore.loading, loadMore, getCellIndex],
  );

  // Check if a specific item index is loaded
  const isItemLoaded = useCallback(
    (index) => {
      const rowExists = index < data.length && !!data[index];
      const hasNextPage = view.dataStore.hasNextPage;
      return !hasNextPage || rowExists;
    },
    [data.length, view.dataStore.hasNextPage],
  );

  // Handle column count changes
  useEffect(() => {
    const prevColumnCount = prevColumnCountRef.current;
    const currentColumnCount = columnCount;

    // If column count changed and we have more columns now (showing fewer rows)
    if (prevColumnCount !== currentColumnCount) {
      prevColumnCountRef.current = currentColumnCount;

      // Calculate how many items we can display with the new column count
      const estimatedVisibleRows = Math.ceil(window.innerHeight / finalRowHeight);
      const estimatedVisibleItems = estimatedVisibleRows * currentColumnCount;

      // If we don't have enough items to fill the visible area, load more
      // Note: We don't check !view.dataStore.loading here because we want to trigger loading
      // even if something is already loading, to ensure we get enough items
      if (data.length < estimatedVisibleItems && view.dataStore.hasNextPage) {
        loadMore?.();
      }

      // Fallback: if we have significantly fewer items than columns, always load more
      if (data.length < currentColumnCount * 2 && view.dataStore.hasNextPage) {
        loadMore?.();
      }

      // Special case: if we have fewer items than the column count itself, definitely load more
      // This handles the case where there aren't enough items to even fill one row
      if (data.length < currentColumnCount && view.dataStore.hasNextPage) {
        loadMore?.();
      }
    }
  }, [columnCount, data.length, view.dataStore.hasNextPage, view.dataStore.loading, loadMore, finalRowHeight]);

  // Additional effect to handle cases where we have a gap between content and screen bottom
  useEffect(() => {
    // Calculate if we have enough content to fill the screen
    const estimatedVisibleRows = Math.ceil(window.innerHeight / finalRowHeight);
    const estimatedVisibleItems = estimatedVisibleRows * columnCount;

    // If we have significantly fewer items than needed to fill the screen, load more
    // This handles the case where there's a gap and no scroll events are firing
    if (data.length < estimatedVisibleItems * 0.8 && view.dataStore.hasNextPage) {
      loadMore?.();
    }
  }, [data.length, columnCount, view.dataStore.hasNextPage, loadMore, finalRowHeight]);

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

  return (
    <GridViewProvider data={data} view={view} fields={fieldsData}>
      <div className={cn("grid-view").mod({ columnCount }).toClassName()}>
        <VerifToggle view={view} />
        <AutoSizer className={cn("grid-view").elem("resize").toClassName()}>
          {({ width, height }) => {
            // cars-mods: for high column counts (XS=16, S=12), legacy formula
            // (line 414) clamps multiplier=1 and rowHeight stays ~200px while cell
            // width shrinks to ~110px. Result: tall narrow cell with image as
            // thin contained strip + huge empty area. Fix: when cols > IMAGE_SIZE_COEFFICIENT,
            // make cell height proportional to actual cell width (square aspect).
            const cellWidth = width / columnCount - 9.5;
            const dynamicRowHeight = hasImage && columnCount > IMAGE_SIZE_COEFFICIENT
              ? CELL_HEADER_HEIGHT + Math.max(120, cellWidth)
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
