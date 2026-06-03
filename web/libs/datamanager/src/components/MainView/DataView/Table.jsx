import { IconQuestionOutline, IconSettings } from "@humansignal/icons";
import { Tooltip, Badge } from "@humansignal/ui";
import { inject } from "mobx-react";
import { getRoot } from "mobx-state-tree";
import { useCallback, useMemo, useRef } from "react";
import { useShortcut } from "../../../sdk/hotkeys";
import { cn } from "../../../utils/bem";
import { FF_DEV_2536, isFF } from "../../../utils/feature-flags";
import { isActive, FF_UTC_428_CONSENSUS_CONTROL_TAG_AGREEMENT } from "@humansignal/core/lib/utils/feature-flags";
import * as CellViews from "../../CellViews";
import { Icon } from "../../Common/Icon/Icon";
import { Spinner } from "../../Common/Spinner";
import { Table } from "../../Common/Table/Table";
import { GridView } from "../GridView/GridView";
import "./Table.prefix.css";
import { Button } from "@humansignal/ui";
import { useEffect, useState } from "react";
import { EmptyState } from "./empty-state";
import {
  DENSITY_STORAGE_KEY,
  DENSITY_COMFORTABLE,
  DENSITY_COMPACT,
  ROW_HEIGHT_COMFORTABLE,
  ROW_HEIGHT_COMPACT,
} from "../../DataManager/Toolbar/DensityToggle";

const injector = inject(({ store }) => {
  const { dataStore, currentView } = store;
  const totalTasks = store.project?.task_count ?? store.project?.task_number ?? 0;
  const foundTasks = dataStore?.total ?? 0;

  const props = {
    store,
    dataStore,
    updated: dataStore.updated,
    view: currentView,
    viewType: currentView?.type ?? "list",
    columns: currentView?.fieldsAsColumns ?? [],
    hiddenColumns: currentView?.hiddenColumnsList,
    selectedItems: currentView?.selected,
    selectedCount: currentView?.selected?.length ?? 0,
    isLabeling: store.isLabeling ?? false,
    data: dataStore?.list ?? [],
    total: dataStore?.total ?? 0,
    isLoading: dataStore?.loading ?? true,
    isLocked: currentView?.locked ?? false,
    hasData: (store.project?.task_count ?? store.project?.task_number ?? dataStore?.total ?? 0) > 0,
    focusedItem: dataStore?.selected ?? dataStore?.highlighted,
    // Role-based empty state props
    role: store.SDK?.role ?? null,
    project: store.project ?? {},
    hasFilters: (currentView?.filtersApplied ?? 0) > 0,
    canLabel: totalTasks > 0 && foundTasks > 0,
    // LSE-specific callbacks and components
    onViewAnalytics: store.SDK?.onViewAnalytics,
    onViewReviewerAnalytics: store.SDK?.onViewReviewerAnalytics,
    RowContextMenuComponent: store.SDK?.RowContextMenuComponent,
  };

  return props;
});

