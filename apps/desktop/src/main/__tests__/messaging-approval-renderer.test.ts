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
        }),
      ]),
    });
    expect(intent.body).toContain("Run the focused tests?");
    expect(intent.body).toContain("```shell\npnpm test -- messaging-controller\n```");
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
