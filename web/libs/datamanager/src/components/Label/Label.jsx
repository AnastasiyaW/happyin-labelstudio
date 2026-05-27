import { inject } from "mobx-react";
import { observer } from "mobx-react-lite";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { IconGearNewUI, IconChevronLeft } from "@humansignal/icons";
import { cn } from "../../utils/bem";
import { Button } from "@humansignal/ui";
import { FieldsButton } from "../Common/FieldsButton";
import { Icon } from "../Common/Icon/Icon";
import { Resizer } from "../Common/Resizer/Resizer";
import { Space } from "../Common/Space/Space";
import { DataView } from "../MainView";
import "./Label.prefix.css";

// Todo: consider renaming this file to something like LabelingWrapper as it is not a Label component
const LabelingHeader = ({ SDK, onClick, isExplorerMode }) => {
  return (
    <div className={cn("label-view").elem("header").mod({ labelStream: !isExplorerMode }).toClassName()}>
      <Space size="large">
        {SDK.interfaceEnabled("backButton") && (
          <Button
            icon={<IconChevronLeft style={{ marginRight: 4, fontSize: 16 }} />}
            type="link"
            onClick={onClick}
            style={{ fontSize: 18, padding: 0, color: "black" }}
          >
            Back
          </Button>
        )}

        {isExplorerMode ? (
          <FieldsButton multiSelect={true} icon={<Icon icon={IconGearNewUI} />} title={"Fields"} />
        ) : null}
      </Space>
    </div>
  );
};

const injector = inject(({ store }) => {
  return {
    store,
    loading: store?.loadingData,
  };
});

// cars-mods: floating "+ Новый класс" button. Prompts for label name,
// patches project.label_config XML, then reloads page so LSF picks up new label.
// Inserts <Label value="X" background="#hex" /> into FIRST control found:
// RectangleLabels → BrushLabels → PolygonLabels → Labels (priority order).
const COLOR_PALETTE = [
  "#e74c3c", "#9b59b6", "#3498db", "#1abc9c", "#2ecc71", "#f1c40f",
  "#e67e22", "#d35400", "#c0392b", "#8e44ad", "#16a085", "#27ae60",
  "#f39c12", "#2980b9", "#ff6b6b", "#48dbfb",
];

