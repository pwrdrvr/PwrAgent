import { describe, expect, it } from "vitest";
import { buildApprovalIntent } from "../messaging/core/messaging-approval-renderer";

describe("buildApprovalIntent", () => {
  it("renders command approvals with prompt, command code block, and conservative choices", () => {
    const intent = buildApprovalIntent({
      id: "approval-1",
      createdAt: 1000,
      request: {
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "request-1",
          prompt: "Run the focused tests?",
          command: "/bin/zsh -lc 'pnpm test -- messaging-controller'",
          availableDecisions: ["accept", "acceptForSession", "cancel"],
        },
      },
    });

    expect(intent).toMatchObject({
      kind: "approval",
      title: "Command Approval",
      decisions: expect.arrayContaining([
        expect.objectContaining({
          decision: "accept",
          fallbackText: "1",
        }),
        expect.objectContaining({
          decision: "accept_for_session",
          fallbackText: "2",
          response: { decision: "acceptForSession" },
        }),
      ]),
    });
    expect(intent.body).toContain("Run the focused tests?");
    expect(intent.body).toContain("```shell\npnpm test -- messaging-controller\n```");
  });

  it("renders normalized Kimi shell approvals with the actual command", () => {
    const intent = buildApprovalIntent({
      id: "approval-kimi",
      createdAt: 1000,
      request: {
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "request-1",
          prompt: "Kimi Code CLI wants to run Bash",
          command: "node --version && pnpm --version",
          displayCommand: "node --version && pnpm --version",
        },
      },
    });

    expect(intent.body).toContain("Kimi Code CLI wants to run Bash");
    expect(intent.body).toContain("```shell\nnode --version && pnpm --version\n```");
    expect(intent.body).not.toContain("```shell\nBash\n```");
  });

  it("derives Kimi approval commands from prompt text when command is a shell title", () => {
    const intent = buildApprovalIntent({
      id: "approval-kimi-running",
      createdAt: 1000,
      request: {
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "request-1",
          prompt: "Requesting approval to Running: npm view pnpm",
          command: "Bash",
        },
      },
    });

    expect(intent.body).toContain("Requesting approval to Running: npm view pnpm");
    expect(intent.body).toContain("```shell\nnpm view pnpm\n```");
    expect(intent.body).not.toContain("```shell\nBash\n```");
  });

  it("preserves backend-provided decision labels when they map to known decisions", () => {
    const intent = buildApprovalIntent({
      id: "approval-2",
      createdAt: 1000,
      request: {
        method: "turn/requestApproval",
        params: {
          threadId: "thread-1",
          requestId: "request-2",
          prompt: "Approve?",
          options: ["Approve Once", "Cancel"],
        },
      },
    });

    expect(intent.decisions).toEqual([
      expect.objectContaining({
        label: "Approve Once",
        decision: "accept",
        fallbackText: "1",
      }),
      expect.objectContaining({
        label: "Cancel",
        decision: "cancel",
        fallbackText: "2",
      }),
    ]);
  });

  it("renders structured backend decisions as generic approval actions", () => {
    const structuredDecision = {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["pnpm", "test"],
      },
    };
    const intent = buildApprovalIntent({
      id: "approval-prefix",
      createdAt: 1000,
      request: {
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          requestId: "request-prefix",
          prompt: "Run tests?",
          availableDecisions: ["accept", structuredDecision, "cancel"],
        },
      },
    });

    expect(intent.decisions).toEqual([
      expect.objectContaining({
        decision: "accept",
        label: "Approve Once",
      }),
      expect.objectContaining({
        decision: "accept_with_execpolicy_amendment",
        label: "Approve Prefix: pnpm test",
        response: { decision: structuredDecision },
      }),
      expect.objectContaining({
        decision: "cancel",
      }),
    ]);
  });

  it("renders file-change approval context without a shell command", () => {
    const intent = buildApprovalIntent({
      id: "approval-3",
      createdAt: 1000,
      request: {
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          requestId: "request-3",
          prompt: "Write file?",
          action: "write",
          path: "src/app.ts",
        },
      },
    });

    expect(intent.title).toBe("File Change Approval");
    expect(intent.body).toContain("Context:\nwrite src/app.ts");
    expect(intent.body).not.toContain("```shell");
  });
});
