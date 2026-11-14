import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import {
  GITHUB_MCP_BUILT_IN_OVERLAP_TOOLSETS,
  GITHUB_MCP_HOSTED_HOST,
  GITHUB_MCP_LOCAL_PROGRAM,
  GITHUB_MCP_PRIMARY_TOOLSET_COUNT,
  GITHUB_MCP_TOOLSETS,
  defaultGithubMcpSettingsInput,
  describeGithubMcpAccount,
  missingGithubMcpScopes,
  normalizeGithubMcpToolsets,
  type GithubMcpAccountCheck,
  type GithubMcpAccountSource,
  type GithubMcpServerLocation,
  type GithubMcpSettings,
  type GithubMcpSettingsInput,
  type GithubMcpToolset,
  type InspectGithubMcpSetupResponse,
  type TestGithubMcpConnectionResponse,
} from "@pwragent/shared";
import { SettingsSwitch } from "./SettingsSwitch";

/**
 * A GitHub connection as the add form and the edit dialog hold it.
 *
 * `token` is only ever what the operator typed. A stored token never comes
 * back to the window, so `tokenStored` says one exists, the field starts
 * blank, and a blank field keeps it.
 */
export type GithubConnectionDraft = {
  account: GithubMcpAccountSource;
  server: GithubMcpServerLocation;
  toolsets: GithubMcpToolset[];
  readOnly: boolean;
  skills: boolean;
  token: string;
  tokenStored: boolean;
  showAllToolsets: boolean;
};

export function emptyGithubConnectionDraft(): GithubConnectionDraft {
  const defaults = defaultGithubMcpSettingsInput();
  return {
    account: defaults.account,
    server: defaults.server,
    toolsets: normalizeGithubMcpToolsets(defaults.toolsets),
    readOnly: defaults.readOnly,
    skills: defaults.skills,
    token: "",
    tokenStored: false,
    showAllToolsets: false,
  };
}

export function githubConnectionDraftFromSettings(settings: GithubMcpSettings): GithubConnectionDraft {
  const toolsets = normalizeGithubMcpToolsets(settings.toolsets);
  return {
    account: settings.account,
    server: settings.server,
    toolsets,
    readOnly: settings.readOnly,
    skills: settings.skills,
    token: "",
    tokenStored: settings.account === "token",
    // A saved choice outside the first row stays visible.
    showAllToolsets: toolsets.some((toolset) =>
      GITHUB_MCP_TOOLSETS.indexOf(toolset) >= GITHUB_MCP_PRIMARY_TOOLSET_COUNT),
  };
}

/** The draft as the main process takes it. A blank token keeps the stored one. */
export function githubConnectionInput(draft: GithubConnectionDraft): GithubMcpSettingsInput {
  return {
    account: draft.account,
    server: draft.server,
    toolsets: [...draft.toolsets],
    readOnly: draft.readOnly,
    skills: draft.skills,
    ...(draft.account === "token" && draft.token.trim() ? { token: draft.token.trim() } : {}),
  };
}

export function githubConnectionDraftReady(draft: GithubConnectionDraft): boolean {
  if (draft.toolsets.length === 0) return false;
  return draft.account !== "token" || Boolean(draft.token.trim()) || draft.tokenStored;
}

/** The account a draft would act as, as far as the window knows. */
function draftAccount(
  draft: GithubConnectionDraft,
  inspect: InspectGithubMcpSetupResponse | undefined,
  test: TestGithubMcpConnectionResponse | undefined,
): GithubMcpAccountCheck | undefined {
  if (test?.account && test.account.source === draft.account) return test.account;
  return draft.account === "gh_cli" ? inspect?.cli : undefined;
}

/** One option of a two-way choice: a card with its own status line. */
function ChoiceCard(props: {
  selected: boolean;
  disabled: boolean;
  title: string;
  status?: ReactNode;
  statusTone?: "ok" | "warn" | "muted";
  children: ReactNode;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  buttonRef?: (element: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={props.buttonRef}
      aria-checked={props.selected}
      className={`settings-github-choice${props.selected ? " is-on" : ""}`}
      disabled={props.disabled}
      role="radio"
      // One tab stop per group, as a radio group has; arrows move within it.
      tabIndex={props.selected ? 0 : -1}
      type="button"
      onClick={props.onSelect}
      onKeyDown={props.onKeyDown}
    >
      <span aria-hidden="true" className="settings-github-choice__mark" />
      <span className="settings-github-choice__title">{props.title}</span>
      {props.status ? (
        <span className={`settings-github-choice__status settings-github-choice__status--${props.statusTone ?? "ok"}`}>
          {props.status}
        </span>
      ) : <span />}
      <span className="settings-github-choice__detail">{props.children}</span>
    </button>
  );
}

/** Two cards as one radio group: Left/Up and Right/Down move the choice. */
function useChoiceGroup<T extends string>(values: readonly T[], value: T, onChange: (next: T) => void) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  return {
    ref: (option: T) => (element: HTMLButtonElement | null) => {
      if (element) buttons.current.set(option, element);
      else buttons.current.delete(option);
    },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = values[(values.indexOf(value) + step + values.length) % values.length]!;
      onChange(next);
      buttons.current.get(next)?.focus();
    },
  };
}

