import type { PrSummary } from "@pwragent/shared";
import {
  CopyContextMenu,
  type CopyContextMenuPosition,
  type CopyContextMenuTarget,
} from "../chrome/CopyContextMenu";

type PrChipContextMenuProps = {
  onClose: () => void;
  position: CopyContextMenuPosition;
  pr: PrSummary;
};

export function PrChipContextMenu(props: PrChipContextMenuProps) {
  return (
    <CopyContextMenu
      onClose={props.onClose}
      position={props.position}
      targets={pullRequestCopyTargets(props.pr)}
    />
  );
}

export function pullRequestCopyTargets(pr: PrSummary): CopyContextMenuTarget[] {
  const urls = pullRequestUrls(pr);
  const targets: CopyContextMenuTarget[] = [];

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
