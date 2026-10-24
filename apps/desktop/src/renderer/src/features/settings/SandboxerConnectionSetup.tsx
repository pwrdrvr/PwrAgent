import { useEffect, useRef, useState } from "react";
import type {
  McpConnectionStatus,
  SandboxerCliState,
  SandboxerLinkTarget,
} from "@pwragent/shared";
import {
  SANDBOXER_CLI_PATH,
  SANDBOXER_MCP_LAUNCH_ARGS,
  SANDBOXER_SETUP_COMMAND,
} from "@pwragent/shared";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";

/**
 * The Sandboxer row's own parts. Most operators have never heard of
 * Sandboxer, and it bills, so its setup states say what it is and link to
 * its site, and its ready state names the account that pays.
 *
 * Every link opens through main, which allows only `https://sandboxer.com`.
 */

type Notice = { kind: "error" | "info" | "success" | "working"; text: string };

/** Signed in, but the account cannot start a machine yet. */
const ACCOUNT_STATES: ReadonlySet<SandboxerCliState | undefined> = new Set([
  "no_plan",
  "billing_issue",
  "out_of_credit",
  "cannot_start",
]);

/** Billing problems are fixed on the signed-in dashboard. */
const BILLING_STATES: ReadonlySet<SandboxerCliState | undefined> = new Set([
  "billing_issue",
  "out_of_credit",
  "cannot_start",
]);

export const SANDBOXER_RUNS_COMMAND =
  [SANDBOXER_CLI_PATH, ...SANDBOXER_MCP_LAUNCH_ARGS].join(" ");

/** Signed in to an account that can't start a machine; its chip says why. */
export function sandboxerCannotStart(connection: McpConnectionStatus): boolean {
  return ACCOUNT_STATES.has(connection.sandboxerCliState);
}

export function sandboxerNeedsSetup(connection: McpConnectionStatus): boolean {
  const state = connection.sandboxerCliState;
  return state === "cli_missing" || state === "not_signed_in" || ACCOUNT_STATES.has(state);
}

export function SandboxerLink(props: {
  desktopApi?: DesktopApi;
  label: string;
  target: SandboxerLinkTarget;
  title?: string;
  variant?: "chip" | "button" | "inline";
  onNotice: (notice: Notice) => void;
}) {
  const open = props.desktopApi?.openSandboxerLink;
  const variant = props.variant ?? "chip";
  return (
    <button
      className={variant === "button"
        ? "button button--secondary settings-sandboxer-action"
        : `settings-sandboxer-link${variant === "inline" ? " settings-sandboxer-link--inline" : ""}`}
      disabled={!open}
      title={props.title}
      type="button"
      onClick={() => {
        if (!open) return;
        void open(props.target).then(
          (response) => {
            if (!response.opened) {
              props.onNotice({
                kind: "error",
                text: response.error ?? "Could not open the Sandboxer page.",
              });
            }
          },
          (error: unknown) => props.onNotice({
            kind: "error",
            text: error instanceof Error ? error.message : String(error),
          }),
        );
      }}
    >
      {props.label}
    </button>
  );
}

/**
 * Puts `sbx onboard` on the clipboard. PwrAgent never runs it: sign-in and
 * the plan checkout need a terminal for the browser hand-off and prompts.
 */
export function SandboxerSetupCommandButton(props: {
  desktopApi?: DesktopApi;
  disabled: boolean;
  onNotice: (notice: Notice) => void;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);
  return (
    <button
      className="button button--secondary"
      disabled={props.disabled}
      title={`Copy ${SANDBOXER_SETUP_COMMAND} to run in a terminal.`}
      type="button"
      onClick={() => {
        void copyText(SANDBOXER_SETUP_COMMAND, props.desktopApi).then(
          () => {
            setCopied(true);
            window.clearTimeout(resetTimer.current);
            resetTimer.current = window.setTimeout(() => setCopied(false), 1_500);
          },
          () => props.onNotice({
            kind: "error",
            text: `Could not copy. Run ${SANDBOXER_SETUP_COMMAND} in a terminal.`,
          }),
        );
      }}
    >
      {copied ? "Copied" : "Copy setup command"}
    </button>
  );
}

