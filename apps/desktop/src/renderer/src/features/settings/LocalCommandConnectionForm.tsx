import { useId } from "react";
import {
  formatMcpCommandLine,
  MCP_STDIO_ENV_NAME_PATTERN,
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

/**
 * A local command as the add form and the edit dialog hold it.
 *
 * The command and its arguments are one line, the way a server's README
 * prints it. It is split once, without a shell, and stored as argv; the form
 * shows the split so quoting is never a guess.
 */
export type LocalCommandDraft = {
  commandLine: string;
  cwd: string;
  env: LocalCommandEnvDraft[];
};

let envKey = 0;
function nextEnvKey(): string {
  envKey += 1;
  return `env-${envKey}`;
}

export function emptyLocalCommandDraft(): LocalCommandDraft {
  return { commandLine: "", cwd: "", env: [] };
}

export function localCommandDraftFromLaunch(launch: McpStdioLaunch): LocalCommandDraft {
  return {
    commandLine: formatMcpCommandLine(launch),
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

/** Names that usually hold a credential, so a pasted value starts hidden. */
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|_KEY$|CREDENTIAL/i;

/**
 * Move `NAME=value` words from the front of the command line into
 * environment rows, as a shell would apply them. READMEs often write
 * `GITHUB_TOKEN=… npx …`; run as-is, `GITHUB_TOKEN=…` would be the program.
 * Returns the draft unchanged when there is nothing to move, or when the line
 * cannot be split.
 */
export function moveLeadingAssignments(draft: LocalCommandDraft): LocalCommandDraft {
  const argv = splitMcpCommandLine(draft.commandLine.trim());
  if (!argv?.length) return draft;
  const env = [...draft.env];
  let index = 0;
  for (; index < argv.length - 1; index += 1) {
    const word = argv[index]!;
    const equals = word.indexOf("=");
    const name = equals > 0 ? word.slice(0, equals) : "";
    if (!MCP_STDIO_ENV_NAME_PATTERN.test(name)) break;
    const value = word.slice(equals + 1);
    const existing = env.findIndex((entry) => entry.name === name);
    const row: LocalCommandEnvDraft = {
      key: existing >= 0 ? env[existing]!.key : nextEnvKey(),
      name,
      value,
      // Never un-hide a variable the operator already marked secret.
      secret: SECRET_NAME.test(name) || (existing >= 0 && env[existing]!.secret),
      stored: false,
    };
    if (existing >= 0) env[existing] = row;
    else env.push(row);
  }
  if (index === 0) return draft;
  return {
    ...draft,
    commandLine: formatMcpCommandLine({ command: argv[index]!, args: argv.slice(index + 1) }),
    env,
  };
}

/**
 * Turn a pasted command line into a draft, once, for the operator to check.
 * Undefined when it cannot be split (an unterminated quote) or is empty.
 */
export function localCommandDraftFromCommandLine(text: string): LocalCommandDraft | undefined {
  const argv = splitMcpCommandLine(text.trim());
  if (!argv?.length) return undefined;
  return moveLeadingAssignments({ commandLine: text.trim(), cwd: "", env: [] });
}

/** The draft's argv, or undefined while it cannot be split. */
function draftArgv(draft: LocalCommandDraft): string[] | undefined {
  return splitMcpCommandLine(draft.commandLine.trim());
}

/** The draft as the main process takes it. */
export function localCommandLaunchInput(draft: LocalCommandDraft): McpStdioLaunchInput {
  const argv = draftArgv(draft) ?? [];
  return {
    command: argv[0] ?? "",
    args: argv.slice(1),
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
  return Boolean(draftArgv(draft)?.length);
}

/** The command line, folder and variables of a local command. */
export function LocalCommandFields(props: {
  draft: LocalCommandDraft;
  desktopApi?: DesktopApi;
  disabled: boolean;
  onChange: (draft: LocalCommandDraft) => void;
  /** The absolute path the last test ran, shown under the command line. */
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
  const argv = draftArgv(draft);
  const unterminated = argv === undefined;
  return (
    <div className="settings-mcp-local">
      <div className="settings-mcp-local__field">
        <label className="settings-mcp-local__label" htmlFor={`${id}-command`}>
          Command line
          <small>As the server&rsquo;s README gives it</small>
        </label>
        <span className="settings-mcp-local__control">
          <input
            aria-describedby={`${id}-command-hint`}
            aria-invalid={unterminated ? true : undefined}
            autoCapitalize="off"
            autoComplete="off"
            className="settings-input"
            disabled={disabled}
            id={`${id}-command`}
            placeholder="npx -y @modelcontextprotocol/server-filesystem /Users/you/Projects"
            spellCheck={false}
            value={draft.commandLine}
            onBlur={() => {
              const moved = moveLeadingAssignments(draft);
              if (moved !== draft) props.onChange(moved);
            }}
            onChange={(event) => change({ commandLine: event.target.value })}
          />
          {argv?.length ? (
            // How the line was split, word by word. Quotes are the one thing
            // that changes a split, so this is where a mistake shows. After a
            // test, the program is the absolute path that actually ran.
            <span className="settings-mcp-local__argv">
              <span className="settings-mcp-local__argv-label">Runs</span>
              <code
                className={props.resolvedCommand ? "settings-mcp-local__argv-program" : undefined}
                title={props.resolvedCommand ? "The program the last test ran" : undefined}
              >
                {props.resolvedCommand ?? argv[0]}
              </code>
              {argv.slice(1).map((arg, index) => (
                <code key={index}>{arg === "" ? "\u00a0" : arg}</code>
              ))}
            </span>
          ) : null}
          {unterminated ? (
            <span className="settings-mcp-local__hint settings-mcp-local__hint--err" id={`${id}-command-hint`}>
              A quote is not closed.
            </span>
          ) : (
            <span className="settings-mcp-local__hint" id={`${id}-command-hint`}>
              Split into words the way a shell would, but nothing is expanded:
              {" "}<code>~</code> and <code>$VARS</code> reach the server as typed.
            </span>
          )}
        </span>
      </div>
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
                placeholder={entry.secret && entry.stored ? "Stored encrypted" : "value"}
                spellCheck={false}
                title={entry.secret && entry.stored
                  ? "Leave blank to keep the stored value, or type a new one to replace it."
                  : undefined}
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