export const DataView = injector(
  ({
    store,
    data,
    columns: rawColumns,
    view,
    selectedItems,
    dataStore,
    viewType,
    total,
    isLoading,
    isLabeling,
    hiddenColumns = [],
    hasData = false,
    isLocked,
    role,
    project,
    hasFilters,
    canLabel,
    onViewAnalytics,
    onViewReviewerAnalytics,
    RowContextMenuComponent,
    ...props
  }) => {
    const [datasetStatusID, setDatasetStatusID] = useState(store.SDK.dataset?.status?.id);
    const [density, setDensity] = useState(() => {
      return localStorage.getItem(DENSITY_STORAGE_KEY) ?? DENSITY_COMFORTABLE;
    });

    // cars-mods (backend-fork 2026-06): per-project annotation workflow — claim ("забрать
    // себе") + auto-hide processed. State in Task.meta via backend endpoints (shared across
    // annotators). UI prefs (toggle/delay/mode) per-user in localStorage.
    const carsProjectId = Number(store.SDK?.projectId);
    const carsCompact = [8, 9, 10].includes(carsProjectId);
    const CARS_KEY = `cars:wf:${carsProjectId}`;
    const [carsSettings, setCarsSettings] = useState(() => {
      const def = { hideProcessed: false, hideAfterMin: 5, markOn: "edits" };
      try {
        return { ...def, ...JSON.parse(localStorage.getItem(CARS_KEY) || "{}") };
      } catch {
        return def;
      }
    });
    const setCars = useCallback(
      (patch) =>
        setCarsSettings((p) => {
          const n = { ...p, ...patch };
          try {
            localStorage.setItem(CARS_KEY, JSON.stringify(n));
          } catch (_) {}
          return n;
        }),
      [CARS_KEY],
    );
    // minute tick so processed tasks disappear as the hide-delay elapses
    const [carsNow, setCarsNow] = useState(() => Date.now());
    useEffect(() => {
      if (!carsCompact || !carsSettings.hideProcessed) return undefined;
      const iv = setInterval(() => setCarsNow(Date.now()), 30000);
      return () => clearInterval(iv);
    }, [carsCompact, carsSettings.hideProcessed]);
    const carsProcessedAt = useCallback((t) => {
      const ts = t?.meta?.cars_processed_at;
      if (ts) {
        const v = Date.parse(ts);
        return isNaN(v) ? null : v;
      }
      // fallback for "edits" mode: any annotation/draft/cancel counts as processed
      if ((t?.total_annotations ?? 0) > 0 || (t?.cancelled_annotations ?? 0) > 0 || t?.draft_exists) {
        const v = t?.updated_at ? Date.parse(t.updated_at) : NaN;
        return isNaN(v) ? Date.now() : v;
      }
      return null;
    }, []);
    const carsClaim = useCallback(
      async (count) => {
        try {
          await store.apiCall("carsClaim", {}, { project: carsProjectId, count });
          await view?.reload?.();
        } catch (e) {
          console.warn("[cars] claim failed", e);
        }
      },
      [store, carsProjectId, view],
    );
    const carsRelease = useCallback(async () => {
      try {
        await store.apiCall("carsRelease", {}, { project: carsProjectId });
        await view?.reload?.();
      } catch (e) {
        console.warn("[cars] release failed", e);
      }
    }, [store, carsProjectId, view]);
    const carsMarkProcessed = useCallback(
      (taskId) => {
        try {
          store.apiCall("carsProcessed", { taskID: taskId }, {});
        } catch (_) {}
      },
      [store],
    );

    // cars-mods: в labeling pane ставим image первой колонкой (для удобства narrow split).
    // При сжатии правый край режется первым → image (леfтmost) остаётся видимым дольше.
    const columns = useMemo(() => {
      if (!isLabeling) return rawColumns;
      const imgIdx = rawColumns.findIndex((c) => c.type === "Image");
      if (imgIdx <= 0) return rawColumns;
      return [rawColumns[imgIdx], ...rawColumns.slice(0, imgIdx), ...rawColumns.slice(imgIdx + 1)];
    }, [rawColumns, isLabeling]);

    // cars-mods v41: ПОДНЯЛИ filter cars_folders на уровень DataView чтобы работал
    // для ОБОИХ view types (list → Table, grid → GridView).
    // v43 CRITICAL FIX: НЕ использовать .toJSON() — CustomJSON snapshots = JSON strings,
    // spread их разрушает. Итерируемся через index доступ MST array.
    const filteredData = useMemo(() => {
      const cf = view?.cars_folders;
      if (!cf || !cf.length || !data.length) return data;
      const myUid = String(window.APP_SETTINGS?.user?.id ?? "anon");
      const arr = [];
      try {
        const len = cf.length ?? 0;
        for (let i = 0; i < len; i++) {
          const item = cf[i];
          if (typeof item === "string") {
            try { arr.push(JSON.parse(item)); } catch (_) {}
          } else if (item && typeof item === "object") {
            arr.push({
              taskId: item.taskId,
              ts: item.ts,
              expanded: !!item.expanded,
              userId: item.userId,
            });
          }
        }
      } catch (_) {}
      const mineCollapsed = arr.filter(
        (f) => f && f.taskId != null && !f.expanded && (!f.userId || String(f.userId) === myUid),
      );
      if (!mineCollapsed.length) {
        try {
          console.log(`[CARS-LOG] filter: no my-collapsed folders (cf.length=${arr.length}, uid=${myUid})`);
        } catch (_) {}
        return data;
      }
      const cutoffId = Math.max(...mineCollapsed.map((f) => f.taskId));
      const firstId = data[0]?.id;
      const lastId = data[data.length - 1]?.id;
      if (firstId == null || lastId == null) return data;
      const isAsc = firstId <= lastId;
      const filtered = isAsc
        ? data.filter((t) => t?.id >= cutoffId)
        : data.filter((t) => t?.id <= cutoffId);
      try {
        console.log(
          `[CARS-LOG] filter: cutoff=${cutoffId} sort=${isAsc ? "ASC" : "DESC"} ` +
            `data.length=${data.length} → filtered=${filtered.length} ` +
            `hidden=${data.length - filtered.length} uid=${myUid}`,
        );
      } catch (_) {}
      return filtered;
    }, [data, data.length, view?.cars_folders, view?.cars_folders?.length]);

    // cars-mods (backend-fork): claim visibility (hide tasks claimed by OTHER annotators) +
    // auto-hide processed once the per-project delay elapses. Shared via Task.meta.
    const carsVisibleData = useMemo(() => {
      if (!carsCompact) return filteredData;
      const myUid = String(window.APP_SETTINGS?.user?.id ?? "");
      let out = filteredData.filter((t) => {
        const c = t?.meta?.cars_claimed_by;
        return c == null || String(c) === myUid;
      });
      if (carsSettings.hideProcessed) {
        const ms = (carsSettings.hideAfterMin || 5) * 60000;
        out = out.filter((t) => {
          const p = carsProcessedAt(t);
          return !(p && carsNow - p > ms);
        });
      }
      return out;
    }, [
      carsCompact,
      filteredData,
      carsSettings.hideProcessed,
      carsSettings.hideAfterMin,
      carsNow,
      carsProcessedAt,
    ]);

    const focusedItem = useMemo(() => {
      return props.focusedItem;
    }, [props.focusedItem]);

    // Listen for density changes from any DensityToggle component
    useEffect(() => {
      const handleDensityChange = (e) => {
        setDensity(e.detail);
      };

      window.addEventListener("dm:density:changed", handleDensityChange);
      return () => window.removeEventListener("dm:density:changed", handleDensityChange);
    }, []);

    const loadMore = useCallback(async () => {
      if (!dataStore.hasNextPage || dataStore.loading) return Promise.resolve();

      await dataStore.fetch({ interaction: "scroll" });
      return Promise.resolve();
    }, [dataStore]);

    const isItemLoaded = useCallback(
      (data, index) => {
        const rowExists = index < data.length && !!data[index];
        const hasNextPage = dataStore.hasNextPage;

        return !hasNextPage || rowExists;
      },
      [dataStore.hasNextPage],
    );

    const columnHeaderExtra = useCallback(({ parent, original, help }, decoration) => {
      const children = [];

      if (parent && original?.alias !== "agreement") {
        children.push(
          <Badge key="column-type" size="small">
            {original?.readableType ?? parent.title}
          </Badge>,
        );
      } else if (typeof original?.alias === "string" && original.alias.startsWith("dimension_agreement_")) {
        // Show a short tag for per-dimension agreement columns (root columns, no parent)
        children.push(
          <Badge key="column-type" size="small">
            {original.readableType}
          </Badge>,
        );
      }

      // Add Badge when enterprise badge is set
      if (original.enterprise_badge) {
        children.push(<EnterpriseBadge key="enterprise-badge" size="small" className="ml-tightest" children="" />);
      }

      const isAgreementColumn =
        typeof original?.alias === "string" &&
        (original.alias === "agreement" || original.alias.startsWith("dimension_agreement_"));

      // A column is a clickable button when: agreement with flag ON, or agreement_selected (always a button)
      const isInteractiveAgreementColumn =
        (isAgreementColumn && isActive(FF_UTC_428_CONSENSUS_CONTROL_TAG_AGREEMENT)) ||
        (typeof original?.alias === "string" && original.alias === "agreement_selected");

      if (isInteractiveAgreementColumn) {
        children.push(<IconSettings width={16} height={16} className="ml-auto" />);
      }

      if (help && decoration?.help !== false && !isInteractiveAgreementColumn) {
        children.push(
          <Tooltip key="help-tooltip" title={help}>
            <Icon icon={IconQuestionOutline} style={{ opacity: 0.5 }} />
          </Tooltip>,
        );
      }

      return children.length ? <>{children}</> : null;
    }, []);

    const onSelectAll = useCallback(() => view.selectAll(), [view]);

    const onRowSelect = useCallback((id) => view.toggleSelected(id), [view]);

    const onRangeSelect = useCallback((ids, select) => view.selectRange(ids, select), [view]);

    const carsClickTimer = useRef(null);
    const onRowClick = useCallback(
      async (item, e) => {
        const itemID = item.task_id ?? item.id;

        // cars-mods (compact projects 8/9/10): single click = toggle checkbox (for bulk
        // select / delete-trash); DOUBLE click = open the editor (+ mark processed in
        // "open" mode). Debounced so a double-click doesn't first toggle then open.
        if (carsCompact && store.SDK.type !== "DE" && !(e.metaKey || e.ctrlKey)) {
          if (e.detail >= 2) {
            if (carsClickTimer.current) {
              clearTimeout(carsClickTimer.current);
              carsClickTimer.current = null;
            }
            if (carsSettings.markOn === "open") carsMarkProcessed(itemID);
            store._sdk.lsf?.saveDraft();
            getRoot(view).startLabeling(item);
          } else {
            if (carsClickTimer.current) clearTimeout(carsClickTimer.current);
            const id = item.id;
            carsClickTimer.current = setTimeout(() => {
              view.toggleSelected(id);
              carsClickTimer.current = null;
            }, 220);
          }
          return;
        }

        if (store.SDK.type === "DE") {
          store.SDK.invoke("recordPreview", item, columns, getRoot(view).taskStore.associatedList);
        } else if (e.metaKey || e.ctrlKey) {
          window.open(`./?task=${itemID}`, "_blank");
        } else {
          store._sdk.lsf?.saveDraft();
          getRoot(view).startLabeling(item);
        }
      },
      [view, columns, carsCompact, carsSettings.markOn, carsMarkProcessed, store],
    );

    const renderContent = useCallback(
      (content) => {
        if (isLoading && total === 0 && !isLabeling) {
          return (
            <div className={cn("fill-container").toClassName()}>
              <Spinner size="large" />
            </div>
          );
        }
        if (store.SDK.type === "DE" && ["canceled", "failed"].includes(datasetStatusID)) {
          return (
            <div className={cn("syncInProgress").toClassName()}>
              <h3 className={cn("syncInProgress").elem("title").toClassName()}>Failed to sync data</h3>
              <div className={cn("syncInProgress").elem("text").toClassName()}>
                Check your storage settings. You may need to recreate this dataset
              </div>
            </div>
          );
        }
        if (
          store.SDK.type === "DE" &&
          (total === 0 || data.length === 0 || !hasData) &&
          datasetStatusID === "completed"
        ) {
          return (
            <div className={cn("syncInProgress").toClassName()}>
              <h3 className={cn("syncInProgress").elem("title").toClassName()}>Nothing found</h3>
              <div className={cn("syncInProgress").elem("text").toClassName()}>
                Try adjusting the filter or similarity search parameters
              </div>
            </div>
          );
        }
        if (store.SDK.type === "DE" && (total === 0 || data.length === 0 || !hasData)) {
          return (
            <div className={cn("syncInProgress").toClassName()}>
              <h3 className={cn("syncInProgress").elem("title").toClassName()}>
                Hang tight! Records are syncing in the background
              </h3>
              <div className={cn("syncInProgress").elem("text").toClassName()}>
                Press the button below to see any synced records
              </div>
              <Button
                size="small"
                look="outlined"
                onClick={async () => {
                  await store.fetchProject({
                    force: true,
                    interaction: "refresh",
                  });
                  await store.currentView?.reload();
                }}
              >
                Refresh
              </Button>
            </div>
          );
        }
        // Unified empty state handling - EmptyState now handles all cases internally
        if (total === 0 || !hasData) {
          // Use unified EmptyState for all cases
          return (
            <div className={cn("no-results").toClassName()}>
              <EmptyState
                // Import functionality props
                canImport={!!store.interfaces.get("import")}
                onOpenSourceStorageModal={() => getRoot(store)?.SDK?.invoke?.("openSourceStorageModal")}
                onOpenImportModal={() => getRoot(store)?.SDK?.invoke?.("importClicked")}
                // Role-based functionality props
                userRole={role}
                project={project}
                hasData={hasData}
                hasFilters={hasFilters}
                canLabel={canLabel}
                onLabelAllTasks={() => {
                  // Use the same logic as the main Label All Tasks button
                  // Set localStorage to indicate "label all" mode (same as main button)
                  localStorage.setItem("dm:labelstream:mode", "all");

                  // Start label stream mode (DataManager's equivalent of navigating to labeling)
                  store.startLabelStream();
                }}
                onClearFilters={() => {
                  // Clear all filters from the current view
                  const currentView = store.currentView;
                  if (currentView && currentView.filters) {
                    // Create a copy of the filters array to avoid modification during iteration
                    const filtersToDelete = [...currentView.filters];
                    filtersToDelete.forEach((filter) => {
                      currentView.deleteFilter(filter);
                    });
                    // Reload the view to refresh the data
                    currentView.reload();
                  }
                }}
              />
            </div>
          );
        }

        return content;
      },
      [hasData, isLabeling, isLoading, total, datasetStatusID, role, project, hasFilters, canLabel],
    );

    const decorationContent = (col) => {
      const column = col.original;

      if (column.icon) {
        return <Tooltip title={column.help ?? col.title}>{column.icon}</Tooltip>;
      }

      return column.title;
    };

    const commonDecoration = useCallback(
      (alias, size, align = "flex-start", help = false) => ({
        alias,
        content: decorationContent,
        style: (col) => ({ width: col.width ?? size, justifyContent: align }),
        help,
      }),
      [],
    );

    const decoration = useMemo(
      () => [
        commonDecoration("total_annotations", 60, "center"),
        commonDecoration("cancelled_annotations", 60, "center"),
        commonDecoration("total_predictions", 60, "center"),
        commonDecoration("completed_at", 180, "space-between", true),
        commonDecoration("reviews_accepted", 60, "center"),
        commonDecoration("reviews_rejected", 60, "center"),
        commonDecoration("ground_truth", 60, "center"),
        isFF(FF_DEV_2536) && commonDecoration("comment_count", 60, "center"),
        isFF(FF_DEV_2536) && commonDecoration("unresolved_comment_count", 60, "center"),
        {
          resolver: (col) => col.alias === "agreement",
          style: { width: 130 },
        },
        {
          resolver: (col) => typeof col.alias === "string" && col.alias.startsWith("dimension_agreement_"),
          style: { width: 180 },
        },
        {
          resolver: (col) => col.type === "Number",
          style(col) {
            return /id/.test(col.id) ? { width: 50 } : { width: 110 };
          },
        },
        {
          resolver: (col) => col.type === "Image" && col.original && getRoot(col.original)?.SDK?.type !== "DE",
          style: { width: 150, justifyContent: "center" },
        },
        {
          resolver: (col) => col.type === "Image" && col.original && getRoot(col.original)?.SDK?.type === "DE",
          style: { width: 150 },
        },
        {
          resolver: (col) => ["Date", "Datetime"].includes(col.type),
          style: { width: 240 },
        },
        {
          resolver: (col) => ["Audio", "AudioPlus"].includes(col.type),
          style: { width: 150 },
        },
      ],
      [commonDecoration],
    );

    const rowHeight = density === DENSITY_COMPACT ? ROW_HEIGHT_COMPACT : ROW_HEIGHT_COMFORTABLE;

    const content =
      view.root.isLabeling || viewType === "list" ? (
        <Table
          view={view}
          data={carsVisibleData}
          rowHeight={rowHeight}
          total={total}
          loadMore={loadMore}
          fitContent={isLabeling}
          columns={columns}
          hiddenColumns={hiddenColumns}
          cellViews={CellViews}
          decoration={decoration}
          order={view.ordering}
          focusedItem={focusedItem}
          isItemLoaded={isItemLoaded}
          sortingEnabled={view.type === "list"}
          columnHeaderExtra={columnHeaderExtra}
          selectedItems={selectedItems}
          onSelectAll={onSelectAll}
          onSelectRow={onRowSelect}
          onRangeSelect={onRangeSelect}
          onRowClick={onRowClick}
          stopInteractions={isLocked}
          onTypeChange={(col, type) => col.original.setType(type)}
          onColumnResize={(col, width) => {
            col.original.setWidth(width);
          }}
          onColumnReset={(col) => {
            col.original.resetWidth();
          }}
          onDensityChange={setDensity}
          onViewAnalytics={onViewAnalytics}
          onViewReviewerAnalytics={onViewReviewerAnalytics}
          RowContextMenuComponent={RowContextMenuComponent}
        />
      ) : (
        <GridView
          view={view}
          data={carsVisibleData}
          fields={columns}
          loadMore={loadMore}
          onChange={(id) => view.toggleSelected(id)}
          hiddenFields={hiddenColumns}
          stopInteractions={isLocked}
        />
      );

    useShortcut("dm.focus-previous", () => {
      if (document.activeElement !== document.body) return;

      const task = dataStore.focusPrev();

      getRoot(view).startLabeling(task);
    });

    useShortcut("dm.focus-next", () => {
      if (document.activeElement !== document.body) return;

      const task = dataStore.focusNext();

      getRoot(view).startLabeling(task);
    });

    useShortcut("dm.close-labeling", () => {
      if (document.activeElement !== document.body) return;

      if (dataStore.selected) store.closeLabeling();
    });

    useShortcut("dm.open-labeling", () => {
      if (document.activeElement !== document.body) return;

      const { highlighted } = dataStore;
      // don't close QuickView by Enter

      if (highlighted && !highlighted.isSelected) store.startLabeling(highlighted);
    });

    useEffect(() => {
      const updateDatasetStatus = (dataset) => dataset?.status?.id && setDatasetStatusID(dataset?.status?.id);

      getRoot(store).SDK.on("datasetUpdated", updateDatasetStatus);
      return () => getRoot(store).SDK.off("datasetUpdated", updateDatasetStatus);
    }, []);

    // cars-mods (backend-fork): toolbar for claim + auto-hide processed (projects 8/9/10).
    const carsBtn = {
      padding: "3px 9px",
      fontSize: 12,
      border: "1px solid var(--color-neutral-border)",
      borderRadius: 4,
      background: "var(--color-neutral-surface)",
      color: "var(--color-neutral-content)",
      cursor: "pointer",
    };
    // Render the UI for your table
    return (
      <div
        className={cn("data-view-dm").mix("dm-content").toClassName()}
        style={{ pointerEvents: isLocked ? "none" : "auto" }}
      >
        {carsCompact && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "5px 10px",
              flexWrap: "wrap",
              fontSize: 12,
              background: "var(--color-neutral-surface)",
              borderBottom: "1px solid var(--color-neutral-border)",
            }}
          >
            <button type="button" style={carsBtn} onClick={() => carsClaim(1000)} title="Забрать 1000 незанятых задач себе">
              📥 Забрать 1000
            </button>
            <button type="button" style={carsBtn} onClick={() => carsClaim(1000)} title="Добрать ещё к своим">
              + Ещё
            </button>
            <button type="button" style={carsBtn} onClick={() => carsRelease()} title="Освободить мои незаконченные (вернуть в общий пул)">
              ↩ Сдать мои
            </button>
            <span style={{ width: 1, height: 18, background: "var(--color-neutral-border)" }} />
            <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={!!carsSettings.hideProcessed}
                onChange={(e) => setCars({ hideProcessed: e.target.checked })}
              />
              Скрыть обработанное
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              через
              <select
                value={carsSettings.hideAfterMin}
                onChange={(e) => setCars({ hideAfterMin: Number(e.target.value) })}
              >
                <option value={3}>3</option>
                <option value={5}>5</option>
                <option value={10}>10</option>
              </select>
              мин
            </label>
            <span style={{ width: 1, height: 18, background: "var(--color-neutral-border)" }} />
            <label style={{ display: "flex", alignItems: "center", gap: 4 }} title="Когда задача получает статус «обработано»">
              Обработано при:
              <select value={carsSettings.markOn} onChange={(e) => setCars({ markOn: e.target.value })}>
                <option value="edits">правках</option>
                <option value="open">открытии</option>
              </select>
            </label>
          </div>
        )}
        {renderContent(content)}
      </div>
    );
  },
);
