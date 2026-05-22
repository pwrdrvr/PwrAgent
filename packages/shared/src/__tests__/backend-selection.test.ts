import { describe, expect, it } from "vitest";
import type { BackendSummary } from "../contracts/backend";
import type { AppServerBackendKind } from "../contracts/normalized-app-server";
import {
  resolveNewThreadBackend,
  selectableNewThreadBackends,
} from "../backend-selection";

describe("backend selection helpers", () => {
  it("returns available create-capable backends with available execution modes or ACP runtime modes", () => {
    const backends = [
      backendSummary("codex", { available: true, createThread: true }),
      backendSummary("acp:gemini", {
        available: true,
        createThread: true,
        executionModes: [],
        label: "Gemini CLI",
        source: "acp",
      }),
      backendSummary("grok", { available: true, createThread: false }),
      backendSummary("grok", {
        available: true,
        createThread: true,
        executionModeAvailable: false,
        label: "Grok unavailable mode",
      }),
    ];

    expect(selectableNewThreadBackends(backends)).toEqual([
      expect.objectContaining({ kind: "codex" }),
      expect.objectContaining({ kind: "acp:gemini" }),
    ]);
  });

  it("resolves the preferred backend when it is selectable", () => {
    const backends = [
      backendSummary("codex", { available: true, createThread: true }),
      backendSummary("acp:gemini", {
        available: true,
        createThread: true,
        label: "Gemini CLI",
      }),
    ];

    expect(resolveNewThreadBackend(backends, "acp:gemini")).toMatchObject({
      kind: "acp:gemini",
    });
  });

  it("falls back to Codex before the first selectable backend", () => {
    const backends = [
      backendSummary("grok", { available: true, createThread: true }),
      backendSummary("codex", { available: true, createThread: true }),
    ];

    expect(resolveNewThreadBackend(backends, undefined)).toMatchObject({
      kind: "codex",
    });
  });

  it("returns undefined when no backend can create threads", () => {
    expect(
      resolveNewThreadBackend([
        backendSummary("codex", { available: false, createThread: true }),
        backendSummary("grok", { available: true, createThread: false }),
      ]),
    ).toBeUndefined();
  });
});

function backendSummary(
  kind: AppServerBackendKind,
  options: {
    available: boolean;
    createThread: boolean;
    executionModes?: BackendSummary["executionModes"];
    executionModeAvailable?: boolean;
    label?: string;
    source?: BackendSummary["source"];
  },
): BackendSummary {
  return {
    kind,
    source: options.source,
    label: options.label ?? (kind === "codex" ? "Codex" : "Grok"),
    available: options.available,
    methods: [],
    capabilities: {
      listThreads: true,
      createThread: options.createThread,
      resumeThread: true,
      renameThread: true,
      readThread: true,
      startTurn: true,
      interruptTurn: true,
      steerTurn: false,
      transcriptPagination: false,
      toolUse: true,
      approvalRequests: true,
      multiDirectoryThreads: true,
    },
    executionModes: options.executionModes ?? [
      {
        mode: "default",
        label: "Default",
        available: options.executionModeAvailable ?? true,
      },
    ],
  };
}