const ACCOUNTS = ["gh_cli", "token"] as const;
const SERVERS = ["hosted", "local"] as const;

function cliStatus(
  inspecting: boolean,
  account: GithubMcpAccountCheck | undefined,
): { text: string; tone: "ok" | "warn" | "muted" } | undefined {
  if (inspecting && !account) return { text: "Checking…", tone: "muted" };
  if (!account) return undefined;
  switch (account.state) {
    case "ready":
      return account.login
        ? { text: `Signed in as @${account.login}`, tone: "ok" }
        : { text: "Signed in", tone: "ok" };
    case "gh_missing":
      return { text: "gh not found", tone: "warn" };
    case "signed_out":
      return { text: "Not signed in", tone: "warn" };
    case "rejected":
      return { text: "Sign-in rejected", tone: "warn" };
    case "unreachable":
      return { text: "Couldn't check", tone: "muted" };
    default:
      return undefined;
  }
}

/**
 * Account, server, toolsets, access and skills for a GitHub connection.
 *
 * Every choice has a working default, so an operator already signed in to
 * gh can Test and Add straight away. Each account problem shows under the
 * selected account, and switching to a token stays one click away.
 */
export function GithubConnectionFields(props: {
  draft: GithubConnectionDraft;
  disabled: boolean;
  /** The CLI sign-in and the local server, as last inspected. */
  inspect?: InspectGithubMcpSetupResponse;
  inspecting: boolean;
  /** The last Test of this draft, for the account it found. */
  test?: TestGithubMcpConnectionResponse;
  onChange: (draft: GithubConnectionDraft) => void;
  /** Read the CLI sign-in and the local server again. */
  onRecheck?: () => void;
}) {
  const id = useId();
  const { draft, disabled } = props;
  const change = (patch: Partial<GithubConnectionDraft>): void => props.onChange({ ...draft, ...patch });
  const account = draftAccount(draft, props.inspect, props.test);
  const accountGroup = useChoiceGroup(ACCOUNTS, draft.account, (next) => change({ account: next }));
  const serverGroup = useChoiceGroup(SERVERS, draft.server, (next) => change({ server: next }));
  const cli = props.test?.account?.source === "gh_cli" ? props.test.account : props.inspect?.cli;
  const cliLine = cliStatus(props.inspecting, cli);
  const cliProblem = cli && cli.state !== "ready" && cli.state !== "unreachable";
  const tokenAccount = props.test?.account?.source === "token" ? props.test.account : undefined;
  const missing = missingGithubMcpScopes({
    toolsets: draft.toolsets,
    readOnly: draft.readOnly,
    scopes: account?.state === "ready" ? account.scopes : undefined,
  });
  const toolsets = draft.showAllToolsets
    ? GITHUB_MCP_TOOLSETS
    : GITHUB_MCP_TOOLSETS.slice(0, GITHUB_MCP_PRIMARY_TOOLSET_COUNT);
  const hidden = GITHUB_MCP_TOOLSETS.length - GITHUB_MCP_PRIMARY_TOOLSET_COUNT;
  const localCommand = props.inspect?.localCommand;
  const who = account?.state === "ready" && account.login ? `@${account.login}` : undefined;
  return (
    <div className="settings-mcp-local settings-github">
      <div className="settings-mcp-local__field">
        <span className="settings-mcp-local__label" id={`${id}-account`}>
          Account
          <small>Whose access threads use</small>
        </span>
        <div className="settings-mcp-local__control">
          {/* Only the two cards are the radio group; the field and button
              beside them are not options. */}
          <div aria-labelledby={`${id}-account`} className="settings-mcp-local__control" role="radiogroup">
            <ChoiceCard
              buttonRef={accountGroup.ref("gh_cli")}
              disabled={disabled}
              selected={draft.account === "gh_cli"}
              status={cliLine?.text}
              statusTone={cliLine?.tone}
              title="GitHub CLI sign-in"
              onKeyDown={accountGroup.onKeyDown}
              onSelect={() => change({ account: "gh_cli" })}
            >
              {draft.account === "gh_cli" && cli && cliProblem ? (
                describeGithubMcpAccount(cli)
              ) : (
                <>
                  Uses the account <code>gh</code> is signed in to on this computer. It is read each
                  time the server connects, so <code>gh auth refresh</code> or a switch of account
                  applies on the next connect.
                  {cli?.state === "ready" && cli.scopes?.length ? (
                    <> Scopes: <b>{cli.scopes.join(", ")}</b>.</>
                  ) : null}
                </>
              )}
            </ChoiceCard>
            <ChoiceCard
              buttonRef={accountGroup.ref("token")}
              disabled={disabled}
              selected={draft.account === "token"}
              status={tokenAccount?.state === "ready" && tokenAccount.login ? `@${tokenAccount.login}` : undefined}
              title="Personal access token"
              onKeyDown={accountGroup.onKeyDown}
              onSelect={() => change({ account: "token" })}
            >
              A fine-grained or classic token, stored encrypted in this profile and never shown
              again. Use it to give threads less access than your own account.
            </ChoiceCard>
          </div>
          {draft.account === "gh_cli" && cliProblem && props.onRecheck ? (
            <button
              className="button button--secondary settings-mcp-local__add"
              disabled={disabled || props.inspecting}
              type="button"
              onClick={props.onRecheck}
            >
              {props.inspecting ? "Checking…" : "Check again"}
            </button>
          ) : null}
          {draft.account === "token" ? (
            <input
              aria-label="Personal access token"
              autoCapitalize="off"
              autoComplete="off"
              className="settings-input"
              disabled={disabled}
              placeholder={draft.tokenStored ? "Stored encrypted. Paste a new one to replace it." : "github_pat_… or ghp_…"}
              spellCheck={false}
              type="password"
              value={draft.token}
              onChange={(event) => change({ token: event.target.value })}
            />
          ) : null}
        </div>
      </div>
      <div className="settings-mcp-local__field">
        <span className="settings-mcp-local__label" id={`${id}-server`}>
          Server
          <small>Where it runs</small>
        </span>
        <div aria-labelledby={`${id}-server`} className="settings-mcp-local__control" role="radiogroup">
          <ChoiceCard
            buttonRef={serverGroup.ref("hosted")}
            disabled={disabled}
            selected={draft.server === "hosted"}
            title="GitHub-hosted"
            onKeyDown={serverGroup.onKeyDown}
            onSelect={() => change({ server: "hosted" })}
          >
            <code>{GITHUB_MCP_HOSTED_HOST}</code>. Nothing to install, and GitHub keeps it up to date.
          </ChoiceCard>
          <ChoiceCard
            buttonRef={serverGroup.ref("local")}
            disabled={disabled}
            selected={draft.server === "local"}
            status={props.inspect
              ? localCommand ? "Installed" : `${GITHUB_MCP_LOCAL_PROGRAM} not found`
              : undefined}
            statusTone={localCommand ? "ok" : "muted"}
            title="On this computer"
            onKeyDown={serverGroup.onKeyDown}
            onSelect={() => change({ server: "local" })}
          >
            Runs <code>{GITHUB_MCP_LOCAL_PROGRAM} stdio</code> as a local command
            {localCommand ? <> from <code>{localCommand}</code></> : null}. Use it to pin a
            version or run your own build.
          </ChoiceCard>
        </div>
      </div>
      <div className="settings-mcp-local__field">
        <span className="settings-mcp-local__label" id={`${id}-toolsets`}>
          Toolsets
          <small>Fewer tools, less context per turn</small>
        </span>
        <div className="settings-mcp-local__control">
          <div aria-labelledby={`${id}-toolsets`} className="settings-github-toolsets" role="group">
            {toolsets.map((toolset) => {
              const on = draft.toolsets.includes(toolset);
              const builtIn = GITHUB_MCP_BUILT_IN_OVERLAP_TOOLSETS.includes(toolset);
              return (
                <button
                  key={toolset}
                  aria-pressed={on}
                  className={`settings-github-toolset${on ? " is-on" : ""}`}
                  disabled={disabled}
                  type="button"
                  onClick={() => change({
                    toolsets: normalizeGithubMcpToolsets(on
                      ? draft.toolsets.filter((item) => item !== toolset)
                      : [...draft.toolsets, toolset]),
                  })}
                >
                  <span aria-hidden="true" className="settings-github-toolset__box" />
                  {toolset}
                  {builtIn ? <span className="settings-github-toolset__note">built in</span> : null}
                </button>
              );
            })}
            <button
              aria-expanded={draft.showAllToolsets}
              className="button button--ghost settings-github-toolsets__more"
              disabled={disabled}
              type="button"
              onClick={() => change({ showAllToolsets: !draft.showAllToolsets })}
            >
              {draft.showAllToolsets ? "Fewer toolsets" : `${hidden} more`}
            </button>
          </div>
          {draft.toolsets.length === 0 ? (
            <span className="settings-mcp-local__hint settings-mcp-local__hint--err">
              Choose at least one toolset.
            </span>
          ) : (
            <span className="settings-mcp-local__hint">
              Pull requests and CI already have PwrAgent&rsquo;s own GitHub tools, which keep the
              PR chips and watches in sync. Turn these on to give agents GitHub&rsquo;s versions
              as well.
            </span>
          )}
          {missing.scopes.length > 0 ? (
            <span className="settings-mcp-local__hint settings-github__warn" role="status">
              The <b>{missing.toolsets.join(", ")}</b>{" "}
              {missing.toolsets.length === 1 ? "toolset needs" : "toolsets need"} scopes this{" "}
              {draft.account === "gh_cli" ? "login" : "token"} doesn&rsquo;t have.{" "}
              {draft.account === "gh_cli" ? (
                <>Run <code>gh auth refresh -s {missing.scopes.join(",")}</code>, or turn {missing.toolsets.length === 1 ? "it" : "those toolsets"} off.</>
              ) : (
                <>Add {missing.scopes.join(", ")} to the token, or turn {missing.toolsets.length === 1 ? "it" : "those toolsets"} off.</>
              )}
            </span>
          ) : null}
        </div>
      </div>
      <div className="settings-mcp-local__field">
        <span className="settings-mcp-local__label">Access</span>
        <div className="settings-mcp-local__control">
          <div className="settings-github-switch">
            <SettingsSwitch
              checked={draft.readOnly}
              describedBy={`${id}-readonly`}
              disabled={disabled}
              label="Read-only"
              onChange={(readOnly) => change({ readOnly })}
            />
            <span className="settings-github-switch__text" id={`${id}-readonly`}>
              <span className="settings-github-switch__label">Read-only</span>
              <span className="settings-mcp-local__hint">
                Loads only tools that read. Threads can&rsquo;t open issues, comment or push files.
              </span>
            </span>
          </div>
        </div>
      </div>
      <div className="settings-mcp-local__field">
        <span className="settings-mcp-local__label">
          Skills
          <small>From GitHub&rsquo;s server</small>
        </span>
        <div className="settings-mcp-local__control">
          <div className="settings-github-switch">
            <SettingsSwitch
              checked={draft.skills}
              describedBy={`${id}-skills`}
              disabled={disabled}
              label="Workflow skills"
              onChange={(skills) => change({ skills })}
            />
            <span className="settings-github-switch__text" id={`${id}-skills`}>
              <span className="settings-github-switch__label">Workflow skills</span>
              <span className="settings-mcp-local__hint">
                Step-by-step guides GitHub publishes for issue triage, code review, release notes
                and more. Agents read one when a task matches. A skill grants no extra tool access.
              </span>
            </span>
          </div>
        </div>
      </div>
      <p className="settings-mcp-local__where">
        <span className="settings-mcp-local__where-key">Access</span>
        <span>
          Threads that turn this on act {who ? <strong>as {who}</strong> : "as this account"} on
          GitHub, with every repository and organization that account can reach. The
          connection&rsquo;s Tool approval decides which calls ask first.
        </span>
      </p>
    </div>
  );
}

/** The outcome of a Test: what it read, or what to fix. */
export function GithubConnectionTestResult(props: {
  result: TestGithubMcpConnectionResponse;
  skillsRequested: boolean;
}) {
  const result = props.result;
  if (result.ok) {
    const who = result.account.login ? `Signed in as @${result.account.login}. ` : "";
    const tools = `${result.toolCount} ${result.toolCount === 1 ? "tool" : "tools"}`;
    const skills = result.skillCount === undefined
      ? ""
      : ` and ${result.skillCount} ${result.skillCount === 1 ? "skill" : "skills"}`;
    // Asked for skills and got none: say so, rather than let the switch
    // read as if it worked.
    const noSkills = props.skillsRequested && result.skillCount === undefined
      ? " This server does not offer skills yet, so threads get GitHub's instructions instead."
      : "";
    return (
      <p className="settings-mcp-probe settings-mcp-probe--ok" role="status">
        {who}Read {tools}{skills}, then disconnected. Nothing is saved yet.{noSkills}
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
