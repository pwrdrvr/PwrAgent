import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const MACOS_CODE_MODE_HOST_JIT_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
] as const;

export function missingMacosCodeModeHostJitEntitlements(
  details: string,
): string[] {
  return MACOS_CODE_MODE_HOST_JIT_ENTITLEMENTS.filter((entitlement) => {
    const escaped = escapeRegularExpression(entitlement);
    return !(
      new RegExp(
        `\\[Key\\]\\s+${escaped}\\s+\\[Value\\]\\s+\\[Bool\\]\\s+true`,
        "u",
      ).test(details)
      || new RegExp(
        `<key>\\s*${escaped}\\s*</key>\\s*<true\\s*/>`,
        "u",
      ).test(details)
    );
  });
}

export async function verifyMacosCodeModeHostJitEntitlements(
  command: string,
): Promise<void> {
  const entitlements = await execFile("codesign", [
    "--display",
    "--entitlements",
    "-",
    command,
  ]);
  const entitlementDetails =
    `${entitlements.stdout ?? ""}\n${entitlements.stderr ?? ""}`;
  const missing = missingMacosCodeModeHostJitEntitlements(
    entitlementDetails,
  );
  if (missing.length > 0) {
    throw new Error(
      `Managed Codex Code Mode host is missing required macOS JIT entitlements: ${missing.join(", ")}`,
    );
  }
}

// Windows PowerShell 5.1 inherits the parent process's PSModulePath. When that
// value is PowerShell 7-oriented, autoloading Windows PowerShell's own
// Microsoft.PowerShell.Security fails. Pin its own module locations first.
export const WINDOWS_SIGNATURE_PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "if ($PSVersionTable.PSEdition -ne 'Core') { $env:PSModulePath = \"$PSHOME\\Modules;$env:ProgramFiles\\WindowsPowerShell\\Modules\" }",
  "Import-Module Microsoft.PowerShell.Security",
];

// `powershell.exe -Command <string>` cannot bind trailing arguments to $args,
// so the application and managed-runtime paths travel in the child environment.
export function windowsSignatureVerification(
  applicationCommand: string,
  runtimeCommand: string,
): { args: string[]; env: Record<string, string> } {
  return {
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        ...WINDOWS_SIGNATURE_PRELUDE,
        "$application = Get-AuthenticodeSignature -LiteralPath $env:PWRAGENT_VERIFY_APPLICATION",
        "$runtime = Get-AuthenticodeSignature -LiteralPath $env:PWRAGENT_VERIFY_RUNTIME",
        "if ($application.Status -ne 'Valid') { Write-Output \"The installed PwrAgent executable does not have a valid Windows signature ($($application.Status)).\"; exit 1 }",
        "if ($runtime.Status -ne 'Valid') { Write-Output \"The managed runtime does not have a valid Windows signature ($($runtime.Status)).\"; exit 1 }",
        "if ($null -eq $application.SignerCertificate -or $null -eq $runtime.SignerCertificate) { Write-Output 'Windows did not return a signing certificate for PwrAgent or the managed runtime.'; exit 1 }",
        // Windows validates each chain. Microsoft can rotate issuing CAs while
        // the verified publisher's subject remains the same across releases.
        "if ($runtime.SignerCertificate.Subject -cne $application.SignerCertificate.Subject) { Write-Output 'The managed runtime publisher does not match this PwrAgent build.'; exit 1 }",
      ].join("; "),
    ],
    env: {
      PWRAGENT_VERIFY_APPLICATION: applicationCommand,
      PWRAGENT_VERIFY_RUNTIME: runtimeCommand,
    },
  };
}

/**
 * Verify that a downloaded managed executable carries the same platform
 * signing identity as the running PwrAgent executable.
 */
export async function verifyMatchingPlatformSignature(
  command: string,
  applicationCommand: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === "darwin") {
    await execFile("codesign", [
      "--verify",
      "--strict",
      "--verbose=2",
      applicationCommand,
    ]);
    const applicationSignature = await execFile("codesign", [
      "--display",
      "--verbose=4",
      applicationCommand,
    ]);
    const signatureDetails =
      `${applicationSignature.stdout ?? ""}\n${applicationSignature.stderr ?? ""}`;
    const teamIdentifier = /^TeamIdentifier=([A-Z0-9]+)$/mu.exec(
      signatureDetails,
    )?.[1];
    if (!teamIdentifier) {
      throw new Error("Signed PwrAgent executable has no Apple team identifier");
    }
    await execFile("codesign", [
      "--verify",
      "--strict",
      "--verbose=2",
      "--test-requirement",
      `=anchor apple generic and certificate leaf[subject.OU] = "${teamIdentifier}"`,
      command,
    ]);
    return;
  }

  if (platform === "win32") {
    const verification = windowsSignatureVerification(
      applicationCommand,
      command,
    );
    try {
      await execFile("powershell.exe", verification.args, {
        env: { ...process.env, ...verification.env },
      });
    } catch (error) {
      const reason =
        typeof error === "object" && error !== null
        && "stdout" in error && typeof error.stdout === "string"
          ? error.stdout.trim()
          : "";
      throw new Error(
        reason || "Windows could not verify the managed runtime signature.",
        { cause: error },
      );
    }
  }
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
