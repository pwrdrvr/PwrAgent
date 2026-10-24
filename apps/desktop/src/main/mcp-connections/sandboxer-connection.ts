import { execFile } from "node:child_process";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { shell } from "electron";
import {
  SANDBOXER_CLI_PATH,
  SANDBOXER_MCP_LAUNCH_ARGS,
  SANDBOXER_SETUP_COMMAND,
  type McpConnectionStatus,
  type OpenSandboxerLinkResponse,
  type SandboxerAccountSummary,
  type SandboxerCliState,
  type SandboxerLinkTarget,
} from "@pwragent/shared";

export { SANDBOXER_CLI_PATH, SANDBOXER_MCP_ARGS, SANDBOXER_SETUP_COMMAND } from "@pwragent/shared";

const SANDBOXER_ORIGIN = "https://sandboxer.com";

/** Every page Settings opens. The dashboard link comes from the CLI. */
export const SANDBOXER_LINKS: Record<Exclude<SandboxerLinkTarget, "dashboard">, string> = {
  home: `${SANDBOXER_ORIGIN}/`,
  pricing: `${SANDBOXER_ORIGIN}/pricing`,
  quickstart: `${SANDBOXER_ORIGIN}/docs/quickstart`,
  docs_mcp: `${SANDBOXER_ORIGIN}/docs/mcp`,
  docs_machines: `${SANDBOXER_ORIGIN}/docs/machines`,
  docs_billing: `${SANDBOXER_ORIGIN}/docs/billing`,
};

type CliStatus = Pick<
  McpConnectionStatus,
  "configured" | "state" | "detail" | "sandboxerCliState" | "sandboxerAccount"
>;
type RunCli = () => Promise<string>;

type CliStatusJson = {
  signedIn?: boolean;
  apiReachable?: boolean;
  user?: { email?: unknown };
  plan?: {
    canStart?: unknown;
    billingStatus?: unknown;
    creditBalanceHours?: unknown;
    dollars?: unknown;
  };
};

const ACCOUNT_DETAILS: Record<"no_plan" | "billing_issue" | "out_of_credit" | "cannot_start", string> = {
  no_plan: `Sandboxer needs a plan before it can start a machine. Run ${SANDBOXER_SETUP_COMMAND} in a terminal: it skips the sign-in and opens the plan checkout. New accounts start with a trial.`,
  billing_issue: "Sandboxer can't charge the card on file, so new sandboxes won't start. Update billing in the Sandboxer dashboard, then refresh status.",
  out_of_credit: "This Sandboxer account has no machine time left, so new sandboxes won't start. Add time in the Sandboxer dashboard, then refresh status.",
  cannot_start: "Sandboxer says this account can't start a sandbox right now. Check the Sandboxer dashboard, then refresh status.",
};

