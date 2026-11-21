import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  BOAT_ORIGIN,
  normalizeBoatApiKey,
  redactBoatApiKeys,
  type BoatSignInMethod,
  type BoatSignInProgress,
} from "@pwragent/shared/contracts/mcp-connections";

/**
 * Browser sign-in to Boat, without a key ever being typed, pasted, or left
 * in a file.
 *
 * Boat has no OAuth for third-party apps. Its CLI has a browser sign-in and
 * can create a scoped, expiring API key. PwrAgent runs that CLI with a
 * private, throwaway home directory:
 *
 * 1. `boat login --json` answers a URL and a short code. PwrAgent shows the
 *    code first, so the operator can copy it, and opens the URL when they
 *    ask; they approve in the browser.
 * 2. `boat login --wait --json` returns once they have.
 * 3. `boat api-key create` mints a key limited to sandbox actions. It goes
 *    straight from the CLI's output to PwrAgent's encrypted store.
 * 4. `boat logout` revokes the session the CLI opened, and the throwaway
 *    home is deleted.
 *
 * The CLI keeps its session token in a plain file. Here that file exists
 * only inside the throwaway home, only between steps 2 and 4. The
 * operator's own CLI login, if they have one, is never read or changed.
 */

export const BOAT_CLI_INSTALL_PATH = join(".ascii", "bin", process.platform === "win32" ? "boat.exe" : "boat");
/**
 * What the minted key may do: one action per kind of request the Boat tools
 * make, and nothing else. Boat's `full-sandbox` preset is not enough: it
 * leaves out create, resume, fork and delete. No SSH, desktop stream, agent
 * prompt, environment or account write is granted.
 *
 * `sandbox.delete` rather than `sandbox.delete-own`: a key from a later
 * sign-in must still delete what an earlier key created, or cleanup after a
 * pull request closes would leave those sandboxes billing. PwrAgent, the
 * key's only holder, limits each thread to the sandboxes it created.
 */
export const BOAT_KEY_ACTIONS = [
  "sandbox.create",
  "sandbox.read",
  "sandbox.update",
  "sandbox.stop",
  "sandbox.resume",
  "sandbox.fork",
  "sandbox.delete",
  "exec",
  "file.read",
  "file.write",
  "host",
  "account.read",
] as const;
/** The key PwrAgent mints: those actions only, and it expires. */
export const BOAT_KEY_ARGS = [
  "api-key", "create", "PwrAgent", "--actions", BOAT_KEY_ACTIONS.join(","), "--ttl", "90d", "--json",
] as const;

const START_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 30_000;
/** Boat's links last minutes; this bounds one that reports no expiry. */
const MAX_WAIT_MS = 15 * 60_000;
const CLI_RECHECK_MS = 30_000;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const USER_CODE_PATTERN = /^[A-Z0-9]{2,8}(?:-[A-Z0-9]{2,8}){0,3}$/;

