import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { copyText } from "../../lib/copy-text";

export type ChipContextMenuPosition = {
  x: number;
  y: number;
  anchorTop?: number;
};

type ChipContextMenuCopyItem = {
  action?: never;
  copyValue: string;
  label: string;
  separated?: boolean;
};

type ChipContextMenuActionItem = {
  action: () => void;
  copyValue?: never;
  label: string;
  separated?: boolean;
};

export type ChipContextMenuItem =
  | ChipContextMenuCopyItem
  | ChipContextMenuActionItem;

type ChipContextMenuProps = {
  className?: string;
  items: ChipContextMenuItem[];
  onClose: () => void;
  position: ChipContextMenuPosition;
  returnFocusTo: HTMLElement;
};

export function ChipContextMenu(props: ChipContextMenuProps) {
  const { items, onClose, position: requestedPosition, returnFocusTo } = props;
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({
    x: requestedPosition.x,
    y: requestedPosition.y,
  });

  const close = useCallback((restoreFocus: boolean): void => {
    onClose();
    if (restoreFocus && returnFocusTo.isConnected) {
      returnFocusTo.focus({ preventScroll: true });
    }
  }, [onClose, returnFocusTo]);

  useEffect(() => {
    const closeOnClick = (): void => close(false);
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close(true);
      }
    };
    const closeOnContextMenu = (): void => close(false);

    window.addEventListener("click", closeOnClick);
    window.addEventListener("contextmenu", closeOnContextMenu, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeOnClick);
      window.removeEventListener("contextmenu", closeOnContextMenu, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [close]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }

    setPosition(placeContextMenu(requestedPosition, menu.getBoundingClientRect()));
    menu.querySelector<HTMLButtonElement>("button")?.focus();
  }, [requestedPosition]);

  const select = (item: ChipContextMenuItem): void => {
    close(true);
    if (item.action) {
      item.action();
      return;
    }

    void copyText(item.copyValue);
  };

  return createPortal(
    <div
      ref={menuRef}
      className={[
        "thread-context-menu chip-context-menu",
        props.className,
      ].filter(Boolean).join(" ")}
      role="menu"
      style={{ left: position.x, top: position.y }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="thread-context-menu__section">
        {items.map((item, index) => (
          <div key={`${item.label}:${index}`}>
            {item.separated ? (
              <div className="thread-context-menu__separator" role="separator" />
            ) : null}
            <button
              role="menuitem"
              type="button"
              onClick={() => select(item)}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

function placeContextMenu(
  requestedPosition: ChipContextMenuPosition,
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
