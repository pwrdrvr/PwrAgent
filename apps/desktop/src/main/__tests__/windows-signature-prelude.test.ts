import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  WINDOWS_SIGNATURE_PRELUDE,
  windowsSignatureVerification,
} from "../acp/grok-managed-runtime";

const releaseScriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "scripts",
  "release.mjs",
);

describe("Windows Authenticode verification prelude", () => {
  // The release script cannot import main-process TypeScript, so it carries its
  // own copy. Keep the two in lockstep: a v1.1.0-alpha.1 release failed because
  // `Get-AuthenticodeSignature` could not autoload Microsoft.PowerShell.Security,
  // and a repair that lands in only one caller leaves the other broken.
  it("matches the copy embedded in the release script", () => {
    const releaseScript = readFileSync(releaseScriptPath, "utf8");
    for (const statement of WINDOWS_SIGNATURE_PRELUDE) {
      expect(releaseScript).toContain(JSON.stringify(statement).slice(1, -1));
    }
  });

  // `-Command <string>` must be the last argument: PowerShell appends anything
  // after it to the command text rather than binding it to $args, so a path
  // passed as a trailing argument turns the script into a parse error and the
  // check fails on every packaged Windows build.
  it("passes the verified paths through the environment, not argv", () => {
    const { args, env } = windowsSignatureVerification(
      "C:\\Program Files\\PwrAgent\\PwrAgent.exe",
      "C:\\Users\\me\\.pwragent\\agents\\grok\\grok.exe",
    );
    expect(args[args.length - 2]).toBe("-Command");
    expect(args).toHaveLength(5);
    expect(args.join(" ")).not.toContain("$args[");
    expect(args[4]).toContain("$env:PWRAGENT_VERIFY_APPLICATION");
    expect(args[4]).toContain("$env:PWRAGENT_VERIFY_RUNTIME");
    expect(env).toEqual({
      PWRAGENT_VERIFY_APPLICATION: "C:\\Program Files\\PwrAgent\\PwrAgent.exe",
      PWRAGENT_VERIFY_RUNTIME:
        "C:\\Users\\me\\.pwragent\\agents\\grok\\grok.exe",
    });
  });

  it.runIf(process.platform === "win32")(
    "resolves Get-AuthenticodeSignature under Windows PowerShell",
    () => {
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const signedSystemFile = join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          [
            ...WINDOWS_SIGNATURE_PRELUDE,
            "(Get-AuthenticodeSignature -LiteralPath $env:PWRAGENT_VERIFY_EXECUTABLE).Status",
          ].join("; "),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PWRAGENT_VERIFY_EXECUTABLE: signedSystemFile,
          },
        },
      );
      expect(
        `${result.stdout ?? ""}${result.stderr ?? ""}`,
      ).not.toContain("could not be loaded");
      expect(result.status).toBe(0);
      expect((result.stdout ?? "").trim()).not.toBe("");
    },
  );

  const publisher = "CN=PwrDrvr LLC, O=PwrDrvr LLC, L=Aberdeen, S=New Jersey, C=US";
  const applicationCertificate = {
    Subject: publisher,
    Issuer: "CN=Microsoft ID Verified CS EOC CA 03, O=Microsoft Corporation, C=US",
  };
  const runtimeCertificate = {
    Subject: publisher,
    Issuer: "CN=Microsoft ID Verified CS AOC CA 03, O=Microsoft Corporation, C=US",
  };
  const application = { Status: "Valid", SignerCertificate: applicationCertificate };
  const runtime = { Status: "Valid", SignerCertificate: runtimeCertificate };

  it.runIf(process.platform === "win32").each([
    { name: "accepts a trusted publisher across issuer rotation", application, runtime, status: 0, message: "" },
    {
      name: "rejects an unsigned application",
      application: { ...application, Status: "NotSigned" },
      runtime,
      status: 1,
      message: "The installed PwrAgent executable does not have a valid Windows signature (NotSigned).",
    },
    {
      name: "rejects a modified runtime",
      application,
      runtime: { ...runtime, Status: "HashMismatch" },
      status: 1,
      message: "The managed runtime does not have a valid Windows signature (HashMismatch).",
    },
    {
      name: "rejects an untrusted runtime",
      application,
      runtime: { ...runtime, Status: "NotTrusted" },
      status: 1,
      message: "The managed runtime does not have a valid Windows signature (NotTrusted).",
    },
    {
      name: "rejects a missing application certificate",
      application: { ...application, SignerCertificate: null },
      runtime,
      status: 1,
      message: "Windows did not return a signing certificate for PwrAgent or the managed runtime.",
    },
    {
      name: "rejects a missing runtime certificate",
      application,
      runtime: { ...runtime, SignerCertificate: null },
      status: 1,
      message: "Windows did not return a signing certificate for PwrAgent or the managed runtime.",
    },
    {
      name: "rejects a different publisher under the same issuer",
      application,
      runtime: { ...runtime, SignerCertificate: { ...applicationCertificate, Subject: "CN=Another Publisher, O=Another Publisher, C=US" } },
      status: 1,
      message: "The managed runtime publisher does not match this PwrAgent build.",
    },
    {
      name: "compares the full publisher identity",
      application,
      runtime: { ...runtime, SignerCertificate: { ...runtimeCertificate, Subject: "CN=PwrDrvr LLC, O=Another Publisher, C=US" } },
      status: 1,
      message: "The managed runtime publisher does not match this PwrAgent build.",
    },
  ])("$name", ({ application, runtime, status, message }) => {
    const verification = windowsSignatureVerification("application.exe", "runtime.exe");
    const fixture = JSON.stringify({ application, runtime }).replace(/'/gu, "''");
    // Exercise the actual PowerShell comparison with controlled trust results;
    // the separate native test above still calls Windows Authenticode itself.
    const script = [
      `$fixture = '${fixture}' | ConvertFrom-Json`,
      "function Get-AuthenticodeSignature { param([string]$LiteralPath) if ($LiteralPath -eq $env:PWRAGENT_VERIFY_APPLICATION) { $fixture.application } else { $fixture.runtime } }",
      verification.args[4],
    ].join("; ");
    const result = spawnSync("powershell.exe", [...verification.args.slice(0, 4), script], {
      encoding: "utf8",
      env: { ...process.env, ...verification.env },
    });
    expect(result.status, result.stderr).toBe(status);
    expect(result.stdout.trim()).toBe(message);
  });
});
