import { useState } from "react";
import type { EditGroupCommitState } from "@pwragent/shared";
import { copyText } from "../../lib/copy-text";

/**
 * Git lifecycle badge for an accumulated edited-file group: uncommitted
 * (the "unread"/active state) → committed, with a copyable short-SHA chip and
 * a pushed/local indicator. Renders nothing until the commit state resolves,
 * so a freshly committed group doesn't flash "uncommitted" first.
 */
export function EditGroupCommitBadge(props: { state?: EditGroupCommitState }) {
  const { state } = props;
  if (!state) {
    return null;
  }

  if (!state.committed) {
    return (
      <span className="edit-commit-badge edit-commit-badge--uncommitted">
        Uncommitted
      </span>
    );
  }

  return (
    <span className="edit-commit-badge edit-commit-badge--committed">
      <span className="edit-commit-badge__label">Committed</span>
      {state.commitSha && state.shortSha ? (
        <CommitShaChip sha={state.commitSha} shortSha={state.shortSha} />
      ) : null}
      {state.pushed === undefined ? null : (
        <span
          className={`edit-commit-badge__push edit-commit-badge__push--${
            state.pushed ? "pushed" : "local"
          }`}
        >
          {state.pushed ? "Pushed" : "Local"}
        </span>
      )}
    </span>
  );
}

function CommitShaChip(props: { sha: string; shortSha: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="edit-commit-badge__sha"
      title={`Copy commit ${props.sha}`}
      aria-label={`Copy commit ${props.sha}`}
      onClick={(event) => {
        // The badge sits beside (not inside) the group toggle, but stop
        // propagation anyway so a future wrapping handler can't swallow it.
        event.stopPropagation();
        void copyText(props.sha).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <code className="edit-commit-badge__sha-value">{props.shortSha}</code>
      <span className="edit-commit-badge__sha-action" aria-hidden="true">
        {copied ? "Copied" : "Copy"}
      </span>
    </button>
  );
}
