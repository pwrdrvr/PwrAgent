import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AcpAgentSettingsEntry, BackendSummary } from "@pwragent/shared/contracts/backend";
import type { ManagedRuntimeProgress } from "../../../../../shared/managed-runtime-progress";
import {
  acpSetupStatus,
  claudeSetupStatus,
  codexSetupStatus,
  currentSetupStep,
  type CodexLoginObservation,
  type HarnessSetupStatus,
} from "../harness-setup-status";
import {
  acpEntryArb,
  AUTH_ERROR,
  claudeArb,
  codexArb,
  codexBackendArb,
  type CodexSnapshot,
  loginArb,
  managedArb,
} from "./harness-setup-arbitraries";

/*
 * One reading of a harness's setup state feeds the Settings nav dot, the AI
 * Providers list chip, the provider screen's Setup checklist and guided
 * setup's review. These properties state what that reading may claim, each
 * against an oracle written here from the raw report, not from the module.
 */

/* ---------- oracles: is this provider usable for a new thread? ---------- */

function acpOracleReady(entry: AcpAgentSettingsEntry | undefined, enabled: boolean): boolean {
  if (!entry || !enabled || !entry.installed) return false;
  const diagnostic = entry.lastDiscoveryError ?? entry.lastError ?? entry.unavailableReason;
  const grokAuthRefused = entry.registryId === "grok"
    && (entry.authStatus === "required" || /Authentication required/i.test(diagnostic ?? ""));
  return !grokAuthRefused
    && entry.unavailableReason === undefined
    && entry.lastDiscoveryError === undefined
    // Never answered a capability probe: nothing has shown it starts.
    && entry.lastDiscoveredAt !== undefined;
}

function claudeOracleReady(claude: BackendSummary["claude"], signingIn: boolean): boolean {
  void signingIn;
  return Boolean(claude?.executable) && claude?.authStatus === "signed-in";
}

function codexOracleReady(
  codex: CodexSnapshot,
  backend: BackendSummary | undefined,
  managed: ManagedRuntimeProgress | undefined,
  login: CodexLoginObservation | undefined,
): boolean {
  const picked = codex.discovery.candidates.find((candidate) =>
    candidate.command === codex.discovery.selectedCommand);
  const runtime = picked !== undefined
    && picked.executable
    && Boolean(picked.version)
    && !picked.failureReason
    && !picked.versionFailureReason;
  if (!runtime) return false;
  void managed;
  const profile = codex.profiles.profiles.find((candidate) => candidate.selected)
    ?? codex.profiles.profiles.find((candidate) => candidate.name === "");
  let signedIn: boolean;
  if (login && login.kind !== "idle") {
    signedIn = login.kind === "ok";
  } else {
    signedIn = profile !== undefined
      && profile.exists
      && profile.hasAuthFile
      && profile.authenticationRequired !== true;
  }
  if (!signedIn) return false;
  return !(backend && !backend.available && !backend.discoveryPending && backend.unavailableReason);
}

/* ---------- shared shape rules ---------- */

function expectCoherent(status: HarnessSetupStatus): void {
  // Ready is all steps done, and only Ready is green, in every surface.
  expect(status.ready).toBe(status.steps.every((step) => step.state === "done"));
  expect(status.dot === "ok").toBe(status.ready);
  expect(status.tone === "ok").toBe(status.ready);
  if (status.ready) expect(status.reviewLabel).not.toMatch(/required|failed|expired/i);
  // One step to act on, its action is the status's, and nothing after it
  // has started: Setup goes in order.
  const current = currentSetupStep(status.steps);
  expect(status.action).toBe(current?.action);
  if (current) {
    const after = status.steps.slice(status.steps.indexOf(current) + 1);
    expect(after.every((step) => step.state === "waiting")).toBe(true);
  }
  // A step that needs a person is never hidden behind a green chip.
  if (status.steps.some((step) => step.state === "attention")) {
    expect(status.tone).not.toBe("ok");
    expect(status.dot).toBe("warn");
  }
}