export type BoatCliRun = (
  cli: string,
  args: readonly string[],
  options: { home: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<string>;

export type BoatSignInOptions = {
  /** Stores a freshly minted key. Rejects when Boat refuses it. */
  storeKey: (key: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  /** Progress changed: started, finished, failed or cancelled. */
  onChanged: () => void;
  run?: BoatCliRun;
  findCli?: () => Promise<string | undefined>;
  makeHome?: () => Promise<string>;
  removeHome?: (home: string) => Promise<void>;
  now?: () => number;
};

type Attempt = { home: string; cli: string; controller: AbortController; url?: string };

export class BoatSignIn {
  private attempt?: Attempt;
  private current?: BoatSignInProgress;
  private cliKnown?: boolean;
  private cliAskedAt?: number;
  private readonly run: BoatCliRun;
  private readonly findCli: () => Promise<string | undefined>;
  private readonly makeHome: () => Promise<string>;
  private readonly removeHome: (home: string) => Promise<void>;

  constructor(private readonly options: BoatSignInOptions) {
    this.run = options.run ?? runBoatCli;
    this.findCli = options.findCli ?? findBoatCli;
    this.makeHome = options.makeHome ?? makePrivateHome;
    this.removeHome = options.removeHome ?? (async (home) => await rm(home, { recursive: true, force: true }));
  }

  /** The sign-in in flight or the last one's failure. Never holds a key. */
  progress(): BoatSignInProgress | undefined {
    return this.current;
  }

  async cliAvailable(): Promise<boolean> {
    this.cliKnown = (await this.findCli().catch(() => undefined)) !== undefined;
    return this.cliKnown;
  }

  /**
   * The last answer, for a read that must not wait. Asks again unseen, at
   * most once per `CLI_RECHECK_MS`: the answer changes only on an install.
   */
  cliAvailableCached(): boolean | undefined {
    const now = this.now();
    if (this.cliAskedAt === undefined || now - this.cliAskedAt >= CLI_RECHECK_MS) {
      this.cliAskedAt = now;
      void this.cliAvailable();
    }
    return this.cliKnown;
  }

  /**
   * Starts a sign-in. Resolves once the code is known; the rest runs on its
   * own and reports through `onChanged`. Boat's page is not opened here: the
   * operator copies the code first, then asks for the page with `openPage`.
   */
  async start(method: BoatSignInMethod): Promise<BoatSignInProgress> {
    await this.cancel();
    const cli = await this.findCli();
    if (!cli) throw new Error("The Boat CLI is not installed on this computer.");
    const attempt: Attempt = { home: await this.makeHome(), cli, controller: new AbortController() };
    this.attempt = attempt;
    let link: { url: string; userCode: string; expiresAt: number };
    try {
      link = readLoginLink(
        await this.run(cli, ["login", "--json", ...(method === "google" ? ["--google"] : [])], {
          home: attempt.home, timeoutMs: START_TIMEOUT_MS, signal: attempt.controller.signal,
        }),
        this.now(),
      );
    } catch (error) {
      await this.release(attempt);
      throw new Error(describeFailure(error, "Could not start Boat sign-in."), { cause: error });
    }
    attempt.url = link.url;
    this.current = { state: "waiting", method, userCode: link.userCode, expiresAt: link.expiresAt };
    this.options.onChanged();
    void this.finish(attempt, link.expiresAt);
    return this.current;
  }

  /** Opens Boat's page for the sign-in in flight. It may be opened again. */
  async openPage(): Promise<void> {
    const url = this.attempt?.url;
    if (!url) throw new Error("That Boat sign-in is no longer waiting. Start it again.");
    try {
      await this.options.openExternal(url);
    } catch (error) {
      throw new Error("Could not open Boat's sign-in page.", { cause: error });
    }
  }

  /** Stops waiting. The link already open in the browser stops mattering. */
  async cancel(): Promise<void> {
    const attempt = this.attempt;
    const had = this.current !== undefined;
    this.current = undefined;
    if (attempt) {
      attempt.controller.abort();
      await this.release(attempt);
    }
    if (attempt || had) this.options.onChanged();
  }

  private async finish(attempt: Attempt, expiresAt: number): Promise<void> {
    const { cli, home, controller } = attempt;
    const signal = controller.signal;
    let signedIn = false;
    // A key Boat created that PwrAgent did not manage to store.
    let unstoredKeyId: string | undefined;
    try {
      const waitMs = Math.min(Math.max(expiresAt - this.now(), 10_000), MAX_WAIT_MS) + 5_000;
      await this.run(cli, ["login", "--wait", "--json"], { home, timeoutMs: waitMs, signal });
      signedIn = true;
      const created = await this.run(cli, BOAT_KEY_ARGS, { home, timeoutMs: STEP_TIMEOUT_MS, signal });
      unstoredKeyId = findKeyId(created);
      const key = findKey(created);
      if (!key) throw new Error("Boat signed in but returned no API key.");
      signal.throwIfAborted();
      await this.options.storeKey(key);
      unstoredKeyId = undefined;
      if (this.attempt === attempt) this.current = undefined;
    } catch (error) {
      if (this.attempt === attempt && !signal.aborted) {
        this.current = {
          state: "failed",
          error: describeFailure(error, signedIn
            ? "Signed in to Boat, but could not create an API key."
            : "Boat sign-in did not finish."),
        };
      }
    } finally {
      if (unstoredKeyId) {
        // Nobody holds this key's secret now. Left alone it would stay valid
        // at Boat until it expires.
        await this.run(cli, ["api-key", "revoke", unstoredKeyId, "--json"], { home, timeoutMs: STEP_TIMEOUT_MS })
          .catch(() => undefined);
      }
      if (signedIn) {
        // Revokes the session this sign-in opened. The key outlives it.
        await this.run(cli, ["logout"], { home, timeoutMs: STEP_TIMEOUT_MS }).catch(() => undefined);
      }
      const wasCurrent = this.attempt === attempt;
      await this.release(attempt);
      if (wasCurrent) this.options.onChanged();
    }
  }

  private async release(attempt: Attempt): Promise<void> {
    if (this.attempt === attempt) this.attempt = undefined;
    await this.removeHome(attempt.home).catch(() => undefined);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/** The `login_url` event from `boat login --json`. Throws on anything else. */
function readLoginLink(stdout: string, now: number): { url: string; userCode: string; expiresAt: number } {
  for (const line of stdout.split("\n").toReversed()) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const { url, userCode, expiresAt } = event as Record<string, unknown>;
    if (typeof url !== "string" || typeof userCode !== "string") continue;
    // Only Boat's own sign-in page is ever opened.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.origin !== BOAT_ORIGIN) throw new Error("Boat's CLI answered a sign-in link that is not on boat.dev.");
    if (!USER_CODE_PATTERN.test(userCode)) continue;
    const expires = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
    return {
      url: parsed.href,
      userCode,
      expiresAt: Number.isFinite(expires) && expires > now ? Math.min(expires, now + MAX_WAIT_MS) : now + MAX_WAIT_MS,
    };
  }
  throw new Error("Boat's CLI did not answer a sign-in link.");
}

/** The one key-shaped string in `boat api-key create --json`, wherever it sits. */
function findKey(stdout: string): string | undefined {
  const found = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6) return;
    if (typeof value === "string") {
      const key = normalizeBoatApiKey(value);
      if (key) found.add(key);
    } else if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
    } else if (value && typeof value === "object") {
      for (const entry of Object.values(value)) visit(entry, depth + 1);
    }
  };
  for (const line of [stdout, ...stdout.split("\n")]) {
    try {
      visit(JSON.parse(line), 0);
    } catch {
      // Not JSON; another line may be.
    }
  }
  // A prefix or masked copy beside the secret is shorter than the secret.
  return [...found].toSorted((left, right) => right.length - left.length)[0];
}

/** The new key's id, `apiKey.id` in `boat api-key create --json`. */
function findKeyId(stdout: string): string | undefined {
  for (const line of [stdout, ...stdout.split("\n")]) {
    try {
      const parsed = JSON.parse(line) as { apiKey?: { id?: unknown } } | null;
      const id = parsed?.apiKey?.id;
      if (typeof id === "string" && KEY_ID_PATTERN.test(id)) return id;
    } catch {
      // Not JSON; another line may be.
    }
  }
  return undefined;
}

function describeFailure(error: unknown, fallback: string): string {
  const said = error instanceof Error ? error.message : "";
  const detail = redactBoatApiKeys(said).replace(/\s+/g, " ").trim().slice(0, 240);
  return detail && !detail.startsWith("Command failed") ? detail : fallback;
}

async function findBoatCli(): Promise<string | undefined> {
  const name = process.platform === "win32" ? "boat.exe" : "boat";
  const candidates = [
    join(homedir(), BOAT_CLI_INSTALL_PATH),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, name)),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

async function makePrivateHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "pwragent-boat-"));
  await chmod(home, 0o700);
  return home;
}

/**
 * Runs the Boat CLI with `home` as its only home: nothing it writes lands in
 * the operator's own, and nothing of theirs (a login, `BOAT_ORG`) is read.
 */
const runBoatCli: BoatCliRun = async (cli, args, options) =>
  await new Promise((resolve, reject) => {
    execFile(cli, [...args], {
      timeout: options.timeoutMs,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      ...(options.signal ? { signal: options.signal } : {}),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: options.home,
        USERPROFILE: options.home,
        APPDATA: options.home,
        LOCALAPPDATA: options.home,
        XDG_CONFIG_HOME: join(options.home, ".config"),
        BOAT_NO_UPDATE: "1",
      },
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout);
        return;
      }
      // The CLI's own words, never its output: stdout may hold a key.
      const said = String(stderr).trim().split("\n").at(-1) ?? "";
      reject(new Error(said || error.message));
    });
  });
