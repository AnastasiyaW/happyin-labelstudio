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
