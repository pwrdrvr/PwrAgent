import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerPendingRequestNotification } from "@pwragent/shared/contracts/normalized-app-server";
import type { OperatorServerRequest } from "@pwragent/shared/contracts/operator-requests";
import { threadTodoThreadKey, type ThreadTodo, type ThreadTodoCiApproval } from "@pwragent/shared/contracts/thread-todos";
import { AppNoticeStack } from "../../notifications/AppNoticeStack";
import type { AppNoticeToastNotice } from "../../notifications/AppNoticeToast";
import { APPROVAL_STILL_OPEN_MESSAGE } from "../approval-choices";
import {
  APPROVAL_NOTICE_HIDE_LABEL,
  approvalNoticeId,
  buildApprovalNotices,
  useApprovalNotices,
} from "../approval-notices";
import { buildOperatorWaits, type OperatorWait } from "../operator-waits";

afterEach(cleanup);

function serverRequest(
  method: string,
  params: Record<string, unknown>,
  { createdAt = 1_000, threadId = "thread-a" }: { createdAt?: number; threadId?: string } = {},
): OperatorServerRequest {
  return {
    backend: "codex",
    createdAt,
    notification: {
      method,
      params: { threadId, turnId: "turn-1", requestId: `req-${createdAt}`, ...params },
    } as unknown as AppServerPendingRequestNotification,
  };
}

const commandApproval = serverRequest("item/commandExecution/requestApproval", {
  command: "/bin/zsh -lc 'pnpm test --run checkout'",
});
const mcpApproval = serverRequest("mcpServer/elicitation/request", {
  serverName: "playwright",
  mode: "form",
  _meta: { codex_approval_kind: "mcp_tool_call" },
  message: "Allow the playwright MCP server to run tool \"browser_tabs\"?",
  requestedSchema: { type: "object", properties: {} },
}, { createdAt: 2_000, threadId: "thread-b" });
const fileApproval = serverRequest("item/fileChange/requestApproval", {
  reason: "Move the route table into one module.",
}, { createdAt: 3_000, threadId: "thread-c" });
const questionnaire = serverRequest("item/tool/requestUserInput", {
  questions: [{ id: "q", header: "Pick", question: "Which build?" }],
}, { createdAt: 4_000, threadId: "thread-d" });

function waitsFor(requests: OperatorServerRequest[]): OperatorWait[] {
  return buildOperatorWaits({ serverRequests: requests, questions: [], seenKeys: [] });
}

const TITLES: Record<string, string> = {
  "codex:thread-a": "Checkout flow retries",
  "codex:thread-b": "Onboarding screenshots",
  "codex:thread-c": "Router cleanup",
};
const titleFor = (key: string) => TITLES[key] ?? "Untitled thread";

describe("buildApprovalNotices", () => {
  it("gives each approval off screen a durable warning card", () => {
    const notices = buildApprovalNotices({
      waits: waitsFor([commandApproval, mcpApproval, fileApproval, questionnaire]),
      hiddenKeys: new Set(),
      threadTitleForKey: titleFor,
      onReview: vi.fn(),
      onHide: vi.fn(),
      onHideAll: vi.fn(),
    });

    // Approvals only: the questionnaire needs its card's inputs.
    expect(notices.map((notice) => notice.title)).toEqual([
      "Approval needed",
      "Approval needed",
      "Tool approval needed",
    ]);
    // Kind first, then newest first: the To-dos order.
    const [files, command, mcp] = notices;
    expect(command).toMatchObject({
      id: approvalNoticeId("request:codex:thread-a:req-1000"),
      message: "The agent wants to run a command.",
      facts: [{ label: "Command", value: "pnpm test --run checkout" }],
      tone: "warning",
      autoDismiss: false,
      dismissLabel: APPROVAL_NOTICE_HIDE_LABEL,
      threadLink: { backend: "codex", threadId: "thread-a", title: "Checkout flow retries" },
    });
    expect(files).toMatchObject({ message: "Move the route table into one module." });
    expect(mcp).toMatchObject({
      message: "Allow the playwright MCP server to run tool \"browser_tabs\"?",
      facts: [{ label: "Server", value: "playwright" }],
    });
  });

  it.each([
    { ownerTitle: undefined, displayTitle: "Untitled thread", expectedOrigin: undefined },
    { ownerTitle: "Owner title", displayTitle: "Owner title", expectedOrigin: "owner" },
    { ownerTitle: "Older owner title", displayTitle: "New navigation title", expectedOrigin: undefined },
  ])("marks only the exact owner-supplied title ($displayTitle)", ({ ownerTitle, displayTitle, expectedOrigin }) => {
    const [notice] = buildApprovalNotices({
      waits: waitsFor([{ ...commandApproval, threadTitle: ownerTitle }]),
      hiddenKeys: new Set(), threadTitleForKey: () => displayTitle,
      onReview: vi.fn(), onHide: vi.fn(), onHideAll: vi.fn(),
    });
    expect(notice?.threadLink?.title).toBe(displayTitle);
    expect(notice?.threadLink?.titleOrigin).toBe(expectedOrigin);
  });

  it("leaves out the thread on screen and the cards the operator hid", () => {
    const waits = waitsFor([commandApproval, mcpApproval, fileApproval]);
    const notices = buildApprovalNotices({
      waits,
      selectedThreadKey: "codex:thread-a",
      hiddenKeys: new Set(["request:codex:thread-c:req-3000"]),
      threadTitleForKey: titleFor,
      onReview: vi.fn(),
      onHide: vi.fn(),
      onHideAll: vi.fn(),
    });
    expect(notices.map((notice) => notice.threadLink?.threadId)).toEqual(["thread-b"]);
  });
});

