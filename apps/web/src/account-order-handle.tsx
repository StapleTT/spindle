import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './brand.js';
import { menu } from './icons.js';

type Drag = {
  list: HTMLElement;
  accountIds: string[];
  pointerId: number;
  x: number;
  y: number;
  startY: number;
  moved: boolean;
};

function dropTarget(drag: Drag, id: string) {
  const bounds = drag.list.getBoundingClientRect();
  if (
    !drag.moved ||
    drag.x < bounds.left ||
    drag.x > bounds.right ||
    drag.y < bounds.top ||
    drag.y > bounds.bottom
  )
    return null;
  const rows = [
    ...drag.list.querySelectorAll<HTMLElement>('[data-account-id]'),
  ].filter((row) => row.dataset.accountId !== id);
  const before = rows.findIndex((row) => {
    const rect = row.getBoundingClientRect();
    return drag.y < rect.top + rect.height / 2;
  });
  const index = before < 0 ? rows.length : before;
  const row = rows[index] ?? rows.at(-1);
  if (!row || index === drag.accountIds.indexOf(id)) return null;
  const rect = row.getBoundingClientRect();
  return {
    index,
    left: bounds.left + 12,
    top: before < 0 ? rect.bottom : rect.top,
    width: bounds.width - 24,
  };
}

export function AccountOrderHandle({
  id,
  name,
  accountIds,
  disabled,
  onOrder,
}: {
  id: string;
  name: string;
  accountIds: string[];
  disabled: boolean;
  onOrder: (
    accountIds: string[],
    expectedAccountIds: string[],
  ) => Promise<void>;
}) {
  const handle = useRef<HTMLButtonElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  const [marker, setMarker] = useState<ReturnType<typeof dropTarget>>(null);

  useEffect(() => {
    if (!dragging) return;
    let frame: number;
    function update() {
      const current = drag.current;
      if (!current) return;
      const scroller = current.list.closest<HTMLElement>('.settings-body');
      if (scroller && current.moved) {
        const rect = scroller.getBoundingClientRect();
        const bounds = current.list.getBoundingClientRect();
        if (current.x >= bounds.left && current.x <= bounds.right) {
          const scroll =
            current.y < rect.top + 44
              ? -12
              : current.y > rect.bottom - 44
                ? 12
                : 0;
          scroller.scrollTop += scroll;
        }
      }
      setMarker(dropTarget(current, id));
      frame = requestAnimationFrame(update);
    }
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [dragging, id]);

  function cancel() {
    drag.current = null;
    setDragging(false);
    setMarker(null);
  }

  async function moveTo(index: number, expected = accountIds) {
    if (
      disabled ||
      index < 0 ||
      index >= expected.length ||
      index === expected.indexOf(id)
    )
      return;
    const ordered = expected.filter((account) => account !== id);
    ordered.splice(index, 0, id);
    const focused = document.activeElement === handle.current;
    await onOrder(ordered, expected);
    // Moving the focused DOM row can put focus on body after React commits.
    requestAnimationFrame(() => {
      if (focused && document.activeElement === document.body)
        handle.current?.focus({ preventScroll: true });
    });
  }

  return (
    <>
      <button
        ref={handle}
        type="button"
        className="icon-button account-drag-handle"
        aria-label={`Reorder ${name}`}
        aria-describedby="account-order-instructions"
        aria-keyshortcuts="ArrowUp ArrowDown"
        aria-disabled={disabled}
        data-dragging={dragging || undefined}
        title="Drag to reorder"
        onPointerDown={(event) => {
          if (disabled || event.button !== 0 || !event.isPrimary) return;
          const list = event.currentTarget.closest<HTMLElement>(
            '[aria-label="Connected accounts"]',
          );
          if (!list) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            list,
            accountIds,
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            startY: event.clientY,
            moved: false,
          };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || current.pointerId !== event.pointerId) return;
          current.x = event.clientX;
          current.y = event.clientY;
          current.moved ||= Math.abs(event.clientY - current.startY) >= 4;
        }}
        onPointerUp={(event) => {
          const current = drag.current;
          if (!current || current.pointerId !== event.pointerId) return;
          current.x = event.clientX;
          current.y = event.clientY;
          const target = dropTarget(current, id);
          cancel();
          if (target) void moveTo(target.index, current.accountIds);
        }}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            cancel();
          } else if (
            !drag.current &&
            (event.key === 'ArrowUp' || event.key === 'ArrowDown')
          ) {
            event.preventDefault();
            void moveTo(
              accountIds.indexOf(id) + (event.key === 'ArrowUp' ? -1 : 1),
            );
          }
        }}
      >
        <Icon src={menu} />
      </button>
      {marker &&
        createPortal(
          <div
            className="account-drop-marker"
            aria-hidden="true"
            style={{ left: marker.left, top: marker.top, width: marker.width }}
          />,
          document.body,
        )}
    </>
  );
}
