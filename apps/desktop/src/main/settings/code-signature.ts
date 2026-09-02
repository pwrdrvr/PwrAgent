import { execFile as execFileCallback } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  DesktopCodeSignature,
  DesktopCodeSignatureTrust,
} from "@pwragent/shared";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";

const execFile = promisify(execFileCallback);

/**
 * Reads what a platform's code-signing system says about an executable
 * PwrAgent runs but does not ship — the editor, the terminal, `git`, `gh`.
 *
 * Deliberately NOT part of discovery. Discovery already spawns a
 * `--version` probe per candidate on startup; folding signature probes in
 * would add spawns to a path that runs whether or not anyone opens
 * Settings. This module is driven by an IPC call the settings panes make
 * for the rows they render, and every answer is cached on the file's
 * identity, so a pane that re-renders costs nothing.
 *
 * ## Why not `spctl`
 *
 * Gatekeeper assessment is an app-launch policy, not a signature reader.
 * Measured on macOS 25.6, `spctl -a -t exec /usr/bin/git` reports
 * "rejected (the code is valid but does not seem to be an app)" — for
 * Apple's own git. Wiring that to a chip would paint the most trustworthy
 * binary on the machine red.
 *
 * ## What the levels actually claim
 *
 * `codesign -d` displays a signature; it does not verify one. So
 * `platform`, `adhoc` and `unsigned` are claims read off the file. The
 * Developer ID path is the exception: `codesign --verify -R="notarized"`
 * verifies as well as checks the notarization requirement, which is what
 * lets `notarized` and `invalid` be distinguished from each other. We do
 * not run a standalone `--verify` pass for the other levels, because
 * hashing an entire application bundle to confirm what is already the
 * weaker claim is not worth the seconds.
 */

/** macOS `Authority=` leaf for a binary signed by Apple itself. */
const APPLE_PLATFORM_AUTHORITIES = new Set([
  "Software Signing",
  "macOS Software Signing",
]);

const DEVELOPER_ID_AUTHORITY_PREFIX = "Developer ID Application";

const CODESIGN_TIMEOUT_MS = 5_000;
const NOTARIZATION_TIMEOUT_MS = 10_000;
const POWERSHELL_TIMEOUT_MS = 15_000;

/**
 * Signature probes spawn a subprocess each, and a settings pane can ask
 * about a dozen paths at once. Cap the parallelism so opening Settings
 * cannot put a burst of `codesign` processes on the machine.
 */
const MAX_CONCURRENT_PROBES = 4;

type CacheEntry = {
  key: string;
  signature: DesktopCodeSignature;
};

export type CodeSignatureInspectorOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

export class CodeSignatureInspector {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<DesktopCodeSignature>>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(options: CodeSignatureInspectorOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
  }

  async inspectMany(paths: string[]): Promise<DesktopCodeSignature[]> {
    const unique = [...new Set(paths.map((value) => value.trim()).filter(Boolean))];
    return await Promise.all(unique.map((path) => this.inspect(path)));
  }

  async inspect(path: string): Promise<DesktopCodeSignature> {
    if (this.platform !== "darwin" && this.platform !== "win32") {
      return { path, trust: "unsupported" };
    }

    // Checked before the `stat` below, not after. Two callers that arrive
    // together would otherwise both suspend on their own `stat`, both
    // resume to an empty map, and both spawn a probe for the same file.
    const inFlight = this.inFlight.get(path);
    if (inFlight) return await inFlight;

    // Identity is the file itself, not its name: a Homebrew upgrade
    // rewrites `/opt/homebrew/bin/git` in place, and the cache has to
    // notice. mtime + size is what `stat` can give cheaply.
    const key = await this.readFileIdentity(path);
    const cached = this.cache.get(path);
    if (cached && key && cached.key === key) {
      return cached.signature;
    }

    // Re-checked: another caller can have registered a probe while this one
    // was suspended on `stat`.
    const pending = this.inFlight.get(path);
    if (pending) return await pending;

    const promise = this.withSlot(async () => await this.probe(path))
      .then((signature) => {
        if (key) {
          this.cache.set(path, { key, signature });
        }
        return signature;
      })
      .finally(() => {
        this.inFlight.delete(path);
      });
    this.inFlight.set(path, promise);
    return await promise;
  }