describe("harness setup status", () => {
  it("ACP: green only when the agent is on, installed, unrefused and has answered a check", () => {
    fc.assert(fc.property(acpEntryArb, fc.boolean(), (entry, enabled) => {
      const status = acpSetupStatus(entry, { enabled });
      expectCoherent(status);
      expect(status.ready).toBe(acpOracleReady(entry, enabled));
      if (!enabled) expect(status.steps[0]).toMatchObject({ id: "enable" });
    }));
  });

  it("Claude: green only when Claude Code is found and signed in", () => {
    fc.assert(fc.property(claudeArb, fc.boolean(), (claude, signingIn) => {
      const status = claudeSetupStatus(claude, { signingIn });
      expectCoherent(status);
      expect(status.ready).toBe(claudeOracleReady(claude, signingIn));
    }));
  });

  it("Codex: green only with a working runtime, a signed-in profile and a healthy backend", () => {
    fc.assert(fc.property(
      codexArb,
      codexBackendArb,
      managedArb,
      loginArb,
      (codex, backend, managedProgress, login) => {
        const status = codexSetupStatus({ codex, backend, managedProgress, login });
        expectCoherent(status);
        expect(status.ready).toBe(codexOracleReady(codex, backend, managedProgress, login));
      },
    ));
  });

  // Counterexamples the pre-change Settings got wrong, kept as examples.
  describe("examples", () => {
    const grok = (overrides: Partial<AcpAgentSettingsEntry>): AcpAgentSettingsEntry => ({
      backendId: "acp:grok",
      registryId: "grok",
      name: "Grok",
      authors: [],
      distributionKind: "local",
      distributionSource: "grok --acp",
      installable: false,
      installed: true,
      installStatus: "installed",
      authStatus: "not-required",
      verificationStatus: "not-applicable",
      activeCommand: "/usr/bin/grok",
      lastDiscoveredAt: 1_000,
      ...overrides,
    });

    it("a Grok whose sign-in was refused is not green anywhere", () => {
      // Before: the nav dot was `enabled && installed`, so this read ok.
      const status = acpSetupStatus(grok({ lastDiscoveryError: AUTH_ERROR }), { enabled: true });
      expect(status).toMatchObject({ dot: "warn", tone: "warn", ready: false, navChip: "sign in" });
      expect(status.reviewLabel).toBe("Sign-in required");
      expect(status.action).toBe("terminal-sign-in");
    });

    it("an installed agent that never answered a check is not ready", () => {
      // Before: guided review counted it Ready as soon as it was installed.
      const status = acpSetupStatus(grok({ lastDiscoveredAt: undefined }), { enabled: true });
      expect(status).toMatchObject({ label: "Not checked", dot: "off", ready: false });
    });

    it("a found Codex with a signed-out profile is not green", () => {
      // Before: the nav dot was green whenever discovery picked a command,
      // and the provider list said Discovered.
      const codex = {
        path: { value: "", source: "default" },
        discovery: {
          selectedCommand: "/opt/homebrew/bin/codex",
          candidates: [{
            command: "/opt/homebrew/bin/codex", source: "path", executable: true, selected: true, version: "0.130.0",
          }],
        },
        profiles: {
          profileRoot: "/Users/me/.codex/profiles",
          effectiveCodexHome: "/Users/me/.codex",
          profiles: [{
            name: "", displayName: "System default", codexHome: "/Users/me/.codex", source: "default",
            exists: true, selected: true, hasAuthFile: false, hasConfigFile: false,
          }],
        },
      } as unknown as CodexSnapshot;
      const status = codexSetupStatus({ codex });
      expect(status).toMatchObject({ label: "Sign-in required", dot: "warn", ready: false, action: "sign-in" });
    });

    it("a fresh machine's missing ~/.codex reads as not signed in, not a missing profile", () => {
      // Seen on the macOS E2E VM: Codex had never run, so the System default
      // folder did not exist yet, and Setup said the folder "is gone".
      const codex = {
        path: { value: "", source: "default" },
        discovery: {
          selectedCommand: "/opt/homebrew/bin/codex",
          candidates: [{
            command: "/opt/homebrew/bin/codex", source: "path", executable: true, selected: true, version: "0.159.0",
          }],
        },
        profiles: {
          profileRoot: "/Users/me/.codex/profiles",
          effectiveCodexHome: "/Users/me/.codex",
          profiles: [{
            name: "", displayName: "System default", codexHome: "/Users/me/.codex", source: "default",
            exists: false, selected: true, hasAuthFile: false, hasConfigFile: false,
          }],
        },
      } as unknown as CodexSnapshot;
      const status = codexSetupStatus({ codex });
      expect(status).toMatchObject({ label: "Sign-in required", action: "sign-in" });
      expect(status.steps[1]).toMatchObject({ label: "Not signed in" });

      // A named profile whose folder is gone still needs repair.
      const named = structuredClone(codex);
      named.profiles.profiles[0] = {
        ...named.profiles.profiles[0]!, name: "work", displayName: "work", codexHome: "/Users/me/.codex/profiles/work",
      };
      expect(codexSetupStatus({ codex: named })).toMatchObject({ label: "Action required", action: "manage-account" });
    });

    it("a failed download of PwrAgent's Codex build is a warning, not a grey Not found", () => {
      const codex = {
        path: { value: "", source: "default" },
        discovery: { candidates: [] },
        profiles: { profileRoot: "/Users/me/.codex/profiles", effectiveCodexHome: "/Users/me/.codex", profiles: [] },
      } as unknown as CodexSnapshot;
      const status = codexSetupStatus({
        codex,
        managedProgress: { runtime: "codex", phase: "failed", error: "download failed" } as ManagedRuntimeProgress,
      });
      expect(status).toMatchObject({ label: "Install failed", dot: "warn", tone: "warn", action: "install" });
      expect(status.steps[0]).toMatchObject({ state: "attention", detail: "download failed" });
    });

    it("a failed check of an installed agent points at one Check again, on the ready step", () => {
      // The account step waits on that check; it is not a second place to act.
      const status = acpSetupStatus(grok({ lastDiscoveryError: "Request timed out" }), { enabled: true });
      expect(currentSetupStep(status.steps)).toMatchObject({ id: "ready", action: "check" });
      expect(status.steps.find((step) => step.id === "account")).toMatchObject({ state: "waiting" });
    });
  });
});
