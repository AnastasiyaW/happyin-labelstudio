import { observer } from "mobx-react";
import { types } from "mobx-state-tree";

import BaseTool from "./Base";
import ToolMixin from "../mixins/Tool";
import Canvas from "../utils/canvas";
import { clamp, findClosestParent } from "../utils/utilities";
import { DrawingTool } from "../mixins/DrawingTool";
import { Tool } from "../components/Toolbar/Tool";
import { Range } from "../common/Range/Range";
import { NodeViews } from "../components/Node/Node";

const MIN_SIZE = 1;
const MAX_SIZE = 50;

const IconDot = ({ size }) => {
  return (
    <span
      style={{
        display: "block",
        width: size,
        height: size,
        background: "rgba(0, 0, 0, 0.25)",
        borderRadius: "100%",
      }}
    />
  );
};

const ToolView = observer(({ item }) => {
  return (
    <Tool
      label="Brush"
      ariaLabel="brush-tool"
      active={item.selected}
      shortcut={item.shortcut}
      extraShortcuts={item.extraShortcuts}
      icon={item.iconClass}
      tool={item}
      onClick={() => {
        if (item.selected) return;

        item.manager.selectTool(item, true);
      }}
      controls={item.controls}
    />
  );
});

const _Tool = types
  .model("BrushTool", {
    strokeWidth: types.optional(types.number, 15),
    group: "segmentation",
    shortcut: "tool:brush",
    smart: true,
    unselectRegionOnToolChange: false,
  })
  .volatile(() => ({
    canInteractWithRegions: false,
  }))
  .views((self) => ({
    get viewClass() {
      return () => <ToolView item={self} />;
    },
    get iconComponent() {
      return self.dynamic ? NodeViews.BrushRegionModel.altIcon : NodeViews.BrushRegionModel.icon;
    },
    get tagTypes() {
      return {
        stateTypes: "brushlabels",
        controlTagTypes: ["brushlabels", "brush"],
      };
    },
    get controls() {
      return [
        <Range
          key="brush-size"
          value={self.strokeWidth}
          min={MIN_SIZE}
          max={MAX_SIZE}
          reverse
          align="vertical"
          minIcon={<IconDot size={8} />}
          maxIcon={<IconDot size={16} />}
          onChange={(value) => {
            self.setStroke(value);
          }}
        />,
      ];
    },
    get extraShortcuts() {
      return {
        "tool:decrease-tool": [
          "Decrease size",
          () => {
            self.setStroke(clamp(self.strokeWidth - 5, MIN_SIZE, MAX_SIZE));
          },
        ],
        "tool:increase-tool": [
          "Increase size",
          () => {
            self.setStroke(clamp(self.strokeWidth + 5, MIN_SIZE, MAX_SIZE));
          },
        ],
      };
    },
  }))
  .actions((self) => {
    let brush;
    let isFirstBrushStroke;
    // cars-mods: track regions touched by cross-layer eraser (Ctrl+Alt+drag)
    let crossEraseTargets = null;
    // cars-mods: track last drawn region for post-paint relabel via digit keys
    let lastDrawnRegion = null;
    let lastDrawnTimer = null;

    function bboxHit(region, x, y) {
      const bb = region.bboxCoordsCanvas;
      if (!bb) return false;
      return x >= bb.left && x <= bb.right && y >= bb.top && y <= bb.bottom;
    }

    function setLastDrawn(region) {
      lastDrawnRegion = region;
      if (lastDrawnTimer) clearTimeout(lastDrawnTimer);
      // 5s window — after that, digit keys do nothing (avoid surprises)
      lastDrawnTimer = setTimeout(() => {
        lastDrawnRegion = null;
      }, 5000);
    }

    return {
      // cars-mods: expose for global keydown handler to relabel by index
      relabelLastDrawnByIndex(labelIdx) {
        if (!lastDrawnRegion) return false;
        const c = self.control;
        const labels = c?.tiedChildren ?? [];
        if (labelIdx < 0 || labelIdx >= labels.length) return false;
        try {
          labels.forEach((l, i) => l.setSelected(i === labelIdx));
          lastDrawnRegion.setValue?.(c);
          return true;
        } catch (_) {
          return false;
        }
      },

      // cars-mods: force-commit current draw + deselect → next stroke = new region.
      forceCommitNewRegion() {
        try {
          if (self.currentArea && self.mode !== "drawing") {
            // Not currently drawing — just deselect so next stroke creates new region
            self.obj?.annotation?.unselectAll?.();
            return;
          }
        } catch (_) {}
        try {
          self.obj?.annotation?.unselectAll?.();
        } catch (_) {}
      },

      commitDrawingRegion() {
        const { currentArea, control, obj } = self;
        const source = currentArea.toJSON();

        const value = { coordstype: "px", touches: source.touches, dynamic: source.dynamic };
        const newArea = self.annotation.createResult(value, currentArea.results[0].value.toJSON(), control, obj);

        currentArea.setDrawing(false);
        self.applyActiveStates(newArea);
        self.deleteRegion();
        newArea.notifyDrawingFinished();
        return newArea;
      },

      setStroke(val) {
        self.strokeWidth = val;
        self.updateCursor();
      },

      afterUpdateSelected() {
        self.updateCursor();
      },

      addPoint(x, y) {
        brush.addPoint(Math.floor(x), Math.floor(y));
      },

      mouseupEv(_ev, _, [x, y]) {
        // cars-mods: cross-layer erase finalize — close all eraser paths on multiple regions
        if (crossEraseTargets && crossEraseTargets.length) {
          const xi = Math.floor(x);
          const yi = Math.floor(y);
          crossEraseTargets.forEach((r) => {
            try {
              r.addPoint(xi, yi);
              r.setDrawing(false);
              r.endPath();
            } catch (_) {}
          });
          crossEraseTargets = null;
          self.mode = "viewing";
          try {
            self.annotation.history.unfreeze();
          } catch (_) {}
          self.obj?.annotation?.setIsDrawing(false);
          return;
        }
        if (self.mode !== "drawing") return;

        // cars-mods (v40): capture currently active label indices BEFORE commit.
        // Used to re-apply same label after region creation — "sticky label" workflow:
        // user picks label once, can draw multiple regions in sequence without re-clicking.
        const stickyLabelIndices = (() => {
          try {
            const c = self.control;
            return (c?.tiedChildren ?? [])
              .map((l, i) => (l?.selected ? i : -1))
              .filter((i) => i >= 0);
          } catch (_) {
            return [];
          }
        })();

        self.addPoint(x, y);
        self.mode = "viewing";
        brush.setDrawing(false);
        brush.endPath();
        if (isFirstBrushStroke) {
          setTimeout(() => {
            const newBrush = self.commitDrawingRegion();

            self.obj.annotation.selectArea(newBrush);
            self.annotation.history.unfreeze();
            self.obj.annotation.setIsDrawing(false);
            // cars-mods: remember for digit-key relabel
            setLastDrawn(newBrush);
            // cars-mods (v40): re-apply sticky label so next stroke uses same class
            // without re-clicking. If selectArea changed the active label set,
            // this restores it; otherwise it's a safe no-op.
            try {
              if (stickyLabelIndices.length > 0) {
                const c = self.control;
                const labels = c?.tiedChildren ?? [];
                labels.forEach((l, i) => {
                  const should = stickyLabelIndices.includes(i);
                  if (should && !l?.selected) l?.setSelected?.(true);
                });
              }
            } catch (_) {}
          });
        } else {
          self.annotation.history.unfreeze();
          self.obj.annotation.setIsDrawing(false);
          // cars-mods: continued stroke on existing region — also track for relabel
          setLastDrawn(brush);
        }
      },

      mousemoveEv(ev, _, [x, y]) {
        if (!self.isAllowedInteraction(ev)) return;
        // cars-mods: cross-layer erase — forward to all targets
        if (crossEraseTargets && crossEraseTargets.length) {
          if (
            !findClosestParent(
              ev.target,
              (el) => el === self.obj.stageRef.content,
              (el) => el.parentElement,
            )
          )
            return;
          const xi = Math.floor(x);
          const yi = Math.floor(y);
          crossEraseTargets.forEach((r) => {
            try {
              r.addPoint(xi, yi);
            } catch (_) {}
          });
          return;
        }
        if (self.mode !== "drawing") return;
        if (
          !findClosestParent(
            ev.target,
            (el) => el === self.obj.stageRef.content,
            (el) => el.parentElement,
          )
        )
          return;

        self.addPoint(x, y);
      },

      mousedownEv(ev, _, [x, y]) {
        if (!self.isAllowedInteraction(ev)) return;
        if (
          !findClosestParent(
            ev.target,
            (el) => el === self.obj.stageRef.content,
            (el) => el.parentElement,
          )
        )
          return;
        const c = self.control;
        const o = self.obj;

        // cars-mods: Photoshop-style modifier semantics
        // Alt (alone)        = temporary eraser on selected region
        // Ctrl+Alt           = cross-layer eraser (erase through all overlapping regions)
        // No modifier        = paint (default)
        const isAltErase = ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey;
        const isCrossErase = ev.altKey && (ev.ctrlKey || ev.metaKey) && !ev.shiftKey;

        if (isCrossErase) {
          // Find all brushregions whose bbox covers cursor (cheap filter).
          // Note: agent recommended pixel-precise sampling via maskImage; here we use
          // bbox-only for simplicity + performance. Acceptable for stones overlapping
          // multiple regions where bbox already implies overlap.
          const allRegions = (self.annotation?.regions ?? []).filter(
            (r) => r.type === "brushregion" && !r.hidden && !r.locked && !r.readonly,
          );
          const hits = allRegions.filter((r) => bboxHit(r, x, y));
          if (!hits.length) return;
          try { window.carsAudit?.("brush.cross-erase-start", { hitCount: hits.length }); } catch (_) {}
          self.annotation.history.freeze();
          self.mode = "drawing";
          self.obj.annotation.setIsDrawing(true);
          crossEraseTargets = hits;
          const sw = self.strokeWidth || c.strokeWidth;
          const xi = Math.floor(x);
          const yi = Math.floor(y);
          hits.forEach((r) => {
            try {
              r.setDrawing(true);
              r.beginPath({ type: "eraser", strokeWidth: sw });
              r.addPoint(xi, yi);
            } catch (_) {}
          });
          return;
        }

        brush = self.getSelectedShape;

        // prevent drawing when current image is
        // different from image where the brush was started
        if (o && brush && o.multiImage && o.currentImage !== brush.item_index) return;

        // Reset the timer if a user started drawing again
        if (brush && brush.type === "brushregion") {
          self.annotation.history.freeze();
          self.mode = "drawing";
          brush.setDrawing(true);
          self.obj.annotation.setIsDrawing(true);
          isFirstBrushStroke = false;
          brush.beginPath({
            type: isAltErase ? "eraser" : "add",
            strokeWidth: self.strokeWidth || c.strokeWidth,
          });
          try { window.carsAudit?.(isAltErase ? "brush.alt-erase-start" : "brush.continue-stroke", { regionId: brush.id }); } catch (_) {}

          self.addPoint(x, y);
        } else {
          // No selected brush region.
          // cars-mods: if Alt held but no region selected — silently no-op
          // (don't create phantom region just to erase nothing).
          if (isAltErase) return;
          if (!self.canStartDrawing()) return;
          if (self.tagTypes.stateTypes === self.control.type && !self.control.isSelected) return;
          self.annotation.history.freeze();
          self.mode = "drawing";
          isFirstBrushStroke = true;
          self.obj.annotation.setIsDrawing(true);
          brush = self.createDrawingRegion({
            touches: [],
            coordstype: "px",
          });

          brush.beginPath({
            type: "add",
            strokeWidth: self.strokeWidth || c.strokeWidth,
          });
          try { window.carsAudit?.("brush.new-region-start"); } catch (_) {}

          self.addPoint(x, y);
        }
      },
    };
  });

const BrushCursorMixin = types
  .model("BrushCursorMixin")
  .views((self) => ({
    get cursorStyleRule() {
      const val = self.strokeWidth;
      return Canvas.createBrushSizeCircleCursor(val);
    },
  }))
  .actions((self) => ({
    updateCursor() {
      if (!self.selected || !self.obj?.stageRef) return;
      const stage = self.obj.stageRef;
      stage.container().style.cursor = self.cursorStyleRule;
    },
  }));

const Brush = types.compose(_Tool.name, ToolMixin, BaseTool, DrawingTool, BrushCursorMixin, _Tool);

export { Brush, BrushCursorMixin };
