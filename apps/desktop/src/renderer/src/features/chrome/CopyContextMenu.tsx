import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { copyText } from "../../lib/copy-text";

export type CopyContextMenuPosition = {
  x: number;
  y: number;
  anchorTop?: number;
};

export type CopyContextMenuTarget = {
  label: string;
  value: string;
  separated?: boolean;
};

type CopyContextMenuProps = {
  onClose: () => void;
  position: CopyContextMenuPosition;
  targets: CopyContextMenuTarget[];
};

export function CopyContextMenu(props: CopyContextMenuProps) {
  const { onClose, position: requestedPosition, targets } = props;
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({
    x: requestedPosition.x,
    y: requestedPosition.y,
  });

  useEffect(() => {
    const closeOnClick = (): void => onClose();
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("click", closeOnClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeOnClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }

    setPosition(placeContextMenu(requestedPosition, menu.getBoundingClientRect()));
    menu.querySelector<HTMLButtonElement>("button")?.focus();
  }, [requestedPosition]);

  const copy = (value: string): void => {
    onClose();
    void copyText(value);
  };

  return createPortal(
    <div
      ref={menuRef}
      className="thread-context-menu chip-copy-context-menu"
      role="menu"
      style={{ left: position.x, top: position.y }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="thread-context-menu__section">
        {targets.map((target) => (
          <div key={target.label}>
            {target.separated ? (
              <div className="thread-context-menu__separator" role="separator" />
            ) : null}
            <button
              role="menuitem"
              type="button"
              onClick={() => copy(target.value)}
            >
              {target.label}
            </button>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

function placeContextMenu(
  requestedPosition: CopyContextMenuPosition,
  menuRect: DOMRect,
): { x: number; y: number } {
  const viewportMargin = 8;
  const triggerGap = 4;
  const menuWidth = menuRect.width || 220;
  const menuHeight = menuRect.height;
  const maxX = window.innerWidth - menuWidth - viewportMargin;
  const maxY = window.innerHeight - menuHeight - viewportMargin;
  const wouldOverflowBottom =
    menuHeight > 0
    && requestedPosition.y + menuHeight + viewportMargin > window.innerHeight;
  const flippedTop = requestedPosition.anchorTop !== undefined
    ? requestedPosition.anchorTop - menuHeight - triggerGap
    : requestedPosition.y - menuHeight - triggerGap;

  return {
    x: Math.max(viewportMargin, Math.min(requestedPosition.x, maxX)),
    y: Math.max(
      viewportMargin,
      Math.min(wouldOverflowBottom ? flippedTop : requestedPosition.y, maxY),
    ),
  };
}