function sandboxerEnvironment(): Record<string, string> {
  const env = getDefaultEnvironment();
  for (const key of ["SANDBOXER_API_KEY", "SANDBOXER_API_URL", "SANDBOXER_ORG", "XDG_CONFIG_HOME"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

function runCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(SANDBOXER_CLI_PATH, [...args, "--json", "--no-update"], {
      timeout: 8_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      env: sandboxerEnvironment(),
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

const runStatus: RunCli = () => runCli(["status"]);
// Prints a one-time signed-in link (15 minutes, no API access) and opens
// nothing itself.
const runDashboard: RunCli = () => runCli(["dashboard", "--no-open"]);

function isSandboxerUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    return new URL(url).origin === SANDBOXER_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Signed in is not the same as able to start a machine. A status without a
 * `plan` comes from an older CLI; treat it as able, rather than block a
 * working setup on a field it never printed.
 */
function accountState(plan: CliStatusJson["plan"]): SandboxerCliState {
  if (!plan || plan.canStart !== false) return "signed_in";
  if (!(typeof plan.dollars === "number" && plan.dollars > 0)) return "no_plan";
  // Only `active` was observed on a working account. A trial may report
  // `trialing`; anything else is a card or plan Sandboxer can't charge.
  if (
    typeof plan.billingStatus === "string"
    && plan.billingStatus !== "active"
    && plan.billingStatus !== "trialing"
  ) {
    return "billing_issue";
  }
  if (typeof plan.creditBalanceHours === "number" && plan.creditBalanceHours <= 0) {
    return "out_of_credit";
  }
  return "cannot_start";
}

function accountSummary(status: CliStatusJson): SandboxerAccountSummary | undefined {
  const account: SandboxerAccountSummary = {};
  if (typeof status.user?.email === "string" && status.user.email) {
    account.email = status.user.email;
  }
  const dollars = status.plan?.dollars;
  if (typeof dollars === "number" && Number.isFinite(dollars) && dollars > 0) {
    account.planDollars = dollars;
  }
  const hours = status.plan?.creditBalanceHours;
  if (typeof hours === "number" && Number.isFinite(hours)) {
    account.creditBalanceHours = Math.max(0, hours);
  }
  return Object.keys(account).length > 0 ? account : undefined;
}

export type SandboxerConnectionOptions = {
  dashboardCommand?: RunCli;
  openExternal?: (url: string) => Promise<void>;
};

/** Owns local CLI discovery only. Credentials remain owned by Sandboxer. */
export class SandboxerConnection {
  private cached?: { at: number; value: CliStatus };
  private pending?: Promise<CliStatus>;

  private readonly dashboardCommand: RunCli;
  private readonly openExternal: (url: string) => Promise<void>;

  constructor(
    private readonly statusCommand: RunCli = runStatus,
    options: SandboxerConnectionOptions = {},
  ) {
    this.dashboardCommand = options.dashboardCommand ?? runDashboard;
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url));
  }

  /** Snapshot for latency-sensitive defaults reads; never starts or awaits a CLI. */
  cachedStatus(): CliStatus {
    return this.cached?.value ?? {
      configured: false,
      state: "connecting",
      detail: "Sandboxer CLI status has not been checked yet. Refresh status in Settings → Plugins.",
    };
  }

  async readStatus(refresh = false): Promise<CliStatus> {
    if (!refresh && this.cached && Date.now() - this.cached.at < 15_000) {
      return this.cached.value;
    }
    if (this.pending) return await this.pending;
    const pending = this.probe().then((value) => {
      this.cached = { at: Date.now(), value };
      return value;
    }).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return await pending;
  }

  /**
   * Opens one of Sandboxer's pages. Only fixed `https://sandboxer.com` URLs
   * open; the dashboard link the CLI prints is checked against that origin.
   */
  async openLink(target: SandboxerLinkTarget): Promise<OpenSandboxerLinkResponse> {
    try {
      let url: string;
      if (target === "dashboard") {
        const printed = (JSON.parse(await this.dashboardCommand()) as { url?: unknown }).url;
        if (!isSandboxerUrl(printed)) {
          return { opened: false, error: "The Sandboxer CLI did not return a dashboard link." };
        }
        url = printed;
      } else {
        url = SANDBOXER_LINKS[target];
      }
      await this.openExternal(url);
      return { opened: true };
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
      return {
        opened: false,
        error: missing
          ? `Sandboxer CLI missing at ${SANDBOXER_CLI_PATH}.`
          : target === "dashboard"
            ? `Could not open the Sandboxer dashboard. Run ${SANDBOXER_CLI_PATH} dashboard in a terminal instead.`
            : "Could not open the Sandboxer page.",
      };
    }
  }

  createTransport(): Transport {
    // Only the official built-in command is allowed. The SDK's default env
    // preserves HOME/PATH for the CLI login. Share only Sandboxer's overrides
    // with status, rather than the desktop's entire secret-bearing environment.
    return new StdioClientTransport({
      command: SANDBOXER_CLI_PATH,
      args: [...SANDBOXER_MCP_LAUNCH_ARGS],
      env: sandboxerEnvironment(),
      stderr: "ignore",
    });
  }

  private async probe(): Promise<CliStatus> {
    try {
      const status = JSON.parse(await this.statusCommand()) as CliStatusJson;
      if (typeof status.signedIn !== "boolean") throw new Error("Invalid CLI status");
      if (!status.signedIn) {
        return {
          configured: false, state: "disconnected", sandboxerCliState: "not_signed_in",
          detail: `Not signed in. Run ${SANDBOXER_SETUP_COMMAND} in a terminal. It signs in an existing account, or creates one and starts the trial, and skips any step already done. PwrAgent uses that login and stores no Sandboxer credentials.`,
        };
      }
      if (status.apiReachable === false) throw new Error("API unavailable");
      const sandboxerCliState = accountState(status.plan);
      const sandboxerAccount = accountSummary(status);
      if (sandboxerCliState !== "signed_in") {
        // Every create would fail, so threads are not offered it yet.
        return {
          configured: false, state: "disconnected", sandboxerCliState,
          detail: ACCOUNT_DETAILS[sandboxerCliState as keyof typeof ACCOUNT_DETAILS],
          ...(sandboxerAccount ? { sandboxerAccount } : {}),
        };
      }
      return {
        configured: true, state: "ready", sandboxerCliState,
        detail: "Signed in through the Sandboxer CLI. Sandboxes bill per second while they run.",
        ...(sandboxerAccount ? { sandboxerAccount } : {}),
      };
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
      return {
        configured: false, state: "temporarily_unavailable",
        sandboxerCliState: missing ? "cli_missing" : "unavailable",
        detail: missing
          ? `Sandboxer CLI missing. Install the official CLI at ${SANDBOXER_CLI_PATH}, then refresh status in Settings → Plugins.`
          : `Could not check Sandboxer. Run ${SANDBOXER_CLI_PATH} status in a terminal, check access and connectivity, then refresh status.`,
      };
    }
  }
}