/** The action that advances this setup state, beside Refresh status. */
export function SandboxerSetupAction(props: {
  connection: McpConnectionStatus;
  desktopApi?: DesktopApi;
  disabled: boolean;
  onNotice: (notice: Notice) => void;
}) {
  const state = props.connection.sandboxerCliState;
  if (state === "cli_missing") {
    return (
      <SandboxerLink
        desktopApi={props.desktopApi}
        label="Get Sandboxer CLI"
        target="quickstart"
        title="Open Sandboxer's quickstart: the installer, sign-up, and the trial."
        variant="button"
        onNotice={props.onNotice}
      />
    );
  }
  if (BILLING_STATES.has(state)) {
    return (
      <SandboxerLink
        desktopApi={props.desktopApi}
        label="Open billing"
        target="dashboard"
        title="Open the Sandboxer dashboard, signed in with this machine's CLI login."
        variant="button"
        onNotice={props.onNotice}
      />
    );
  }
  if (state === "not_signed_in" || state === "no_plan") {
    return (
      <SandboxerSetupCommandButton
        desktopApi={props.desktopApi}
        disabled={props.disabled}
        onNotice={props.onNotice}
      />
    );
  }
  return null;
}

function SetupLadder(props: { state: SandboxerCliState | undefined; offered: boolean }) {
  const installed = props.state !== "cli_missing";
  const account = ACCOUNT_STATES.has(props.state);
  const ready = props.state === "signed_in";
  const steps = [
    { label: "Install CLI", done: installed },
    { label: account ? "Finish account setup" : "Sign in", done: ready },
    { label: "Offer to threads", done: ready && props.offered },
  ];
  const current = steps.findIndex((step) => !step.done);
  return (
    <ol aria-label="Sandboxer setup" className="settings-sandboxer-ladder">
      {steps.map((step, index) => (
        <li
          aria-current={index === current ? "step" : undefined}
          className={`settings-sandboxer-ladder__step${
            step.done ? " is-done" : index === current ? " is-current" : ""
          }`}
          key={step.label}
        >
          <span aria-hidden="true" className="settings-sandboxer-ladder__mark">
            {step.done ? "✓" : index + 1}
          </span>
          {step.label}
          {step.done ? <span className="settings-sandboxer-ladder__done"> (done)</span> : null}
        </li>
      ))}
    </ol>
  );
}

function formatHours(hours: number): string {
  return hours >= 100 ? Math.round(hours).toLocaleString() : hours.toFixed(1);
}

/** Which account the CLI login bills, and how much time it has left. */
function AccountLine(props: {
  connection: McpConnectionStatus;
  desktopApi?: DesktopApi;
  onNotice: (notice: Notice) => void;
}) {
  const account = props.connection.sandboxerAccount;
  const state = props.connection.sandboxerCliState;
  if (!account?.email && state !== "signed_in") return null;
  const parts: string[] = [];
  if (account?.planDollars !== undefined) parts.push(`$${account.planDollars}/month`);
  else if (state === "no_plan") parts.push("no plan yet");
  if (account?.creditBalanceHours !== undefined && state !== "no_plan") {
    parts.push(account.creditBalanceHours > 0
      ? `${formatHours(account.creditBalanceHours)} h credit left`
      : "no machine time left");
  }
  return (
    <p className="settings-sandboxer-account">
      <span>
        {account?.email ? (
          <>
            Signed in as <strong>{account.email}</strong>
          </>
        ) : "Signed in"}
        {parts.map((part) => ` · ${part}`).join("")}
      </span>
      {state === "signed_in" ? (
        <SandboxerLink
          desktopApi={props.desktopApi}
          label="Open dashboard"
          target="dashboard"
          title="Open the Sandboxer dashboard, signed in with this machine's CLI login."
          variant="inline"
          onNotice={props.onNotice}
        />
      ) : null}
    </p>
  );
}

