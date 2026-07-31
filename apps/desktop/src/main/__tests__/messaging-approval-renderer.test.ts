import { describe, expect, it } from "vitest";
import { buildApprovalIntent } from "../messaging/core/messaging-approval-renderer";

describe("buildApprovalIntent", () => {
  it("renders URL-mode MCP login requests with MCP-shaped responses", () => {
    const intent = buildApprovalIntent({
      id: "mcp-login-1",
      createdAt: 1000,
      request: {
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "request-mcp-1",
          serverName: "github",
          mode: "url",
          _meta: null,
          message: "Reconnect GitHub to restore access.",
          url: "https://example.test/oauth/start?state=opaque",
          elicitationId: "elicitation-1",
        },
      },
    });

    expect(intent).toMatchObject({
      kind: "approval",
      title: "MCP Login",
      decisions: [
        {
          id: "approval:mcp:accept",
          label: "Allow",
          decision: "accept",
          response: {
            action: "accept",
            content: {},
            _meta: null,
          },
        },
        {
          id: "approval:mcp:decline",
          decision: "decline",
          response: {
            action: "decline",
            content: null,
            _meta: null,
          },
        },
        {
          id: "approval:mcp:cancel",
          decision: "cancel",
          response: {
            action: "cancel",
            content: null,
            _meta: null,
          },
        },
      ],
    });
    expect(intent.body).toContain("Reconnect GitHub to restore access.");
    expect(intent.body).toContain(
      "Open login: https://example.test/oauth/start?state=opaque",
    );
  });

  it("keeps required MCP forms visible without offering an invalid empty approval", () => {
    const intent = buildApprovalIntent({
      id: "mcp-form-1",
      createdAt: 1000,
      request: {
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "request-mcp-form-1",
          serverName: "example",
          mode: "form",
          _meta: null,
          message: "Provide the deployment region.",
          requestedSchema: {
            type: "object",
            properties: {
              region: { type: "string" },
            },
            required: ["region"],
          },
        },
      },
    });

    expect(intent.decisions.map((decision) => decision.decision)).toEqual([
      "decline",
      "cancel",
    ]);
    expect(intent.body).toContain(
      "must be completed in PwrAgent desktop",
    );
  });

  it.each([
    {
      label: "URL mode without an elicitation id",
      params: {
        serverName: "github",
        mode: "url" as const,
        _meta: null,
        message: "Reconnect GitHub to restore access.",
        url: "https://example.test/oauth/start?state=opaque",
      },
    },
    {
      label: "form mode without a requested schema",
      params: {
        serverName: "example",
        mode: "form" as const,
        _meta: null,
        message: "Provide deployment details.",
      },
    },
  ])("does not offer Allow for malformed MCP requests: $label", ({ params }) => {
    const intent = buildApprovalIntent({
      id: "mcp-malformed-1",
      createdAt: 1000,
      request: {
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "request-mcp-malformed-1",
          ...params,
        },
      },
    });

    expect(intent.decisions.map((decision) => decision.decision)).toEqual([
      "decline",
      "cancel",
    ]);
    expect(intent.body).toContain(
      "must be completed in PwrAgent desktop",
    );
  });

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
        response: { decision: "accept" },
      }),
      expect.objectContaining({
        label: "Cancel",
        decision: "cancel",
        fallbackText: "2",
        response: { decision: "cancel" },
      }),
    ]);
  });

  it("advertises only replies backed by rendered command approval actions", () => {
    const intent = buildApprovalIntent({
      id: "approval-fallback",
      createdAt: 1000,
      request: {
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          requestId: "request-fallback",
          prompt: "Run tests?",
        },
      },
    });

    expect(intent.decisions).toEqual([
      expect.objectContaining({ decision: "accept" }),
      expect.objectContaining({ decision: "accept_for_session" }),
      expect.objectContaining({ decision: "decline" }),
      expect.objectContaining({ decision: "cancel" }),
    ]);
    expect(intent.body).toContain('"yes for this session"');
    expect(intent.body).toContain('"no"');
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
        id: "approval:accept_with_execpolicy_amendment:1",
        decision: "accept_with_execpolicy_amendment",
        label: "Always Allow Prefix",
        description: "pnpm test",
        style: "secondary",
        response: { decision: structuredDecision },
      }),
      expect.objectContaining({
        decision: "cancel",
      }),
    ]);
    expect(intent.body).toContain(
      ["Persistent prefix:", "```shell", "pnpm test", "```"].join("\n"),
    );
  });

  it("numbers multiple persistent prefixes while preserving their exact scope", () => {
    const firstDecision = {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["pnpm", "test"],
      },
    };
    const secondDecision = {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["pnpm", "lint"],
      },
    };
    const intent = buildApprovalIntent({
      id: "approval-prefixes",
      createdAt: 1000,
      request: {
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          requestId: "request-prefixes",
          prompt: "Run checks?",
          availableDecisions: ["accept", firstDecision, secondDecision, "cancel"],
        },
      },
    });

    expect(intent.decisions).toEqual([
      expect.objectContaining({ decision: "accept" }),
      expect.objectContaining({
        label: "Always Allow Prefix 1",
        description: "pnpm test",
        response: { decision: firstDecision },
      }),
      expect.objectContaining({
        label: "Always Allow Prefix 2",
        description: "pnpm lint",
        response: { decision: secondDecision },
      }),
      expect.objectContaining({ decision: "cancel" }),
    ]);
    expect(intent.body).toContain("Persistent prefixes:");
    expect(intent.body).toContain(
      ["Always Allow Prefix 1:", "```shell", "pnpm test", "```"].join("\n"),
    );
    expect(intent.body).toContain(
      ["Always Allow Prefix 2:", "```shell", "pnpm lint", "```"].join("\n"),
    );
  });

  it("preserves a free-form ACP persistent label when its scope cannot be extracted", () => {
    const intent = buildApprovalIntent({
      id: "approval-acp-prefix",
      createdAt: 1000,
      request: {
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          requestId: "request-acp-prefix",
          prompt: "Run npm metadata lookup?",
          acpPermissionOptions: [
            {
              optionId: "allow-always-command",
              name: "Always allow npm view",
              kind: "allow_always",
            },
          ],
        },
      },
    });

    expect(intent.decisions).toEqual([
      expect.objectContaining({
        decision: "accept_with_execpolicy_amendment",
        label: "Always allow npm view",
        response: { decision: "allow-always-command" },
      }),
      expect.objectContaining({ decision: "cancel" }),
    ]);
    expect(intent.decisions[0]).not.toHaveProperty("description");
    expect(intent.body).not.toContain("Persistent prefix:");
  });

  it("renders file-change approval context without a shell command", () => {
    const intent = buildApprovalIntent({
      id: "approval-3",
      createdAt: 1000,
      directoryPaths: ["/repo/pwragent"],
      request: {
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          requestId: "request-3",
          prompt: "Write file?",
          action: "write",
          path: "/repo/pwragent/src/app.ts",
          grantRoot: "/repo/pwragent",
        },
      },
    });

    expect(intent.title).toBe("File Change Approval");
    expect(intent.context).toMatchObject({
      action: "write",
      path: "/repo/pwragent/src/app.ts",
      displayPath: "src/app.ts",
      grantRoot: "/repo/pwragent",
      displayGrantRoot: ".",
    });
    expect(intent.body).toContain(
      "Context:\nAction: write\nFile: src/app.ts\nWrite root: .",
    );
    expect(intent.body).not.toContain("```shell");
  });

  it("renders file-change context embedded on the approval request", () => {
    const intent = buildApprovalIntent({
      id: "approval-4",
      createdAt: 1000,
      directoryPaths: ["/repo/pwragent"],
      request: {
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          requestId: "request-4",
          prompt: "Write file?",
          _pwragentApprovalContext: {
            files: [
              {
                action: "add",
                path: "/repo/pwragent/pwragent-pr-refresh-body.md",
                diff: "@@ -0,0 +1 @@\n+Draft PR body",
                additions: 1,
                removals: 0,
              },
            ],
          },
        },
      },
    });

    expect(intent.context).toMatchObject({
      action: "add",
      path: "/repo/pwragent/pwragent-pr-refresh-body.md",
      displayPath: "pwragent-pr-refresh-body.md",
      diff: "@@ -0,0 +1 @@\n+Draft PR body",
    });
    expect(intent.body).toContain("Context:\nAction: add\nFile: pwragent-pr-refresh-body.md");
    expect(intent.body).toContain("Diff: 1 file, +1 -0");
    expect(intent.body).not.toContain("```diff");
    expect(intent.body).not.toContain("Draft PR body");
  });
});
