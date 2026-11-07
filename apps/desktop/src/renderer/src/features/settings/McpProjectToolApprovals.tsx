import {
  forgeRuleRepositoryMatchKey,
  type McpConnectionProjectToolApproval,
  type McpConnectionToolApproval,
} from "@pwragent/shared";
import { useId, useRef, useState } from "react";
import { Select, type SelectOption } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import { AddProjectForm, useDirectoryProjectLabels } from "./ForgeProjectRules";
import "./mcp-project-tool-approvals.css";

/**
 * Settings → Plugins → a connection's Tool approval → Projects: the projects
 * whose threads use their own Tool approval for this connection. An approval
 * card's "Allow all … tools in <project>" adds one here; so does Add project.
 */
export function McpProjectToolApprovals(props: {
  connectionName: string;
  entries: readonly McpConnectionProjectToolApproval[];
  options: SelectOption<McpConnectionToolApproval>[];
  disabled: boolean;
  desktopApi?: DesktopApi;
  /** `projectLabel` names the project in the notice. */
  onChange: (
    repository: string,
    toolApproval: McpConnectionToolApproval | null,
    projectLabel: string,
  ) => Promise<boolean>;
}) {
  const labelId = useId();
  const hintId = useId();
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);

  const { projectLabels, projectLabel, loading } = useDirectoryProjectLabels(
    props.desktopApi,
    props.entries.length > 0 || adding,
  );
  const listed = new Set(props.entries.map((entry) => forgeRuleRepositoryMatchKey(entry.repository)));
  const knownProjects = [...projectLabels.entries()]
    .filter(([key]) => !listed.has(key))
    .map(([, project]) => project)
    .sort((left, right) => left.label.localeCompare(right.label));

  return (
    <div aria-describedby={hintId} aria-labelledby={labelId} className="settings-mcp-projects" role="group">
      <div className="settings-mcp-projects__head">
        <span className="settings-mcp-row__policy-label" id={labelId}>Projects</span>
        {adding ? null : (
          <button
            ref={addRef}
            className="button button--ghost settings-mcp-projects__add"
            disabled={props.disabled}
            type="button"
            onClick={() => setAdding(true)}
          >
            Add project
          </button>
        )}
      </div>
      <span className="settings-mcp-row__policy-hint" id={hintId}>
        {props.entries.length > 0
          ? `Threads in these projects use their own approval for ${props.connectionName}.`
          : `Give a project its own approval for ${props.connectionName}, such as Allow all tools.`}
      </span>
      {props.entries.length > 0 ? (
        <ul className="settings-mcp-projects__list">
          {props.entries.map((entry) => {
            const label = projectLabel(entry.repository);
            return (
              <li key={entry.repository} className="settings-mcp-projects__row">
                <span className="settings-mcp-projects__name">
                  <span className="settings-mcp-projects__label">{label}</span>
                  <span className="settings-mcp-projects__repository">{entry.repository}</span>
                </span>
                <Select
                  aria-label={`Tool approval in ${label}`}
                  className="settings-select settings-select--chip"
                  disabled={props.disabled}
                  options={props.options}
                  value={entry.toolApproval}
                  onChange={(toolApproval) => void props.onChange(entry.repository, toolApproval, label)}
                />
                <button
                  aria-label={`Remove ${label}`}
                  className="button button--ghost settings-mcp-projects__remove"
                  disabled={props.disabled}
                  type="button"
                  onClick={() => {
                    // The row and its button go; focus moves to Add project.
                    void props.onChange(entry.repository, null, label).then((saved) => {
                      if (saved) requestAnimationFrame(() => addRef.current?.focus());
                    });
                  }}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {adding ? (
        <AddProjectForm
          knownProjects={knownProjects}
          loading={loading}
          onAdd={(repository) => {
            const close = (): void => {
              setAdding(false);
              requestAnimationFrame(() => addRef.current?.focus());
            };
            // A listed project keeps the mode its own chip shows.
            if (listed.has(forgeRuleRepositoryMatchKey(repository))) {
              close();
              return;
            }
            void props.onChange(repository, "approve", projectLabel(repository)).then((saved) => {
              if (saved) close();
            });
          }}
          onCancel={() => {
            setAdding(false);
            // The form held focus and is gone; return it to its opener.
            requestAnimationFrame(() => addRef.current?.focus());
          }}
        />
      ) : null}
    </div>
  );
}