/**
 * Everything under the row's header line: what Sandboxer is (until it is
 * set up), where setup stands, the billed account, and the next step.
 */
export function SandboxerSetupDetail(props: {
  connection: McpConnectionStatus;
  desktopApi?: DesktopApi;
  detail: string;
  onNotice: (notice: Notice) => void;
}) {
  const state = props.connection.sandboxerCliState;
  const needsSetup = sandboxerNeedsSetup(props.connection);
  const link = (target: SandboxerLinkTarget, label: string) => (
    <SandboxerLink
      desktopApi={props.desktopApi}
      key={target}
      label={label}
      target={target}
      onNotice={props.onNotice}
    />
  );
  return (
    <>
      {state === "cli_missing" ? (
        <div className="settings-sandboxer-about">
          <p>
            <strong>Sandboxer</strong> runs cloud Linux machines your agent can build,
            test, and host apps on, while the thread stays on this computer. It is a
            separate paid service, billed per second while a machine runs.
          </p>
          <div className="settings-sandboxer-links">
            {link("home", "What is Sandboxer?")}
            {link("pricing", "Pricing")}
            {link("quickstart", "Docs")}
          </div>
        </div>
      ) : null}
      {needsSetup ? (
        <SetupLadder offered={props.connection.enabled} state={state} />
      ) : null}
      <AccountLine
        connection={props.connection}
        desktopApi={props.desktopApi}
        onNotice={props.onNotice}
      />
      <p className="settings-mcp-row__state">{props.detail}</p>
      {state === "not_signed_in" || state === "no_plan" ? (
        <div className="settings-sandboxer-links">
          {state === "not_signed_in" ? link("home", "What is Sandboxer?") : null}
          {link("pricing", "Pricing")}
        </div>
      ) : null}
    </>
  );
}

/** The drawer's extras: the exact launched command and Sandboxer's docs. */
export function SandboxerDrawerDetail(props: {
  desktopApi?: DesktopApi;
  onNotice: (notice: Notice) => void;
}) {
  return (
    <dl className="settings-sandboxer-drawer">
      <div>
        <dt>Runs</dt>
        <dd>
          <code>{SANDBOXER_RUNS_COMMAND}</code>
        </dd>
      </div>
      <div>
        <dt>Docs</dt>
        <dd className="settings-sandboxer-links">
          <SandboxerLink desktopApi={props.desktopApi} label="MCP server" target="docs_mcp" onNotice={props.onNotice} />
          <SandboxerLink desktopApi={props.desktopApi} label="Machines & sizes" target="docs_machines" onNotice={props.onNotice} />
          <SandboxerLink desktopApi={props.desktopApi} label="Billing" target="docs_billing" onNotice={props.onNotice} />
        </dd>
      </div>
    </dl>
  );
}

/**
 * Decision A: an operator without the CLI gets one line, not a setup row
 * with chips and switches for a service they may never use.
 */
export function SandboxerCompactRow(props: {
  desktopApi?: DesktopApi;
  onNotice: (notice: Notice) => void;
  onSetUp: () => void;
}) {
  return (
    <article className="settings-mcp-row settings-mcp-row--managed settings-mcp-row--compact">
      <div className="settings-mcp-row__main">
        <span className="settings-mcp-row__toggle settings-mcp-row__toggle--static">
          <span className="settings-mcp-row__name">Sandboxer</span>
          <span className="settings-mcp-row__meta">
            Cloud Linux machines for your agent &middot; paid service
          </span>
        </span>
        <div className="settings-mcp-row__actions">
          <SandboxerLink
            desktopApi={props.desktopApi}
            label="Learn more"
            target="home"
            variant="inline"
            onNotice={props.onNotice}
          />
          <button
            aria-label="Set up Sandboxer"
            className="button button--secondary"
            type="button"
            onClick={props.onSetUp}
          >
            Set up
          </button>
        </div>
      </div>
    </article>
  );
}
