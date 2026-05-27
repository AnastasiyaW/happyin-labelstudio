import { CloseOutlined, QuestionCircleOutlined } from "@ant-design/icons";
import { Button, Checkbox, IconChevronLeft, IconChevronRight } from "@humansignal/ui";
import { observer } from "mobx-react";
import { getRoot } from "mobx-state-tree";
import type { PropsWithChildren } from "react";
import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { modal } from "../../Common/Modal/Modal";
import { Icon } from "../../Common/Icon/Icon";
import { Tooltip } from "@humansignal/ui";
import { ImagePreview } from "./ImagePreview";

import styles from "./GridPreview.module.css";

type Task = {
  id: number;
  data: Record<string, string>;
};

type GridViewContextType = {
  tasks: Task[];
  imageField: string | undefined;
  currentTaskId: number | null;
  setCurrentTaskId: (id: number | null) => void;
  hasImage: boolean;
};

type TaskModalProps = GridViewContextType & { view: any; imageField: string };

export const GridViewContext = createContext<GridViewContextType>({
  tasks: [],
  imageField: undefined,
  currentTaskId: null,
  setCurrentTaskId: () => {},
  hasImage: false,
});

const TaskModal = observer(({ view, tasks, imageField, currentTaskId, setCurrentTaskId }: TaskModalProps) => {
  const index = tasks.findIndex((task) => task.id === currentTaskId);
  const task = tasks[index];

  const goToNext = useCallback(() => {
    if (index < tasks.length - 1) {
      const next = tasks[index + 1];
      setCurrentTaskId(next.id);
      try { (window as any).carsAudit?.("preview.next", { taskId: next.id }); } catch (_) {}
    }
  }, [index, tasks]);

  const goToPrev = useCallback(() => {
    if (index > 0) {
      const prev = tasks[index - 1];
      setCurrentTaskId(prev.id);
      try { (window as any).carsAudit?.("preview.prev", { taskId: prev.id }); } catch (_) {}
    }
  }, [index, tasks]);

  const onSelect = useCallback(() => {
    if (task) {
      view.toggleSelected(task.id);
      try { (window as any).carsAudit?.("preview.select", { taskId: task.id }); } catch (_) {}
    }
  }, [task, view]);

  const onClose = useCallback(() => {
    setCurrentTaskId(null);
    try { (window as any).carsAudit?.("preview.close"); } catch (_) {}
  }, []);

  // cars-mods: open full LS labeling editor with tools (bbox/mask/brush/polygon).
  // startLabeling is canonical entry point — closes our preview modal first to avoid
  // stale references, then LS routes to /quickview/<task.id> with full toolbar.
  const onOpenEditor = useCallback(() => {
    if (!task) return;
    const root: any = getRoot(view);
    try { (window as any).carsAudit?.("preview.open-editor", { taskId: task.id }); } catch (_) {}
    onClose();
    root.startLabeling(task);
  }, [task, view, onClose]);

  // assign hotkeys
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        goToPrev();
      } else if (event.key === "ArrowRight") {
        goToNext();
      } else if (event.key === " ") {
        onSelect();
        event.preventDefault();
      } else if (event.key === "Escape") {
        onClose();
      } else if (
        event.key === "Enter" ||
        event.code === "KeyE" // layout-agnostic: physical "E" key matches both EN and RU (У) raskladka
      ) {
        // cars-mods: E / Enter → open full editor with tools
        onOpenEditor();
        event.preventDefault();
      } else {
        // pass this event through for other keys
        return;
      }

      event.stopPropagation();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [goToNext, goToPrev, onSelect, onClose, onOpenEditor]);

  if (!task) {
    return null;
  }

  const tooltip = (
    <div className={styles.tooltip}>
      <p>Preview of the task image to quickly navigate through the tasks and select the ones you want to work on.</p>
      <p>Use [arrow keys] to navigate.</p>
      <p>[Escape] to close the modal.</p>
      <p>[Space] to select/unselect the task.</p>
      <p>[E] or [Enter] to open full labeling editor with tools (bbox / mask / brush).</p>
      <p>Use [scroll] to zoom in/out and [drag] to pan around while image is zoomed in.</p>
    </div>
  );

  return (
    <div className={styles.modal}>
      <div className={styles.header}>
        <Checkbox checked={view.selected.isSelected(task.id)} onChange={onSelect}>
          Task {task.id}
        </Checkbox>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.editBtn}
            onClick={onOpenEditor}
            title="Открыть редактор с инструментами (E / Enter)"
          >
            ✎ Редактор
          </button>
          <Tooltip title={tooltip}>
            <Icon icon={QuestionCircleOutlined} />
          </Tooltip>
          <Icon icon={CloseOutlined} onClick={onClose} />
        </div>
      </div>
      <div className="grid grid-cols-[20px_1fr_20px]">
        <Button
          type="button"
          className="h-full [&_span]:aspect-auto !p-0"
          variant="primary"
          look="string"
          onClick={goToPrev}
          disabled={index === 0}
        >
          <IconChevronLeft />
        </Button>
        <ImagePreview task={task} field={imageField} />
        <Button
          type="button"
          className="h-full [&_span]:aspect-auto !p-0"
          variant="primary"
          look="string"
          onClick={goToNext}
          disabled={index === tasks.length - 1}
        >
          <IconChevronRight />
        </Button>
      </div>
    </div>
  );
});

type GridViewProviderProps = PropsWithChildren<{
  data: Task[];
  view: any;
  fields: { alias: string; currentType: string }[];
}>;

export const GridViewProvider: React.FC<GridViewProviderProps> = ({ children, data, view, fields }) => {
  const [currentTaskId, setCurrentTaskId] = useState<number | null>(null);
  const modalRef = useRef<{ update: (props: object) => void; close: () => void } | null>(null);
  const imageField = fields.find((f) => f.currentType === "Image")?.alias;
  const hasImage = fields.some((f) => f.currentType === "Image");

  const onClose = useCallback(() => {
    modalRef.current = null;
    setCurrentTaskId(null);
  }, []);

  useEffect(() => {
    if (currentTaskId === null) {
      modalRef.current?.close();
      return;
    }

    if (!imageField) return;

    const children = (
      <TaskModal
        view={view}
        tasks={data}
        imageField={imageField}
        currentTaskId={currentTaskId}
        setCurrentTaskId={setCurrentTaskId}
        hasImage={hasImage}
      />
    );

    if (!modalRef.current) {
      modalRef.current = modal({
        bare: true,
        title: "Task Preview",
        style: { width: 800 },
        children,
        onHidden: onClose,
      });
    } else {
      modalRef.current.update({ children });
    }
  }, [currentTaskId, data, onClose]);

  // close the modal when we leave the view (by browser controls or by hotkeys)
  useEffect(() => () => modalRef.current?.close(), []);

  return (
    <GridViewContext.Provider value={{ tasks: data, imageField, currentTaskId, setCurrentTaskId, hasImage }}>
      {children}
    </GridViewContext.Provider>
  );
};
