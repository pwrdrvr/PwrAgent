import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  BackendAcpRuntimeCapabilities,
  BackendAcpRuntimeConfigOption,
  BackendAcpSessionRuntimeState,
  BackendSummary,
} from "@pwragent/shared/contracts/backend";
import type { AppServerBackendKind, ThreadExecutionMode } from "@pwragent/shared/contracts/normalized-app-server";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import { buildMessagingAcpRuntimeModeSummary } from "../messaging/core/messaging-acp-runtime";
import { buildBindingStatusIntent } from "../messaging/core/messaging-status-card";

// Messaging shows the same catalog the desktop and the owner read. The model
// and effort defaults are shared functions (`@pwragent/shared/model-defaults`,
// stated in its property test). The mode summary keeps a messaging shape, so
// this property states the composer's rule literally and checks messaging
// follows it.

const MODE_IDS = ["default", "accept-edits", "auto", "auto-edit", "plan", "yolo"];
const modeIdsArb = fc.uniqueArray(fc.constantFrom(...MODE_IDS), { maxLength: 5 });

const configOptionArb: fc.Arbitrary<BackendAcpRuntimeConfigOption> = fc.record({
  id: fc.constantFrom("permission_mode", "mode", "approval", "model"),
  category: fc.constantFrom("mode", "model", undefined),
  values: modeIdsArb,
  currentValue: fc.option(fc.constantFrom(...MODE_IDS), { nil: undefined }),
}).map(({ id, category, values, currentValue }) => ({
  id,
  label: id,
  type: "select",
  ...(category ? { category } : {}),
  ...(currentValue ? { currentValue } : {}),
  values: values.map((value) => ({ value, label: value })),
}) as BackendAcpRuntimeConfigOption);

const runtimeArb: fc.Arbitrary<BackendAcpRuntimeCapabilities> = fc.record({
  configOptions: fc.option(fc.uniqueArray(configOptionArb, { selector: (option) => option.id, maxLength: 3 }), { nil: undefined }),
  sessionModes: fc.option(modeIdsArb, { nil: undefined }),
  sessionCurrent: fc.option(fc.constantFrom(...MODE_IDS), { nil: undefined }),
}).map(({ configOptions, sessionModes, sessionCurrent }) => ({
  schemaVersion: 1,
  status: "ready",
  ...(configOptions ? { configOptions } : {}),
  ...(sessionModes ? {
    modes: {
      ...(sessionCurrent ? { currentModeId: sessionCurrent } : {}),
      availableModes: sessionModes.map((id) => ({ id, label: id })),
    },
  } : {}),
}) as unknown as BackendAcpRuntimeCapabilities);

/**
 * A session's runtime state. Grok's planning mode lives in currentModeId and
 * can share an id with a permission_mode value; that id says nothing about
 * the permission.
 */
const sessionRuntimeArb: fc.Arbitrary<BackendAcpSessionRuntimeState | undefined> = fc.option(fc.record({
  currentModeId: fc.option(fc.constantFrom(...MODE_IDS), { nil: undefined }),
  configValues: fc.option(fc.dictionary(fc.constantFrom("permission_mode", "mode", "approval"), fc.constantFrom(...MODE_IDS)), { nil: undefined }),
}).map(({ currentModeId, configValues }) => ({
  ...(currentModeId ? { currentModeId } : {}),
  ...(configValues ? { configValues } : {}),
  updatedAt: 1,
}) as BackendAcpSessionRuntimeState), { nil: undefined });

/**
 * The composer's rule, literally: Grok's permission_mode, else another mode
 * config option with values, else the session modes. A legacy mode config
 * mirrors currentModeId; permission_mode reads only its own value. With no
 * value at all, the agent's Default, else its first mode.
 */
function expectedModes(
  runtime: BackendAcpRuntimeCapabilities,
  state: BackendAcpSessionRuntimeState | undefined,
): { ids: string[]; value?: string } {
  const permission = runtime.configOptions?.find((option) => option.id === "permission_mode" && option.category === "mode");
  const config = permission ?? runtime.configOptions?.find((option) => option.category === "mode" && option.values.length > 0);
  const ids = config
    ? config.values.map((value) => value.value)
    : runtime.modes?.availableModes.map((mode) => mode.id) ?? [];
  if (ids.length === 0) return { ids };
  const fallback = ids.includes("default") ? "default" : ids[0];
  if (!config) {
    return { ids, value: state?.currentModeId ?? runtime.modes?.currentModeId ?? fallback };
  }
  const mirrored = config.id !== "permission_mode" && state?.currentModeId && ids.includes(state.currentModeId)
    ? state.currentModeId
    : undefined;
  return { ids, value: mirrored ?? state?.configValues?.[config.id] ?? config.currentValue ?? fallback };
}

describe("messaging settings follow the desktop's catalog rules", () => {
  it("lists an ACP agent's modes from the composer's selector, with its current mode", () => {
    fc.assert(fc.property(runtimeArb, sessionRuntimeArb, (runtime, state) => {
      const summary = buildMessagingAcpRuntimeModeSummary({
        backend: { kind: "acp:kimi", label: "Kimi", acp: { runtime } } as unknown as BackendSummary,
        runtime: state,
      });
      const expected = expectedModes(runtime, state);
      expect(summary.choices.map((choice) => choice.value)).toEqual(expected.ids);
      if (expected.ids.length > 0) expect(summary.currentValue).toBe(expected.value);
    }), { numRuns: 500 });
  });

  it("never renders a second Agent mode control beside Permissions on a status card for any provider", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:antigravity", "acp:kimi", "acp:grok", "acp:qwen"),
        fc.constantFrom<ThreadExecutionMode>("default", "full-access"),
        runtimeArb,
        sessionRuntimeArb,
        (backendKind, executionMode, runtime, state) => {
          const isAcp = backendKind.startsWith("acp:");
          const summary = {
            kind: backendKind,
            label: backendKind,
            available: true,
            executionModes: backendKind === "acp:antigravity" || !isAcp
              ? [
                  { mode: "default", label: "Default Access", available: true },
                  { mode: "full-access", label: "Full Access", available: true },
                ]
              : [],
            ...(isAcp ? { acp: { registryId: backendKind.slice(4), runtime } } : {}),
          } as unknown as BackendSummary;
          const binding: MessagingBindingRecord = {
            id: "binding-1",
            backend: backendKind,
            threadId: "thread-1",
            authorizedActorIds: ["user-1"],
            channel: {
              channel: "telegram",
              connectionId: "conn-1",
              conversation: { id: "chat-1", kind: "dm", isDirectMessage: true },
            },
            createdAt: 1,
            updatedAt: 1,
          };
          const status = buildBindingStatusIntent({
            id: "status-1",
            createdAt: 1,
            binding,
            backendSummary: summary,
            allowFullAccessEscalation: true,
            threadState: {
              executionMode,
              acpRuntime: state,
            } as unknown as Parameters<typeof buildBindingStatusIntent>[0]["threadState"],
          });
          expect(status.text).not.toContain("Agent mode:");
          const modeActions = (status.actions ?? []).filter(
            (action) => action.id === "status:permissions" || action.id === "status:runtime-mode",
          );
          expect(modeActions.length).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 300 },
    );
  });
});
