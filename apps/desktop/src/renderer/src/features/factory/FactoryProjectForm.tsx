import { useState, type FormEvent, type ReactNode } from "react";
import type { FactoryBranchSelection, FactoryProjectOption, FactoryProjectReadRequest } from "@pwragent/shared/factory-projection";
import { parseFactoryWorkItem } from "@pwragent/shared/factory-work-item";
import { Select } from "../../components/Select";

export type FactoryScope = Pick<FactoryProjectReadRequest, "projectKey" | "repository">;

const TRACKING_OPTIONS = [
  { value: "issue", label: "GitHub issue" },
  { value: "pull_request", label: "GitHub pull request" },
  { value: "jira", label: "Jira issue" },
  { value: "linear", label: "Linear issue" },
];

export function FactoryProjectForm(props: {
  projects: FactoryProjectOption[];
  busy: boolean;
  online: boolean;
  refresh: ReactNode;
  observedRepository?: { scope: FactoryScope; id: string };
  onRead: (scope: FactoryScope, candidate?: FactoryBranchSelection) => void;
}) {
  const [chosenKey, setProjectKey] = useState<string>();
  const projectKey = (props.projects.find((project) => project.key === chosenKey) ?? props.projects[0])?.key ?? "";
  const [repository, setRepository] = useState("");
  const [tracker, setTracker] = useState("issue");
  const [trackingError, setTrackingError] = useState("");
  const scope = { projectKey, repository };
  const validRepository = /^[A-Za-z0-9_.-]{1,100}$/.test(repository);
  const observed = props.observedRepository;
  const observedId = observed?.scope.projectKey === projectKey
    && observed.scope.repository.toLowerCase() === repository.toLowerCase() ? observed.id : undefined;

  function readBranch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validRepository) return;
    const form = new FormData(event.currentTarget);
    const field = (name: string) => String(form.get(name) ?? "").trim();
    const record = tracker === "linear" ? { provider: "linear", id: field("linearId") }
      : tracker === "jira" ? { provider: "jira", siteId: field("siteId"), id: field("jiraId") }
        : { provider: "github", kind: tracker, repositoryId: field("repositoryId"), number: Number(field("number")) };
    try {
      const workItem = parseFactoryWorkItem({ workItem: record });
      setTrackingError("");
      props.onRead(scope, {
        workItem,
        branch: field("branch"),
        baseRef: field("base"),
        worktree: field("worktree") || undefined,
        reviewIds: field("reviews").split(",").map((id) => id.trim()).filter(Boolean),
      });
    } catch (error) {
      setTrackingError(error instanceof Error ? error.message : "Check the tracking record.");
    }
  }

  return (
    <div className="factory-form">
      <form onSubmit={(event) => {
        event.preventDefault();
        if (props.online && validRepository) props.onRead(scope);
      }}>
        <fieldset disabled={props.busy}>
          <div className="factory-fields">
            <div className="factory-field">
              <label id="factory-project-label" htmlFor="factory-project">Project</label>
              <Select id="factory-project" className="settings-input" value={projectKey} aria-labelledby="factory-project-label"
                options={props.projects.map(({ key, label, path }) => ({ value: key, label, description: path }))}
                onChange={setProjectKey} />
            </div>
            <label>
              Repository
              <input className="settings-input" aria-label="Repository name" required maxLength={100}
                value={repository} onChange={(event) => setRepository(event.target.value.trim())}
                placeholder="Repository name from origin" spellCheck={false} />
            </label>
            <div className="factory-actions">
              <button className="button button--secondary" type="submit" disabled={!props.online || !validRepository}>Read pull requests</button>
              {props.refresh}
            </div>
          </div>
        </fieldset>
      </form>
      <details className="factory-branch-fields">
        <summary>Read a local branch</summary>
        <form onSubmit={readBranch}>
          <fieldset disabled={props.busy}>
            <div className="factory-fields">
              <div className="factory-field">
                <label id="factory-tracker-label" htmlFor="factory-tracker">Tracking record</label>
                <Select id="factory-tracker" className="settings-input" value={tracker}
                  aria-labelledby="factory-tracker-label" options={TRACKING_OPTIONS}
                  onChange={(value) => { setTracker(value); setTrackingError(""); }} />
              </div>
              <TrackingFields key={JSON.stringify([projectKey, repository.toLowerCase(), tracker])} tracker={tracker}
                observedId={observedId} />
              <Field name="branch" label="Branch" placeholder="fix/keyboard-focus" maxLength={255} required />
              <Field name="base" label="Base ref" placeholder="refs/remotes/origin/main" maxLength={255} required />
              <Field name="worktree" label="Worktree path (optional)" placeholder="Absolute path" maxLength={4096} />
              <Field name="reviews" label="Review IDs (optional)" placeholder="Comma-separated IDs" maxLength={2048} />
              <button className="button button--secondary" type="submit" disabled={!validRepository}>Read branch evidence</button>
            </div>
            {trackingError ? <p className="factory-warning" role="alert">{trackingError}</p> : null}
          </fieldset>
        </form>
      </details>
    </div>
  );
}

function TrackingFields({ tracker, observedId }: { tracker: string; observedId?: string }) {
  const [repositoryId, setRepositoryId] = useState<string>();
  if (tracker === "linear") {
    return <Field name="linearId" label="Linear issue ID" placeholder="Immutable issue UUID" maxLength={36} required />;
  }
  if (tracker === "jira") {
    return (
      <>
        <Field name="siteId" label="Jira site ID" placeholder="Site or cloud ID" maxLength={128} required />
        <Field name="jiraId" label="Jira issue ID" placeholder="Immutable issue ID" maxLength={32} numeric required />
      </>
    );
  }
  return (
    <>
      <label>
        GitHub repository ID
        <input className="settings-input" name="repositoryId" value={repositoryId ?? observedId ?? ""}
          onChange={(event) => setRepositoryId(event.target.value)} placeholder="Immutable repository ID" spellCheck={false}
          maxLength={256} autoComplete="off" required />
      </label>
      <Field name="number" label={tracker === "issue" ? "Issue number" : "Pull request number"}
        placeholder="42" maxLength={16} numeric required />
    </>
  );
}

function Field(props: { name: string; label: string; placeholder: string; maxLength: number; required?: boolean; numeric?: boolean }) {
  return (
    <label>
      {props.label}
      <input className="settings-input" name={props.name} placeholder={props.placeholder} maxLength={props.maxLength}
        spellCheck={false} autoComplete="off" required={props.required}
        inputMode={props.numeric ? "numeric" : undefined} pattern={props.numeric ? "[1-9][0-9]*" : undefined} />
    </label>
  );
}
