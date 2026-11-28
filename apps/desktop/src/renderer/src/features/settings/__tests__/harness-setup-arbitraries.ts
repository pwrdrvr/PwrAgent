import fc from "fast-check";
import type {
  AcpAgentSettingsEntry,
  AcpRejectedAgentInstance,
  BackendSummary,
} from "@pwragent/shared/contracts/backend";
import type {
  DesktopCodexAuthProfileCandidate,
  DesktopCodexDiscoveryCandidate,
  DesktopSettingsSnapshot,
} from "@pwragent/shared/contracts/settings";
import type { ManagedRuntimeProgress } from "../../../../../shared/managed-runtime-progress";
import type { CodexLoginObservation } from "../harness-setup-status";

/** Synthetic provider reports for the harness Setup property tests. */

export const AUTH_ERROR = "json-rpc error (-32000): Authentication required: no auth method id provided";

export type CodexSnapshot = DesktopSettingsSnapshot["models"]["codex"];

const maybe = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });

const rejectedArb: fc.Arbitrary<AcpRejectedAgentInstance> = fc.record({
  command: fc.constantFrom("/usr/local/bin/agent", "C:\\tools\\agent.exe"),
  version: maybe(fc.constantFrom("0.21.0", "1.0.0")),
  source: fc.constantFrom("path" as const, "override" as const, "fallback" as const),
  reason: fc.constantFrom(
    "version-probe-failed" as const,
    "acp-probe-failed" as const,
    "acp-help-mismatch" as const,
    "probe-timed-out" as const,
  ),
}) as fc.Arbitrary<AcpRejectedAgentInstance>;

export const acpEntryArb: fc.Arbitrary<AcpAgentSettingsEntry> = fc.record({
  registryId: fc.constantFrom("grok", "gemini", "qwen", "kimi", "antigravity"),
  installed: fc.boolean(),
  installStatus: fc.constantFrom(
    "installed" as const,
    "not-installed" as const,
    "unavailable" as const,
    "install-failed" as const,
  ),
  authStatus: fc.constantFrom(
    "not-required" as const,
    "required" as const,
    "authenticated" as const,
    "failed" as const,
  ),
  activeCommand: maybe(fc.constantFrom("/usr/bin/agent", "/Users/me/bin/agent")),
  version: maybe(fc.constantFrom("1.0.0", "0.42.0")),
  lastDiscoveryError: maybe(fc.constantFrom(AUTH_ERROR, "Request timed out", "previous probe failed")),
  lastError: maybe(fc.constantFrom(AUTH_ERROR, "could not verify ACP support")),
  unavailableReason: maybe(fc.constantFrom(AUTH_ERROR, "Sign in with Google to use this agent.")),
  lastDiscoveredAt: maybe(fc.integer({ min: 1, max: 2_000_000_000_000 })),
  rejectedInstances: maybe(fc.array(rejectedArb, { maxLength: 2 })),
  incompatibleInstances: maybe(fc.array(rejectedArb, { maxLength: 1 })),
}).map((fields) => ({
  backendId: `acp:${fields.registryId}`,
  name: fields.registryId,
  authors: [],
  distributionKind: "local",
  distributionSource: fields.registryId,
  installable: false,
  verificationStatus: "not-applicable",
  ...fields,
}) as AcpAgentSettingsEntry);

export const claudeArb: fc.Arbitrary<BackendSummary["claude"]> = maybe(fc.record({
  executable: maybe(fc.constantFrom("/usr/local/bin/claude", "/Applications/PwrAgent.app/claude")),
  source: maybe(fc.constantFrom("system" as const, "bundled" as const)),
  version: maybe(fc.constantFrom("2.1.330")),
  authStatus: fc.constantFrom(
    "signed-in" as const,
    "sign-in-required" as const,
    "session-expired" as const,
    "unknown" as const,
  ),
  authMethod: maybe(fc.constantFrom(
    "api-key" as const,
    "claude-account" as const,
    "gateway" as const,
    "external" as const,
  )),
  gatewayUrl: maybe(fc.constantFrom("https://gateway.example.com")),
})) as fc.Arbitrary<BackendSummary["claude"]>;

