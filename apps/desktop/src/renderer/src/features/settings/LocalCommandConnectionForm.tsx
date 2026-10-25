import { useId } from "react";
import {
  splitMcpCommandLine,
  type McpStdioLaunch,
  type McpStdioLaunchInput,
  type TestMcpStdioConnectionResponse,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

/**
 * One environment variable as the form holds it.
 *
 * `stored` marks a secret whose value PwrAgent already holds. Its value is
 * never sent to a window, so the field starts blank and a blank field keeps
 * the stored value; typing replaces it.
 */
export type LocalCommandEnvDraft = {
  key: string;
  name: string;
  value: string;
  secret: boolean;
  stored: boolean;
};

/** A local command as the add form and the edit dialog hold it. */
export type LocalCommandDraft = {
  command: string;
  /** One argument per line, exactly as typed. */
  args: string;
  cwd: string;
  env: LocalCommandEnvDraft[];
};

let envKey = 0;
function nextEnvKey(): string {
  envKey += 1;
  return `env-${envKey}`;
}

export function emptyLocalCommandDraft(): LocalCommandDraft {
  return { command: "", args: "", cwd: "", env: [] };
}

export function localCommandDraftFromLaunch(launch: McpStdioLaunch): LocalCommandDraft {
  return {
    command: launch.command,
    args: launch.args.join("\n"),
    cwd: launch.cwd ?? "",
    env: launch.env.map((entry) => ({
      key: nextEnvKey(),
      name: entry.name,
      value: entry.secret ? "" : entry.value ?? "",
      secret: entry.secret,
      stored: entry.secret,
    })),
  };
}

/**
 * Turn a pasted command line into a draft, once, for the operator to check.
 * Undefined when it cannot be split (an unterminated quote) or is empty.
 */
export function localCommandDraftFromCommandLine(text: string): LocalCommandDraft | undefined {
  const argv = splitMcpCommandLine(text.trim());
  if (!argv?.length) return undefined;
  return { command: argv[0]!, args: argv.slice(1).join("\n"), cwd: "", env: [] };
}

/**
 * The draft as the main process takes it. Blank argument lines are dropped:
 * an empty argument cannot be told apart from a stray newline in this field.
 */
export function localCommandLaunchInput(draft: LocalCommandDraft): McpStdioLaunchInput {
  return {
    command: draft.command.trim(),
    args: draft.args.split(/\r?\n/).filter((line) => line.length > 0),
    ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
    env: draft.env
      .filter((entry) => entry.name.trim() || entry.value)
      .map((entry) => ({
        name: entry.name.trim(),
        secret: entry.secret,
        // A stored secret left blank keeps what PwrAgent holds.
        ...(entry.secret && entry.stored && entry.value === "" ? {} : { value: entry.value }),
      })),
  };
}

export function localCommandDraftReady(draft: LocalCommandDraft): boolean {
  return draft.command.trim().length > 0;
}

/** The command, arguments, folder and variables of a local command. */
export function LocalCommandFields(props: {
  draft: LocalCommandDraft;
  desktopApi?: DesktopApi;
  disabled: boolean;
  onChange: (draft: LocalCommandDraft) => void;
  /** The absolute path the last test ran, shown under the command. */
  resolvedCommand?: string;
}) {
  const id = useId();
  const { draft, disabled } = props;
  const change = (patch: Partial<LocalCommandDraft>): void => props.onChange({ ...draft, ...patch });
  const changeEnv = (key: string, patch: Partial<LocalCommandEnvDraft>): void =>
    change({ env: draft.env.map((entry) => entry.key === key ? { ...entry, ...patch } : entry) });
  const pickFolder = async (): Promise<void> => {
    const picked = await props.desktopApi?.pickDirectoryFromDisk?.();
    if (picked && !picked.canceled) change({ cwd: picked.path });
  };
  return (
    <div className="settings-mcp-local">
      <label className="settings-mcp-local__field">
        <span className="settings-mcp-local__label">
          Command
          <small>A program name or full path</small>
        </span>
        <span className="settings-mcp-local__control">
          <input
            autoCapitalize="off"
            autoComplete="off"
            className="settings-input"
            disabled={disabled}
            placeholder="npx"
            spellCheck={false}
            value={draft.command}
            onChange={(event) => change({ command: event.target.value })}
          />
          {props.resolvedCommand && props.resolvedCommand !== draft.command.trim() ? (
            <span className="settings-mcp-local__hint settings-mcp-local__hint--ok">
              Runs <code>{props.resolvedCommand}</code>
            </span>
          ) : null}
        </span>
      </label>
      <label className="settings-mcp-local__field">
        <span className="settings-mcp-local__label">
          Arguments
          <small>One per line</small>
        </span>
        <span className="settings-mcp-local__control">
          <textarea
            aria-describedby={`${id}-args`}
            autoCapitalize="off"
            autoComplete="off"
            className="settings-input settings-input--multiline"
            disabled={disabled}
            placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/Users/you/Projects"}
            rows={3}
            spellCheck={false}
            value={draft.args}
            onChange={(event) => change({ args: event.target.value })}
          />
          <span className="settings-mcp-local__hint" id={`${id}-args`}>
            Passed exactly as written. There is no shell, so <code>~</code> and <code>$VARS</code> are not expanded.
          </span>
        </span>
      </label>
      <div className="settings-mcp-local__field">
        <label className="settings-mcp-local__label" htmlFor={`${id}-cwd`}>
          Working folder
          <small>Optional</small>
        </label>
        <span className="settings-mcp-local__control settings-mcp-local__control--row">
          <input
            autoCapitalize="off"
            autoComplete="off"
            className="settings-input"
            disabled={disabled}
            id={`${id}-cwd`}
            placeholder="Your home folder"
            spellCheck={false}
            value={draft.cwd}
            onChange={(event) => change({ cwd: event.target.value })}
          />
          {props.desktopApi?.pickDirectoryFromDisk ? (
            <button
              className="button button--secondary"
              disabled={disabled}
              type="button"
              onClick={() => void pickFolder()}
            >
              Choose…
            </button>
          ) : null}
        </span>
      </div>
      <div className="settings-mcp-local__field">
        <span className="settings-mcp-local__label" id={`${id}-env`}>
          Environment
          <small>Only these, plus PATH and HOME</small>
        </span>
        <div aria-labelledby={`${id}-env`} className="settings-mcp-local__control" role="group">
          {draft.env.map((entry, index) => (
            <div key={entry.key} className="settings-mcp-local__env">
              <input
                aria-label={`Variable ${index + 1} name`}
                autoCapitalize="characters"
                autoComplete="off"
                className="settings-input"
                disabled={disabled}
                placeholder="NAME"
                spellCheck={false}
                value={entry.name}
                onChange={(event) => changeEnv(entry.key, { name: event.target.value })}
              />
              <input
                aria-label={`${entry.name || `Variable ${index + 1}`} value`}
                autoComplete="off"
                className="settings-input"
                disabled={disabled}
                placeholder={entry.secret && entry.stored ? "Stored encrypted. Type to replace." : "value"}
                spellCheck={false}
                type={entry.secret ? "password" : "text"}
                value={entry.value}
                onChange={(event) => changeEnv(entry.key, { value: event.target.value })}
              />
              <button
                aria-label={`Keep ${entry.name || `variable ${index + 1}`} secret`}
                aria-pressed={entry.secret}
                className={`settings-mcp-local__secret${entry.secret ? " is-on" : ""}`}
                disabled={disabled}
                title={entry.secret
                  ? "Stored encrypted in this profile. Never written to config.toml or shown again."
                  : "Stored in config.toml as plain text."}
                type="button"
                onClick={() => changeEnv(entry.key, {
                  secret: !entry.secret,
                  // A stored value never comes back to the window, so a
                  // secret turned plain has to be typed again.
                  stored: entry.secret ? false : entry.stored,
                })}
              >
                <span aria-hidden="true" className="settings-mcp-local__secret-box" />
                Secret
              </button>
              <button
                aria-label={`Remove ${entry.name || `variable ${index + 1}`}`}
                className="button button--ghost settings-mcp-local__remove"
                disabled={disabled}
                type="button"
                onClick={() => change({ env: draft.env.filter((item) => item.key !== entry.key) })}
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="button button--secondary settings-mcp-local__add"
            disabled={disabled}
            type="button"
            onClick={() => change({
              env: [...draft.env, { key: nextEnvKey(), name: "", value: "", secret: false, stored: false }],
            })}
          >
            Add variable
          </button>
        </div>
      </div>
    </div>
  );
}

/** Where a local command runs, in one sentence. */
export function LocalCommandWhereItRuns() {
  return (
    <p className="settings-mcp-local__where">
      <span className="settings-mcp-local__where-key">Runs</span>
      <span>
        On <strong>this computer, as you</strong>. PwrAgent starts one copy for each thread that turns
        it on and stops it when that thread&rsquo;s agent lets go. It can do anything your account can,
        so add only servers you trust.
      </span>
    </p>
  );
}

/** The outcome of a Test: what started, or what to fix. */
export function LocalCommandTestResult(props: { result: TestMcpStdioConnectionResponse }) {
  const result = props.result;
  if (result.ok) {
    const name = result.serverName
      ? `${result.serverName}${result.serverVersion ? ` ${result.serverVersion}` : ""}`
      : "the server";
    return (
      <p className="settings-mcp-probe settings-mcp-probe--ok" role="status">
        Started {name} in {(result.elapsedMs / 1_000).toFixed(1)} s and read {result.toolCount}{" "}
        {result.toolCount === 1 ? "tool" : "tools"}, then stopped it. Nothing is saved yet.
      </p>
    );
  }
  return (
    <div className="settings-mcp-probe settings-mcp-probe--err" role="alert">
      <span>{result.message}</span>
      {result.output ? (
        <pre className="settings-mcp-local__output" aria-label="Server output">{result.output}</pre>
      ) : null}
    </div>
  );
}

/** Failures a server might get past on its own: Add anyway is offered. */
export function localCommandTestAllowsAddAnyway(result: TestMcpStdioConnectionResponse | undefined): boolean {
  return Boolean(result && !result.ok
    && (result.problem === "exited" || result.problem === "no_handshake" || result.problem === "spawn_failed"));
}