  private async readFileIdentity(path: string): Promise<string | undefined> {
    try {
      const stats = await stat(path);
      return `${stats.mtimeMs}:${stats.size}`;
    } catch {
      // An unreadable path still gets probed — the probe's own error is
      // the useful answer — it just is not cached.
      return undefined;
    }
  }

  /**
   * Claims the slot before suspending, and hands it directly to the next
   * waiter instead of releasing it back to the pool.
   *
   * Incrementing after the `await` was the bug: the released waiter only
   * increments once its microtask runs, so any call arriving in that
   * window read a count that was one too low, passed the check, and the
   * limit was exceeded. Waking a waiter now leaves `active` untouched —
   * the slot is transferred, never briefly free — so no arrival can slip
   * through it, and a re-check on resume keeps a `while` unnecessary.
   */
  private async withSlot<T>(run: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT_PROBES) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await run();
    } finally {
      const next = this.queue.shift();
      if (next) {
        next();
      } else {
        this.active -= 1;
      }
    }
  }

  /**
   * The one subprocess-spawning step, kept `protected` so a test can
   * substitute it. Everything above it — the identity cache, the in-flight
   * dedupe, the concurrency limit — is platform-independent logic that
   * would otherwise only be reachable by running `codesign` for real.
   */
  protected async probe(path: string): Promise<DesktopCodeSignature> {
    return this.platform === "win32"
      ? await this.probeWindows(path)
      : await this.probeMac(path);
  }

  private async probeMac(path: string): Promise<DesktopCodeSignature> {
    const display = await this.runCodesignDisplay(path);
    if (!display) {
      return {
        path,
        trust: "unknown",
        detail: "codesign did not run",
      };
    }

    const parsed = parseCodesignDisplay(display);
    if (parsed.trust !== "publisher") {
      return { path, ...parsed };
    }

    // Only a Developer ID signature can be notarized, and the check is
    // the one expensive probe here (0.3-0.6s on an application bundle),
    // so it is gated behind that.
    if (!parsed.signer?.startsWith(DEVELOPER_ID_AUTHORITY_PREFIX)) {
      return { path, ...parsed };
    }

    const notarization = await this.runNotarizationCheck(path);
    if (notarization === "notarized") {
      return { path, ...parsed, trust: "notarized" };
    }
    if (notarization === "invalid") {
      return {
        path,
        ...parsed,
        trust: "invalid",
        detail: "The signature did not verify.",
      };
    }
    return { path, ...parsed };
  }

  private async runCodesignDisplay(path: string): Promise<string | undefined> {
    try {
      const result = await execFile("codesign", ["-dvvv", "--", path], {
        env: buildPwrAgentChildProcessEnv(this.env),
        timeout: CODESIGN_TIMEOUT_MS,
      });
      // `codesign -d` writes its report to stderr, always.
      return `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    } catch (error) {
      const stderr = readProcessOutput(error);
      // A non-zero exit is normal here: an unsigned file exits 1 while
      // still printing the line that classifies it.
      return stderr || undefined;
    }
  }

  private async runNotarizationCheck(
    path: string,
  ): Promise<"notarized" | "not-notarized" | "invalid"> {
    try {
      await execFile(
        "codesign",
        ["--verify", "-R=notarized", "--check-notarization", "--", path],
        {
          env: buildPwrAgentChildProcessEnv(this.env),
          timeout: NOTARIZATION_TIMEOUT_MS,
        },
      );
      return "notarized";
    } catch (error) {
      const output = readProcessOutput(error);
      // The requirement failing means the signature verified and simply
      // carries no notarization ticket. Anything else means verification
      // itself failed.
      return output.includes("failed to satisfy specified code requirement")
        ? "not-notarized"
        : "invalid";
    }
  }

  private async probeWindows(path: string): Promise<DesktopCodeSignature> {
    // The path travels in the environment rather than the command string
    // so no quoting or escaping of an operator-chosen path is required.
    const script =
      "$ErrorActionPreference='Stop';"
      + "$s = Get-AuthenticodeSignature -LiteralPath $env:PWRAGENT_SIGNATURE_PATH;"
      + "[pscustomobject]@{"
      + "status=$s.Status.ToString();"
      + "subject=$(if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '' })"
      + "} | ConvertTo-Json -Compress";

    try {
      const result = await execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          env: {
            ...buildPwrAgentChildProcessEnv(this.env),
            PWRAGENT_SIGNATURE_PATH: path,
          },
          timeout: POWERSHELL_TIMEOUT_MS,
        },
      );
      return { path, ...parseAuthenticodeOutput(result.stdout) };
    } catch (error) {
      return {
        path,
        trust: "unknown",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

type ParsedSignature = {
  trust: DesktopCodeSignatureTrust;
  signer?: string;
  teamId?: string;
  detail?: string;
};

export function parseCodesignDisplay(output: string): ParsedSignature {
  if (/code object is not signed at all/i.test(output)) {
    return { trust: "unsigned" };
  }
  if (/(No such file|does not exist|bundle format unrecognized)/i.test(output)) {
    return { trust: "unknown", detail: firstLine(output) };
  }
  if (/invalid signature|code or signature have been modified/i.test(output)) {
    return { trust: "invalid", detail: firstLine(output) };
  }

  const teamId = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  const authorities = [...output.matchAll(/^Authority=(.+)$/gm)].map(
    (match) => match[1].trim(),
  );
  const leaf = authorities[0];

  // Ad-hoc is checked after the authority scan because a linker-signed
  // binary reports `flags=0x20002(adhoc,linker-signed)` and no authority
  // at all — the flag, not the missing chain, is what identifies it.
  if (/^Signature=adhoc$/m.test(output) || /flags=0x[0-9a-f]+\([^)]*\badhoc\b/i.test(output)) {
    return { trust: "adhoc" };
  }

  if (!leaf) {
    return {
      trust: "unknown",
      detail: "codesign reported no signing authority.",
    };
  }

  if (APPLE_PLATFORM_AUTHORITIES.has(leaf)) {
    return { trust: "platform", signer: leaf };
  }

  return {
    trust: "publisher",
    signer: leaf,
    ...(teamId && teamId !== "not set" ? { teamId } : {}),
  };
}

export function parseAuthenticodeOutput(stdout: string): ParsedSignature {
  let parsed: { status?: unknown; subject?: unknown };
  try {
    parsed = JSON.parse(stdout.trim()) as typeof parsed;
  } catch {
    return {
      trust: "unknown",
      detail: "Get-AuthenticodeSignature returned no result.",
    };
  }

  const status = typeof parsed.status === "string" ? parsed.status : "";
  const signer = readCertificateCommonName(
    typeof parsed.subject === "string" ? parsed.subject : "",
  );

  if (status === "Valid") {
    return { trust: "publisher", ...(signer ? { signer } : {}) };
  }
  if (status === "NotSigned") {
    return { trust: "unsigned" };
  }
  if (!status) {
    return { trust: "unknown" };
  }
  return { trust: "invalid", detail: status, ...(signer ? { signer } : {}) };
}

/**
 * An Authenticode subject is a full DN — `CN=Foo, O=Foo, L=…`. Only the
 * common name is worth showing, and a quoted CN may itself contain a
 * comma, so the value is read up to the next unquoted `, X=` pair.
 */
function readCertificateCommonName(subject: string): string | undefined {
  const match = subject.match(/CN=("([^"]*)"|[^,]*)/);
  const value = (match?.[2] ?? match?.[1] ?? "").trim();
  return value || undefined;
}

function readProcessOutput(error: unknown): string {
  const candidate = error as { stderr?: unknown; stdout?: unknown } | undefined;
  const stderr = typeof candidate?.stderr === "string" ? candidate.stderr : "";
  const stdout = typeof candidate?.stdout === "string" ? candidate.stdout : "";
  return `${stderr}\n${stdout}`.trim();
}

function firstLine(output: string): string | undefined {
  return output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}
