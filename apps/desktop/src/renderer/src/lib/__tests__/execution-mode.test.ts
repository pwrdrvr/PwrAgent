import { describe, expect, it } from "vitest";
import type { BackendSummary, NavigationThreadSummary } from "@pwragent/shared";
import {
  acpRuntimeModeRequiresFullAccess,
  formatAccessModeLabel,
  getAcpRuntimeModeControl,
} from "../execution-mode";

const acpBackend = {
  kind: "acp:gemini",
  label: "Gemini CLI",
  available: true,
  methods: [],
  capabilities: {
    listThreads: true,
    createThread: true,
    resumeThread: true,
    renameThread: true,
    readThread: true,
    startTurn: true,
    interruptTurn: true,
    steerTurn: false,
    transcriptPagination: false,
    toolUse: true,
    approvalRequests: true,
    multiDirectoryThreads: false,
  },
  executionModes: [],
  acp: {
    registryId: "gemini",
    distributionKinds: ["local"],
    installStatus: "installed",
    authStatus: "not-required",
    verificationStatus: "not-applicable",
    runtime: {
      schemaVersion: 1,
      status: "discovered",
      configOptions: [
        {
          id: "approval-mode",
          label: "Approval mode",
          type: "select",
          category: "mode",
          currentValue: "default",
          values: [
            { value: "default", label: "Default" },
            { value: "auto_edit", label: "Auto Edit" },
            { value: "yolo", label: "YOLO" },
          ],
        },
      ],
    },
  },
} satisfies BackendSummary;

const thread = {
  id: "thread-1",
  title: "Gemini",
  titleSource: "explicit",
  createdAt: 1000,
  updatedAt: 1000,
  linkedDirectories: [],
  source: "acp:gemini",
  executionMode: "default",
  inbox: { inInbox: false },
  acpRuntime: {
    configValues: { "approval-mode": "default" },
    currentModeId: "yolo",
  },
} satisfies NavigationThreadSummary;

describe("ACP execution mode labels", () => {
  it("identifies ACP runtime modes that need the privileged execution envelope", () => {
    expect(acpRuntimeModeRequiresFullAccess("yolo")).toBe(true);
    expect(acpRuntimeModeRequiresFullAccess("YOLO")).toBe(true);
    expect(acpRuntimeModeRequiresFullAccess("autoEdit")).toBe(true);
    expect(acpRuntimeModeRequiresFullAccess("auto_edit")).toBe(true);
    expect(acpRuntimeModeRequiresFullAccess("auto edit")).toBe(true);
    expect(acpRuntimeModeRequiresFullAccess("default")).toBe(false);
    expect(acpRuntimeModeRequiresFullAccess("plan")).toBe(false);
  });

  it("uses ACP current mode when a mode config option is stale", () => {
    expect(getAcpRuntimeModeControl(acpBackend, thread)).toMatchObject({
      optionId: "approval-mode",
      source: "configOption",
      value: "yolo",
    });
    expect(formatAccessModeLabel(thread, acpBackend)).toBe("Default Access");
  });

  it("does not expose single-option ACP runtime modes as composer controls", () => {
    const singleModeBackend = {
      ...acpBackend,
      acp: {
        ...acpBackend.acp,
        runtime: {
          schemaVersion: 1,
          status: "discovered",
          modes: {
            availableModes: [{ id: "default", label: "Default" }],
            currentModeId: "default",
          },
        },
      },
    } satisfies BackendSummary;

    expect(getAcpRuntimeModeControl(singleModeBackend, thread)).toBeUndefined();
  });
});