function Harness(props: {
  initialWaits: OperatorWait[];
  ciApprovalTodos?: ThreadTodo[];
  threadAKey?: string;
  otherNotices?: AppNoticeToastNotice[];
  onReview?: (wait: OperatorWait) => void;
  respond?: (wait: OperatorWait, response: unknown) => Promise<void>;
  reviewCiDeployment?: (todo: ThreadTodo, approval: ThreadTodoCiApproval) => Promise<ThreadTodo | undefined>;
  runningTodoIds?: ReadonlySet<string>;
}) {
  const [waits, setWaits] = useState(props.initialWaits);
  const [selected, setSelected] = useState<string>();
  const approvalNotices = useApprovalNotices({
    waits,
    ciApprovalTodos: props.ciApprovalTodos,
    selectedThreadKey: selected,
    threadTitleForKey: titleFor,
    onReview: props.onReview ?? (() => {}),
    ...(props.respond ? { respond: props.respond } : {}),
    ...(props.reviewCiDeployment ? { reviewCiDeployment: props.reviewCiDeployment } : {}),
    ...(props.runningTodoIds ? { runningTodoIds: props.runningTodoIds } : {}),
  });
  return (
    <>
      <AppNoticeStack
        durableNotices={[...approvalNotices, ...(props.otherNotices ?? [])]}
        onDismissDurable={() => {}}
        onOpenThread={() => {}}
      />
      <button type="button" onClick={() => setWaits((current) => current.slice(1))}>
        Answer first
      </button>
      <button type="button" onClick={() => setSelected(props.threadAKey ?? "codex:thread-a")}>
        Open thread A
      </button>
      <button type="button" onClick={() => setSelected(undefined)}>
        Leave thread A
      </button>
    </>
  );
}

