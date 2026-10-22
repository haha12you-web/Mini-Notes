import clsx from "clsx";
import { ArrowRight, GripVertical } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { NoteSummary } from "../shared";

type DropTarget = { anchorId: string; beforeId: string | null; after: boolean; horizontal: boolean };
type PointerDrag = { id: string; pointerId: number; startX: number; startY: number; x: number; y: number; active: boolean };
type Props = {
  records: NoteSummary[];
  onOpen: (record: NoteSummary) => void;
  onMove: (id: string, beforeId: string | null) => void;
  renderIcon: (record: NoteSummary) => ReactNode;
  describe: (record: NoteSummary) => string;
};

const DRAG_THRESHOLD = 6;
const SCROLL_EDGE = 56;
const MAX_SCROLL_STEP = 14;

export function NotesOverviewGrid({ records, onOpen, onMove, renderIcon, describe }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<PointerDrag | null>(null);
  const targetRef = useRef<DropTarget | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [announcement, setAnnouncement] = useState("");

  function updateTarget(next: DropTarget | null) {
    targetRef.current = next;
    setTarget((current) => current?.anchorId === next?.anchorId && current?.after === next?.after && current?.horizontal === next?.horizontal ? current : next);
  }

  function cancelDrag() {
    dragRef.current = null;
    setDraggedId(null);
    updateTarget(null);
  }

  function locateTarget(x: number, y: number) {
    const grid = gridRef.current;
    const drag = dragRef.current;
    if (!grid || !drag?.active) return;
    const bounds = grid.getBoundingClientRect();
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) {
      updateTarget(null);
      return;
    }
    const cards = [...grid.querySelectorAll<HTMLElement>("[data-overview-record-id]")];
    let nearest: HTMLElement | null = null;
    let distance = Infinity;
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      const dx = Math.max(rect.left - x, 0, x - rect.right);
      const dy = Math.max(rect.top - y, 0, y - rect.bottom);
      const nextDistance = dx * dx + dy * dy;
      if (nextDistance < distance) {
        nearest = card;
        distance = nextDistance;
      }
    }
    const anchorId = nearest?.dataset.overviewRecordId;
    if (!nearest || !anchorId || anchorId === drag.id) {
      updateTarget(null);
      return;
    }
    const rect = nearest.getBoundingClientRect();
    const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").length;
    const after = columns > 1 ? x >= rect.left + rect.width / 2 : y >= rect.top + rect.height / 2;
    const siblings = records.filter((record) => record.id !== drag.id);
    const index = siblings.findIndex((record) => record.id === anchorId);
    updateTarget({ anchorId, beforeId: after ? siblings[index + 1]?.id ?? null : anchorId, after, horizontal: columns <= 1 });
  }

  useEffect(() => {
    if (!draggedId) return;
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelDrag();
        setAnnouncement("已取消排序");
      }
    }
    function onBlur() { cancelDrag(); }
    let scrollElement: HTMLElement | null = gridRef.current?.parentElement ?? null;
    while (scrollElement && !/(auto|scroll)/.test(getComputedStyle(scrollElement).overflowY)) {
      scrollElement = scrollElement.parentElement;
    }
    const scroller = scrollElement ?? document.scrollingElement as HTMLElement | null;
    let frame = 0;
    function scroll() {
      const drag = dragRef.current;
      if (!drag?.active || !scroller) return;
      const bounds = scroller === document.scrollingElement
        ? { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth }
        : scroller.getBoundingClientRect();
      if (drag.x >= bounds.left && drag.x <= bounds.right && drag.y >= bounds.top && drag.y <= bounds.bottom) {
        const top = Math.max(0, (SCROLL_EDGE - (drag.y - bounds.top)) / SCROLL_EDGE);
        const bottom = Math.max(0, (SCROLL_EDGE - (bounds.bottom - drag.y)) / SCROLL_EDGE);
        const previous = scroller.scrollTop;
        scroller.scrollTop += (bottom - top) * MAX_SCROLL_STEP;
        if (scroller.scrollTop !== previous) locateTarget(drag.x, drag.y);
      }
      frame = requestAnimationFrame(scroll);
    }
    frame = requestAnimationFrame(scroll);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [draggedId, records]);

  function startDrag(event: PointerEvent<HTMLButtonElement>, record: NoteSummary) {
    if (event.button !== 0 || !event.isPrimary) return;
    event.stopPropagation();
    dragRef.current = {
      id: record.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, active: false
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function continueDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < DRAG_THRESHOLD) return;
    event.preventDefault();
    if (!drag.active) {
      drag.active = true;
      setDraggedId(drag.id);
      setAnnouncement(`正在移动${records.find((record) => record.id === drag.id)?.title ?? "项目"}`);
    }
    locateTarget(drag.x, drag.y);
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const destination = targetRef.current;
    cancelDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled && drag.active && destination) {
      onMove(drag.id, destination.beforeId);
      setAnnouncement("顺序已调整");
    }
  }

  function moveWithKeyboard(event: KeyboardEvent<HTMLButtonElement>, record: NoteSummary) {
    const index = records.findIndex((item) => item.id === record.id);
    let nextIndex = index;
    const columns = gridRef.current ? getComputedStyle(gridRef.current).gridTemplateColumns.split(" ").length : 1;
    if (event.key === "ArrowLeft") nextIndex--;
    else if (event.key === "ArrowRight") nextIndex++;
    else if (event.key === "ArrowUp") nextIndex -= columns;
    else if (event.key === "ArrowDown") nextIndex += columns;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = records.length - 1;
    else return;
    event.preventDefault();
    nextIndex = Math.max(0, Math.min(records.length - 1, nextIndex));
    if (nextIndex === index) return;
    const siblings = records.filter((item) => item.id !== record.id);
    onMove(record.id, siblings[nextIndex]?.id ?? null);
    setAnnouncement(`${record.title}已移到第${nextIndex + 1}个位置`);
  }

  return (
    <div className={clsx("notes-overview__grid", draggedId && "is-sorting")} ref={gridRef}>
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
      {records.map((record) => (
        <div
          className={clsx("notes-overview-card", record.kind === "category" ? "category" : "page-link",
            draggedId === record.id && "is-dragging",
            target?.anchorId === record.id && (target.after ? "sort-after" : "sort-before"),
            target?.anchorId === record.id && target.horizontal && "sort-horizontal")}
          data-overview-record-id={record.id}
          key={record.id}
        >
          <button
            className="notes-overview-card__open"
            onClick={() => onOpen(record)}
            type="button"
          >
            <span className={clsx("notes-overview-card__icon", record.kind === "page" && "page-icon")}>{renderIcon(record)}</span>
            <span className="notes-overview-card__copy">
              <strong>{record.title || (record.kind === "category" ? "未命名分类" : "未命名")}</strong>
              <small>{describe(record)}</small>
            </span>
            <ArrowRight className="notes-overview-card__arrow" size={17} />
          </button>
          <button
            aria-label={`调整顺序：${record.title || "未命名"}`}
            aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home End"
            className="notes-overview-card__drag"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => moveWithKeyboard(event, record)}
            onLostPointerCapture={() => { if (dragRef.current?.id === record.id) cancelDrag(); }}
            onPointerCancel={(event) => finishDrag(event, true)}
            onPointerDown={(event) => startDrag(event, record)}
            onPointerMove={continueDrag}
            onPointerUp={(event) => finishDrag(event)}
            title="拖动排序，或使用方向键调整位置"
            type="button"
          ><GripVertical size={18} /></button>
        </div>
      ))}
    </div>
  );
}
