import { describe, expect, it } from "vitest";
import type { BackendSummary } from "../contracts/backend";
import {
  resolveNewThreadBackend,
  selectableNewThreadBackends,
} from "../backend-selection";

describe("backend selection helpers", () => {
  it("returns available create-capable backends with available execution modes", () => {
    const backends = [
      backendSummary("codex", { available: true, createThread: true }),
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
    ]);
  });

  it("resolves the preferred backend when it is selectable", () => {
    const backends = [
      backendSummary("codex", { available: true, createThread: true }),
      backendSummary("grok", { available: true, createThread: true }),
    ];

    expect(resolveNewThreadBackend(backends, "grok")).toMatchObject({
      kind: "grok",
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
  kind: "codex" | "grok",
  options: {
    available: boolean;
    createThread: boolean;
    executionModeAvailable?: boolean;
    label?: string;
  },
): BackendSummary {
  return {
    kind,
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
    executionModes: [
      {
        mode: "default",
        label: "Default",
        available: options.executionModeAvailable ?? true,
      },
    ],
  };
}