describe("approval notice cards", () => {
  it.each(["local", "remote"])("shows a signing gate on the selected %s thread and opens its exact GitHub run", (scope) => {
    const url = "https://github.com/example/app/actions/runs/42";
    const todo: ThreadTodo = {
      id: scope === "remote" ? "remote-todo:release-owner:todo-42" : "todo-42",
      backend: "codex", threadId: "thread-a", kind: "reminder", status: "open",
      ...(scope === "remote" ? { federationTarget: { scope, instanceId: "release-owner" } } : {}),
      title: "Review the signing gate", createdAt: 42, updatedAt: 42,
      ciApprovals: [{ url, repository: "example/app", runId: 42, environments: ["apple-signing"] }],
    };
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      const threadAKey = threadTodoThreadKey(todo);
      const { rerender } = render(<Harness initialWaits={[]} ciApprovalTodos={[]} threadAKey={threadAKey} />);
      fireEvent.click(screen.getByRole("button", { name: "Open thread A" }));
      rerender(<Harness initialWaits={[]} ciApprovalTodos={[todo]} threadAKey={threadAKey} />);
      // A saved, one-shot milestone can be delivered after GitHub advances the run.
      expect(screen.getByText("Deployment approval gate reached")).toBeInTheDocument();
      expect(screen.queryByText("Deployment approval needed")).not.toBeInTheDocument();
      expect(screen.getByText("apple-signing")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Review on GitHub" }));
      expect(open).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
      expect(screen.getByText("Deployment approval gate reached")).toBeInTheDocument();
      rerender(<Harness initialWaits={[]} ciApprovalTodos={[]} threadAKey={threadAKey} />);
      expect(screen.queryByText("Deployment approval gate reached")).not.toBeInTheDocument();
    } finally {
      open.mockRestore();
    }
  });

  describe("approving a deployment gate from the notice", () => {
    // Invented run and environment: no real release gate is involved.
    const url = "https://github.com/example/app/actions/runs/88";
    const reviewable: ThreadTodo = {
      id: "remote-todo:release-owner:todo-88", backend: "codex", threadId: "thread-b", kind: "reminder", status: "open",
      federationTarget: { scope: "remote", instanceId: "release-owner" },
      title: "Review the signing gate", createdAt: 88, updatedAt: 88,
      ciApprovals: [{ url, repository: "example/app", runId: 88, environments: ["windows-signing"], environmentIds: [301],
        attempt: 2, headSha: "a".repeat(40), ref: "v2.4.1" }],
    };

    it("asks first, then sends exactly the card's gate once, and keeps Review on GitHub", async () => {
      const review = vi.fn(async () => undefined);
      render(<Harness initialWaits={[]} ciApprovalTodos={[reviewable]} reviewCiDeployment={review} />);
      expect(screen.getByRole("button", { name: "Review on GitHub" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      expect(review).not.toHaveBeenCalled();
      expect(screen.getByText(/Approve windows-signing for example\/app run #88, attempt 2, aaaaaaaaaaaa\?/)).toBeInTheDocument();
      expect(screen.getByText(/account signed in on the card's PwrAgent/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(review).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      expect(review).toHaveBeenCalledExactlyOnceWith(reviewable, reviewable.ciApprovals![0]);
    });

    it("shows a running review and the owner's or GitHub's refusal on the notice", async () => {
      const review = vi.fn(async () => { throw new Error("Error invoking remote method 'thread-todos:review-ci-deployment': Error: This card's deployment gate changed after you saw it. Review it again."); });
      const { rerender } = render(<Harness initialWaits={[]} ciApprovalTodos={[reviewable]} reviewCiDeployment={review}
        runningTodoIds={new Set([reviewable.id])} />);
      expect(screen.getByText("Approving…")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
      const refused = { ...reviewable, error: "GitHub returned HTTP 422: Reviewer is not allowed to approve" };
      rerender(<Harness initialWaits={[]} ciApprovalTodos={[refused]} reviewCiDeployment={review} />);
      expect(screen.getByText(refused.error)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      expect(await screen.findByText("Could not approve: This card's deployment gate changed after you saw it. Review it again."))
        .toBeInTheDocument();
    });

    it("offers GitHub alone for a gate the owner cannot approve here", () => {
      const older = { ...reviewable, ciApprovals: [{ ...reviewable.ciApprovals![0]!, environmentIds: undefined }] };
      render(<Harness initialWaits={[]} ciApprovalTodos={[older]} reviewCiDeployment={vi.fn()} />);
      expect(screen.getByRole("button", { name: "Review on GitHub" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    });
  });

  it("hides one card without answering it, and keeps it hidden", () => {
    render(<Harness initialWaits={waitsFor([commandApproval, fileApproval])} />);

    // Newest approval first.
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(screen.getByText("Move the route table into one module.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: APPROVAL_NOTICE_HIDE_LABEL }));
    expect(screen.queryByText("Move the route table into one module.")).not.toBeInTheDocument();
    expect(screen.getByText("pnpm test --run checkout")).toBeInTheDocument();
    expect(screen.getByText("1 of 1")).toBeInTheDocument();

    // Hiding the other card, opening its thread and leaving it brings
    // neither back.
    fireEvent.click(screen.getByRole("button", { name: APPROVAL_NOTICE_HIDE_LABEL }));
    fireEvent.click(screen.getByRole("button", { name: "Open thread A" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave thread A" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("drops the card while its thread is on screen and once it is answered", () => {
    render(<Harness initialWaits={waitsFor([commandApproval])} />);

    fireEvent.click(screen.getByRole("button", { name: "Open thread A" }));
    expect(screen.queryByText("pnpm test --run checkout")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Leave thread A" }));
    expect(screen.getByText("pnpm test --run checkout")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Answer first" }));
    expect(screen.queryByText("pnpm test --run checkout")).not.toBeInTheDocument();
  });

  it("hides every approval card at once and leaves other notices", () => {
    render(
      <Harness
        initialWaits={waitsFor([commandApproval, mcpApproval])}
        otherNotices={[{ id: "other", title: "Codex login required", message: "Sign in again.", autoDismiss: false }]}
      />,
    );

    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide all approval notices" }));
    expect(screen.getByText("Codex login required")).toBeInTheDocument();
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
  });

  it("Hide all also hides the approval in the thread on screen", () => {
    render(
      <Harness
        initialWaits={waitsFor([commandApproval, mcpApproval, fileApproval])}
        otherNotices={[{ id: "other", title: "Codex login required", message: "Sign in again.", autoDismiss: false }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open thread A" }));
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide all approval notices" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave thread A" }));
    expect(screen.getByText("Codex login required")).toBeInTheDocument();
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
  });

  it("opens the request's thread from Review", () => {
    const onReview = vi.fn();
    render(<Harness initialWaits={waitsFor([commandApproval])} onReview={onReview} />);

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-a",
      key: "request:codex:thread-a:req-1000",
    }));
  });
});

const mcpSessionApproval = serverRequest("mcpServer/elicitation/request", {
  serverName: "github",
  mode: "form",
  _meta: {
    codex_approval_kind: "mcp_tool_call",
    pwragent_approval_kind: "mcp_tool_call",
    persist: ["session", "always"],
  },
  message: "Allow the agent to open a pull request on GitHub?",
  requestedSchema: { type: "object", properties: {} },
}, { createdAt: 5_000, threadId: "thread-e" });

describe("answering from an approval notice", () => {
  it("offers Review alone when the window cannot answer", () => {
    const [notice] = buildApprovalNotices({
      waits: waitsFor([commandApproval]),
      hiddenKeys: new Set(),
      threadTitleForKey: titleFor,
      onReview: vi.fn(),
      onHide: vi.fn(),
      onHideAll: vi.fn(),
    });
    expect(notice.actions).toHaveLength(1);
    expect(notice.actions?.[0]).not.toHaveProperty("menu");
  });

  it("keeps Review the default and lists the answers on its chevron", async () => {
    const onReview = vi.fn();
    const respond = vi.fn(() => new Promise<void>(() => {}));
    render(
      <Harness
        initialWaits={waitsFor([mcpSessionApproval])}
        onReview={onReview}
        respond={respond}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(respond).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Approval options" }));
    const menu = screen.getByRole("menu", { name: "Approval options" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Allow",
      "Allow this tool for this conversation",
      "Always allow",
      "Decline",
      "Cancel turn",
    ]);

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Allow this tool for this conversation" }));
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond.mock.calls[0]).toEqual([
      expect.objectContaining({ threadId: "thread-e" }),
      expect.objectContaining({ action: "accept" }),
    ]);
    // In flight: the card says so and takes no second answer.
    expect(screen.getByText("Allowing…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approval options" })).not.toBeInTheDocument();
  });

  it("answers a command approval and shows a refusal on the card", async () => {
    const respond = vi.fn(async () => {
      throw new Error("Error invoking remote method 'agent:submitServerRequest': Error: The turn already ended.");
    });
    render(<Harness initialWaits={waitsFor([commandApproval])} respond={respond} />);

    fireEvent.click(screen.getByRole("button", { name: "Approval options" }));
    const menu = screen.getByRole("menu", { name: "Approval options" });
    const labels = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
    expect(labels[0]).toMatch(/^(Approve|Allow)/);
    expect(labels).toContain("Decline");

    fireEvent.click(within(menu).getAllByRole("menuitem")[0]!);
    // Named as a failure, so it does not read as the request's own text.
    expect(await screen.findByText("Could not answer: The turn already ended.")).toBeInTheDocument();
    // A refused answer can be sent again.
    expect(screen.getByRole("button", { name: "Approval options" })).toBeInTheDocument();
  });

  it("closes an open menu when another notice takes the card", () => {
    const respond = vi.fn(() => new Promise<void>(() => {}));
    render(
      <Harness
        initialWaits={waitsFor([mcpSessionApproval, commandApproval])}
        respond={respond}
      />,
    );

    // Approvals lead the stack, so the command's notice is on the card.
    expect(screen.getByText("pnpm test --run checkout")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approval options" }));
    expect(screen.getByRole("menu", { name: "Approval options" })).toBeInTheDocument();
    // The command is answered elsewhere; the MCP notice takes the card.
    fireEvent.click(screen.getByRole("button", { name: "Answer first" }));
    expect(screen.getByText("Allow the agent to open a pull request on GitHub?")).toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(respond).not.toHaveBeenCalled();
  });

  it("gives the answers back when the owner still lists the request", async () => {
    // `respond` re-reads the queue before resolving, and the wait stays.
    const respond = vi.fn(async () => undefined);
    render(<Harness initialWaits={waitsFor([commandApproval])} respond={respond} />);

    fireEvent.click(screen.getByRole("button", { name: "Approval options" }));
    fireEvent.click(within(screen.getByRole("menu")).getAllByRole("menuitem")[0]!);
    expect(await screen.findByText(APPROVAL_STILL_OPEN_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approval options" })).toBeInTheDocument();
  });
});