const candidateArb: fc.Arbitrary<DesktopCodexDiscoveryCandidate> = fc.record({
  command: fc.constantFrom("/opt/homebrew/bin/codex", "/Users/me/bin/codex", "C:/tools/codex.cmd"),
  source: fc.constantFrom("env" as const, "config" as const, "path" as const, "application" as const),
  executable: fc.boolean(),
  selected: fc.boolean(),
  version: maybe(fc.constantFrom("0.130.0")),
  versionFailureReason: maybe(fc.constantFrom("version probe failed")),
  failureReason: maybe(fc.constantFrom("not executable")),
});

const profileArb: fc.Arbitrary<DesktopCodexAuthProfileCandidate> = fc.record({
  name: fc.constantFrom("", "work"),
  displayName: fc.constantFrom("System default", "work"),
  codexHome: fc.constantFrom("/Users/me/.codex", "/Users/me/.codex/profiles/work"),
  accountEmail: maybe(fc.constantFrom("someone@example.com")),
  source: fc.constantFrom("default" as const, "directory" as const),
  exists: fc.boolean(),
  selected: fc.boolean(),
  hasAuthFile: fc.boolean(),
  hasConfigFile: fc.boolean(),
  authenticationRequired: maybe(fc.boolean()),
});

export const codexArb: fc.Arbitrary<CodexSnapshot> = fc.record({
  candidates: fc.array(candidateArb, { maxLength: 3 }),
  pickFirst: fc.boolean(),
  error: maybe(fc.constantFrom("discovery failed")),
  path: fc.constantFrom("", "/Users/me/bin/codex"),
  pathSource: fc.constantFrom("default" as const, "config" as const, "env" as const),
  profiles: fc.array(profileArb, { maxLength: 2 }),
}).map(({ candidates, pickFirst, error, path, pathSource, profiles }) => {
  // Main marks exactly the candidate it picked as selected.
  const selectedCommand = pickFirst ? candidates[0]?.command : undefined;
  return {
    path: { value: path, source: pathSource },
    discovery: {
      ...(selectedCommand ? { selectedCommand } : {}),
      candidates: candidates.map((candidate) => ({
        ...candidate,
        selected: candidate.command === selectedCommand,
      })),
      ...(error ? { error } : {}),
    },
    profiles: { profileRoot: "/Users/me/.codex/profiles", effectiveCodexHome: "/Users/me/.codex", profiles },
  } as unknown as CodexSnapshot;
});

export const codexBackendArb: fc.Arbitrary<BackendSummary | undefined> = maybe(fc.record({
  available: fc.boolean(),
  discoveryPending: maybe(fc.boolean()),
  unavailableReason: maybe(fc.constantFrom("Codex app-server exited.")),
}).map((fields) => ({ kind: "codex", id: "codex", ...fields }) as unknown as BackendSummary));

export const managedArb: fc.Arbitrary<ManagedRuntimeProgress | undefined> = maybe(fc.record({
  phase: fc.constantFrom(
    "idle" as const,
    "checking" as const,
    "downloading" as const,
    "verifying" as const,
    "ready" as const,
    "failed" as const,
  ),
  error: maybe(fc.constantFrom("download failed")),
}).map((fields) => ({ runtime: "codex", ...fields }) as unknown as ManagedRuntimeProgress));

export const loginArb: fc.Arbitrary<CodexLoginObservation | undefined> = maybe(fc.oneof(
  fc.constant<CodexLoginObservation>({ kind: "idle" }),
  fc.constant<CodexLoginObservation>({ kind: "signed-out" }),
  fc.constant<CodexLoginObservation>({ kind: "starting" }),
  fc.constant<CodexLoginObservation>({ kind: "waiting" }),
  fc.boolean().map((signIn): CodexLoginObservation => ({ kind: "checking", signIn })),
  fc.constant<CodexLoginObservation>({ kind: "ok", email: "someone@example.com" }),
  fc.constant<CodexLoginObservation>({ kind: "error", detail: "codex login exited 1" }),
));