function CarsAddLabelButton({ store }) {
  const onAdd = useCallback(async () => {
    const projectId = store?.SDK?.projectId;
    if (!projectId) {
      alert("Project ID не найден");
      return;
    }
    const raw = window.prompt("Имя нового класса (например, sapphire):");
    if (!raw) return;
    const cleanValue = raw.trim().replace(/[<>"'&]/g, "");
    if (!cleanValue) {
      alert("Имя пустое или содержит запрещённые символы (< > \" ' &)");
      return;
    }
    try {
      const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
      const resp = await fetch(`/api/projects/${projectId}/`, { credentials: "same-origin" });
      if (!resp.ok) {
        alert(`Не удалось загрузить project config: HTTP ${resp.status}`);
        return;
      }
      const data = await resp.json();
      const configXml = data.label_config || "";
      const parser = new DOMParser();
      const doc = parser.parseFromString(configXml, "text/xml");
      // Detect parser errors
      const errorNode = doc.getElementsByTagName("parsererror")[0];
      if (errorNode) {
        alert("Ошибка парсинга label_config XML");
        return;
      }
      const containers = ["RectangleLabels", "BrushLabels", "PolygonLabels", "Labels"];
      let container = null;
      for (const name of containers) {
        const els = doc.getElementsByTagName(name);
        if (els.length > 0) {
          container = els[0];
          break;
        }
      }
      if (!container) {
        alert("В label_config нет контейнера для классов (RectangleLabels/BrushLabels/PolygonLabels/Labels)");
        return;
      }
      const existing = Array.from(container.getElementsByTagName("Label")).map((el) =>
        (el.getAttribute("value") || "").toLowerCase(),
      );
      if (existing.includes(cleanValue.toLowerCase())) {
        alert(`Класс "${cleanValue}" уже существует`);
        return;
      }
      // Hash → color from palette (deterministic)
      let hash = 0;
      for (let i = 0; i < cleanValue.length; i++) hash = (hash * 31 + cleanValue.charCodeAt(i)) | 0;
      const colorHex = COLOR_PALETTE[Math.abs(hash) % COLOR_PALETTE.length];
      const newLabel = doc.createElement("Label");
      newLabel.setAttribute("value", cleanValue);
      newLabel.setAttribute("background", colorHex);
      container.appendChild(newLabel);
      const newXml = new XMLSerializer().serializeToString(doc);
      const patch = await fetch(`/api/projects/${projectId}/`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
        body: JSON.stringify({ label_config: newXml }),
      });
      if (!patch.ok) {
        const err = await patch.text();
        alert(`Ошибка сохранения config: HTTP ${patch.status}\n${err.slice(0, 200)}`);
        return;
      }
      // Force-save current draft (if any) before reload
      try {
        store?.SDK?.lsf?.saveDraft?.();
      } catch (_) {}
      window.location.reload();
    } catch (e) {
      alert(`Сбой: ${e.message}`);
    }
  }, [store]);

  return (
    <button
      type="button"
      className="cars-add-label-btn"
      onClick={onAdd}
      title="Добавить новый класс в label_config проекта (станет доступен во всех task'ах)"
    >
      ➕ Новый класс
    </button>
  );
}

/**
 * @param {{store: import("../../stores/AppStore").AppStore}} param1
 */
export const Labeling = injector(
  observer(({ store, loading }) => {
    const lsfRef = useRef();
    const SDK = store?.SDK;
    const view = store?.currentView;
    const { isExplorerMode } = store;

    const isLabelStream = useMemo(() => {
      return SDK.mode === "labelstream";
    }, []);

    const closeLabeling = useCallback(() => {
      delete document.body.dataset.lsfLabeling;
      store.closeLabeling();
    }, [store]);

    const initLabeling = useCallback(() => {
      if (!SDK.lsf) SDK.initLSF(lsfRef.current);
      SDK.startLabeling();
      // Signal that labeling is active so DM shortcuts yield to editor hotkeys.
      // This is read by useShortcut() in hotkeys.ts.
      document.body.dataset.lsfLabeling = "true";
    }, []);

    useEffect(() => {
      if (!isLabelStream) SDK.on("taskSelected", initLabeling);

      return () => {
        if (!isLabelStream) SDK.off("taskSelected", initLabeling);
      };
    }, []);

    useEffect(() => {
      if ((!SDK.lsf && store.dataStore.selected) || isLabelStream) {
        initLabeling();
      }
    }, []);

    useEffect(() => {
      return () => {
        SDK.destroyLSF();
        delete document.body.dataset.lsfLabeling;
      };
    }, []);

    // cars-mods: plain ArrowUp/Down → focus prev/next task in labeling pane.
    // Bypasses default keymap (shift+arrows reserved for LSF region nudge).
    // Use SDK.lsf?.saveDraft() before switching to preserve in-progress work,
    // mirroring the canonical onRowClick flow (Table.jsx:184).
    useEffect(() => {
      const handler = (e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return; // reserve modifiers
        const ae = document.activeElement;
        const tag = ae?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || ae?.isContentEditable) return;
        const ds = store?.dataStore;
        if (!ds) return;
        const cur = ds.highlighted ?? ds.selected;
        const list = ds.list ?? [];
        const idx = list.indexOf(cur);
        const nextIdx =
          e.key === "ArrowUp"
            ? Math.max(0, idx - 1)
            : Math.min(list.length - 1, idx + 1);
        const task = list[nextIdx];
        if (!task || task === cur) {
          // already at edge — let LSF have the event
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        try {
          SDK?.lsf?.saveDraft?.();
        } catch (_) {}
        // Use canonical row-click flow so taskSelected fires reliably
        store.startLabeling(task);
      };
      document.addEventListener("keydown", handler, true);
      return () => document.removeEventListener("keydown", handler, true);
    }, [SDK, store]);

    // cars-mods: Photoshop-style brush hotkeys (v37/v38).
    // Active only when LSF is open in current tab, image labeling context, BrushLabels in config.
    // Space     → force-commit current draw + deselect → next stroke = new region (new "layer")
    // X         → swap Brush ↔ Eraser active tool (LSF toolsManager)
    // 1-9       → if recent region drawn (<5s), relabel it via tool.relabelLastDrawnByIndex
    // Skip when typing in form fields or modifier keys held.
    useEffect(() => {
      const handler = (e) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
        const ae = document.activeElement;
        const tag = ae?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || ae?.isContentEditable) return;
        const lsf = SDK?.lsf?.lsfInstance;
        if (!lsf) return;
        const ann = lsf.annotationStore?.selected;
        if (!ann) return;
        // toolsManager owns active brush instance; look it up by name.
        const findBrush = () => {
          try {
            const all = ann.toolsManager?.allTools?.() ?? [];
            return all.find((t) => /brush/i.test(t?.toolName ?? t?.constructor?.name ?? ""));
          } catch (_) {
            return null;
          }
        };
        const findEraser = () => {
          try {
            const all = ann.toolsManager?.allTools?.() ?? [];
            return all.find((t) => /erase/i.test(t?.toolName ?? t?.constructor?.name ?? ""));
          } catch (_) {
            return null;
          }
        };

        if (e.code === "Space") {
          // force-commit + deselect so next stroke creates a new region
          const brushTool = findBrush();
          if (!brushTool) return;
          e.preventDefault();
          e.stopPropagation();
          try {
            brushTool.forceCommitNewRegion?.();
            ann.unselectAll?.();
          } catch (_) {}
          return;
        }

        if (e.code === "KeyX") {
          // swap active tool: brush ↔ eraser
          const brushTool = findBrush();
          const eraserTool = findEraser();
          if (!brushTool || !eraserTool) return;
          e.preventDefault();
          e.stopPropagation();
          try {
            const tm = ann.toolsManager;
            const isErase = !!eraserTool.selected;
            (isErase ? brushTool : eraserTool).manager?.selectTool?.(isErase ? brushTool : eraserTool, true);
            // Fallback path if .manager.selectTool isn't the right API
            if (tm?.selectTool) tm.selectTool(isErase ? brushTool : eraserTool, true);
          } catch (_) {}
          return;
        }

        const digitMatch = /^Digit([1-9])$/.exec(e.code);
        if (digitMatch) {
          const idx = parseInt(digitMatch[1], 10) - 1;
          const brushTool = findBrush();
          if (!brushTool?.relabelLastDrawnByIndex) return;
          const ok = brushTool.relabelLastDrawnByIndex(idx);
          if (ok) {
            e.preventDefault();
            e.stopPropagation();
          }
          return;
        }

        // cars-mods: Delete key → delete currently selected region(s).
        // LSF default keymap binds region:delete to "backspace" only; image-region
        // users expect Delete to also work (Photoshop / common UX). We listen for
        // both and call annotation.deleteRegion (canonical API, mirrors v33 trash icon).
        if (e.code === "Delete" || e.code === "Backspace") {
          const selectedRegions = ann?.selectedRegions ?? [];
          if (!selectedRegions.length) return;
          // Snapshot — deleteRegion mutates the array.
          const targets = Array.from(selectedRegions);
          e.preventDefault();
          e.stopPropagation();
          try {
            targets.forEach((r) => {
              if (r?.locked || r?.readonly) return;
              ann.deleteRegion?.(r);
            });
          } catch (_) {}
          return;
        }
      };
      document.addEventListener("keydown", handler, true);
      return () => document.removeEventListener("keydown", handler, true);
    }, [SDK]);

    // Track which panel the user last interacted with via a data attribute
    // on document.body. When the attribute is "true", DM shortcuts (shift+left
    // to close labeling, etc.) yield so that editor hotkeys (TimeSeries pan,
    // region grow) take priority. Clicking on the DM table clears the flag
    // so DM shortcuts resume working.
    //
    // This replaces a focus-based approach that couldn't work because clicking
    // on canvas/SVG elements never moves document.activeElement away from body.
    useEffect(() => {
      const container = lsfRef.current;
      if (!container) return;

      const handleContainerPointerDown = () => {
        document.body.dataset.lsfLabeling = "true";
      };

      // When the user clicks outside the LSF container (e.g. the DM table),
      // clear the flag so DM shortcuts work again.
      const handleDocumentPointerDown = (e) => {
        if (!container.contains(e.target)) {
          document.body.dataset.lsfLabeling = "false";
        }
      };

      container.addEventListener("pointerdown", handleContainerPointerDown);
      document.addEventListener("pointerdown", handleDocumentPointerDown);

      return () => {
        container.removeEventListener("pointerdown", handleContainerPointerDown);
        document.removeEventListener("pointerdown", handleDocumentPointerDown);
        delete document.body.dataset.lsfLabeling;
      };
    }, []);

    const onResize = useCallback((width) => {
      view.setLabelingTableWidth(width);
      // trigger resize events inside LSF
      window.dispatchEvent(new Event("resize"));
    }, []);

    return (
      <div className={cn("label-view").mod({ loading }).toClassName()}>
        {SDK.interfaceEnabled("labelingHeader") && (
          <LabelingHeader SDK={SDK} onClick={closeLabeling} isExplorerMode={isExplorerMode} />
        )}

        <CarsAddLabelButton store={store} />

        <div className={cn("label-view").elem("content").toClassName()}>
          {isExplorerMode && (
            <div className={cn("label-view").elem("table").toClassName()}>
              <Resizer
                className={cn("label-view").elem("dataview").toClassName()}
                variant="quickview"
                minWidth={202}
                showResizerLine={false}
                maxWidth={window.innerWidth * 0.35}
                initialWidth={view.labelingTableWidth} // hardcoded as in main-menu-trigger
                onResizeFinished={onResize}
                style={{ display: "flex", flex: 1, width: "100%" }}
              >
                <DataView />
              </Resizer>
            </div>
          )}

          <div
            className={cn("label-view")
              .elem("lsf-wrapper")
              .mod({ mode: isExplorerMode ? "explorer" : "labeling" })
              .toClassName()}
          >
            {loading && <div className={cn("label-view").elem("waiting").mod({ animated: true }).toClassName()} />}
            <div
              ref={lsfRef}
              id="label-studio-dm"
              className={cn("label-view").elem("lsf-container").toClassName()}
              key="label-studio"
            />
          </div>
        </div>
      </div>
    );
  }),
);
