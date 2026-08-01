import type { PrSummary } from "@pwragent/shared";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { copyText } from "../../lib/copy-text";

type ContextMenuPosition = {
  x: number;
  y: number;
  anchorTop?: number;
};

type PrChipContextMenuProps = {
  onClose: () => void;
  position: ContextMenuPosition;
  pr: PrSummary;
};

type CopyTarget = {
  label: string;
  value: string;
  separated?: boolean;
};

export function PrChipContextMenu(props: PrChipContextMenuProps) {
  const { onClose, position: requestedPosition, pr } = props;
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({
    x: requestedPosition.x,
    y: requestedPosition.y,
  });
  const targets = useMemo(() => pullRequestCopyTargets(pr), [pr]);

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
      className="thread-context-menu pr-chip-context-menu"
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

export function pullRequestCopyTargets(pr: PrSummary): CopyTarget[] {
  const urls = pullRequestUrls(pr);
  const targets: CopyTarget[] = [];

  if (urls.fullUrl !== urls.pullRequestUrl) {
    targets.push({
      label: fullUrlCopyLabel(urls.fullUrl),
      value: urls.fullUrl,
    });
  }

  targets.push(
    {
      label: "Copy Pull Request URL",
      value: urls.pullRequestUrl,
      separated: targets.length > 0,
    },
    {
      label: "Copy Pull Request Number",
      value: String(pr.number),
    },
    {
      label: "Copy Repository URL",
      value: urls.repositoryUrl,
    },
  );

  return targets;
}

function pullRequestUrls(pr: PrSummary): {
  fullUrl: string;
  pullRequestUrl: string;
  repositoryUrl: string;
} {
  try {
    const full = new URL(pr.url);
    const segments = full.pathname.split("/").filter(Boolean);
    const markerIndex = segments.findIndex(
      (segment) => segment === "pull" || segment === "merge_requests",
    );
    const numberIndex = markerIndex + 1;
    if (
      markerIndex >= 0
      && segments[numberIndex] === String(pr.number)
    ) {
      const repositoryEnd = segments[markerIndex - 1] === "-"
        ? markerIndex - 1
        : markerIndex;
      return {
        fullUrl: pr.url,
        pullRequestUrl: urlWithPath(full, segments.slice(0, numberIndex + 1)),
        repositoryUrl: urlWithPath(full, segments.slice(0, repositoryEnd)),
      };
    }
  } catch {
    // Fall back to the provider + identity fields below.
  }

  const repositoryUrl = `https://${pr.provider}/${encodeURIComponent(pr.org)}/${encodeURIComponent(pr.repo)}`;
  return {
    fullUrl: pr.url,
    pullRequestUrl: pr.url,
    repositoryUrl,
  };
}

function urlWithPath(source: URL, segments: string[]): string {
  const target = new URL(source.origin);
  target.pathname = `/${segments.join("/")}`;
  return target.toString().replace(/\/$/, "");
}

function fullUrlCopyLabel(url: string): string {
  try {
    const parsed = new URL(url);
    if (/^#(?:discussion_r|issuecomment-)\d+$/i.test(parsed.hash)) {
      return "Copy Full Comment URL";
    }
    if (/^#pullrequestreview-\d+$/i.test(parsed.hash)) {
      return "Copy Full Review URL";
    }
    if (parsed.pathname.split("/").includes("files")) {
      return "Copy Full Code Review URL";
    }
  } catch {
    // A malformed provider URL still remains copyable as the full link.
  }
  return "Copy Full Link URL";
}

function placeContextMenu(
  requestedPosition: ContextMenuPosition,
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
