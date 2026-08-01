import type { PrSummary } from "@pwragent/shared";
import {
  ChipContextMenu,
  type ChipContextMenuItem,
  type ChipContextMenuPosition,
} from "../chrome/ChipContextMenu";

type PrChipContextMenuProps = {
  onClose: () => void;
  position: ChipContextMenuPosition;
  pr: PrSummary;
  returnFocusTo: HTMLElement;
};

export function PrChipContextMenu(props: PrChipContextMenuProps) {
  return (
    <ChipContextMenu
      items={pullRequestCopyTargets(props.pr)}
      onClose={props.onClose}
      position={props.position}
      returnFocusTo={props.returnFocusTo}
    />
  );
}

export function pullRequestCopyTargets(pr: PrSummary): ChipContextMenuItem[] {
  const urls = pullRequestUrls(pr);
  const targets: ChipContextMenuItem[] = [];

  if (urls.fullUrl !== urls.pullRequestUrl) {
    targets.push({
      label: fullUrlCopyLabel(urls.fullUrl),
      copyValue: urls.fullUrl,
    });
  }

  targets.push(
    {
      label: "Copy Pull Request URL",
      copyValue: urls.pullRequestUrl,
      separated: targets.length > 0,
    },
    {
      label: "Copy Pull Request Number",
      copyValue: String(pr.number),
    },
    {
      label: "Copy Repository URL",
      copyValue: urls.repositoryUrl,
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
    const markerIndex = findPullRequestMarkerIndex(segments, pr.number);
    const numberIndex = markerIndex + 1;
    if (markerIndex >= 0) {
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

function findPullRequestMarkerIndex(
  segments: string[],
  pullRequestNumber: number,
): number {
  const numberText = String(pullRequestNumber);
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const segment = segments[index];
    if (
      (segment === "pull" || segment === "merge_requests")
      && segments[index + 1] === numberText
    ) {
      return index;
    }
  }
  return -1;
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
