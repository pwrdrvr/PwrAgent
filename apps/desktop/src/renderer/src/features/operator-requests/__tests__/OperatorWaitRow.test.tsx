import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexAsyncQuestionItemId, parseCodexAsyncQuestionReply } from "@pwragent/shared";
import { OperatorWaitRow } from "../OperatorWaitRow";
import { buildOperatorWaits } from "../operator-waits";

afterEach(cleanup);

describe("OperatorWaitRow MCP login", () => {
  it.each(["Allow", "Decline"])("can %s a URL elicitation in the selected thread", async (label) => {
    const [wait] = buildOperatorWaits({ serverRequests: [{
      backend: "codex", createdAt: Date.now(), notification: {
        method: "mcpServer/elicitation/request", params: {
          threadId: "thread-1", turnId: "turn-1", requestId: "57",
          serverName: "codex_apps", mode: "url", message: "Reconnect GitHub",
          url: "https://chatgpt.com/connector", elicitationId: "57",
        },
      },
    }], questions: [], seenKeys: [] });
    const respond = vi.fn(async () => undefined);
    render(<OperatorWaitRow wait={wait!} current unread={false} respond={respond}
      dismissQuestion={vi.fn()} openWait={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href"))
      .toBe("https://chatgpt.com/connector");
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith(wait, {
      action: label === "Allow" ? "accept" : "decline", content: label === "Allow" ? {} : null, _meta: null,
    }));
  });
});

describe("OperatorWaitRow questions", () => {
  const questionWait = (questions: Array<{ title: string; options: string[] | null }>) => {
    const [wait] = buildOperatorWaits({ serverRequests: [], questions: [{
      backend: "codex", threadId: "thread-1", messageId: "msg-1", questions, createdAt: Date.now(),
    }], seenKeys: [] });
    return wait!;
  };
  const renderRow = (
    wait: ReturnType<typeof questionWait>,
    props: Partial<Parameters<typeof OperatorWaitRow>[0]> = {},
  ) => {
    const openWait = vi.fn();
    render(<OperatorWaitRow wait={wait} current unread={false} respond={vi.fn()}
      dismissQuestion={vi.fn(async () => undefined)} openWait={openWait} {...props} />);
    return { openWait };
  };

  it("opens the card of a question in the thread on screen", () => {
    const wait = questionWait([{ title: "Which bucket?", options: null }]);
    const { openWait } = renderRow(wait);
    fireEvent.click(screen.getByRole("button", { name: "Show question in thread: Which bucket?" }));
    expect(openWait).toHaveBeenCalledWith(wait);
    // Without a composer to answer through, the row offers no Answer.
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
  });

  it("answers a free-text question in the row through the composer", async () => {
    const wait = questionWait([{ title: "Which bucket?", options: null }]);
    const answerQuestion = vi.fn(async (_text: string) => true);
    renderRow(wait, { answerQuestion });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    const form = screen.getByRole("group", { name: "Answer: Which bucket?" });
    const text = within(form).getByLabelText("Your answer");
    expect(document.activeElement).toBe(text);
    expect(within(form).getByRole("button", { name: "Answer" })).toHaveProperty("disabled", true);
    fireEvent.change(text, { target: { value: "staging-exports" } });
    fireEvent.click(within(form).getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledTimes(1));
    expect(parseCodexAsyncQuestionReply(answerQuestion.mock.calls[0]![0])).toEqual([{
      questionItemId: codexAsyncQuestionItemId("msg-1", 0),
      question: "Which bucket?",
      answer: "staging-exports",
    }]);
    await waitFor(() => expect(screen.queryByRole("group", { name: "Answer: Which bucket?" })).toBeNull());
  });

  it("sends the recommended option unless another is chosen or text is typed", async () => {
    const wait = questionWait([
      { title: "Keep the toast?", options: ["Keep it", "Dismiss it"] },
      { title: "Which bucket?", options: null },
    ]);
    const answerQuestion = vi.fn(async (_text: string) => true);
    renderRow(wait, { answerQuestion });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    const form = screen.getByRole("group", { name: "Answer: Keep the toast?" });
    expect(document.activeElement).toBe(within(form).getByRole("button", { name: /Keep it/ }));
    expect(within(form).getByText("1 of 2 answered")).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledTimes(1));
    expect(parseCodexAsyncQuestionReply(answerQuestion.mock.calls[0]![0])).toEqual([{
      questionItemId: codexAsyncQuestionItemId("msg-1", 0),
      question: "Keep the toast?",
      answer: "Keep it",
    }]);
  });

  it("keeps the form and its text when the composer refuses the answer", async () => {
    const wait = questionWait([{ title: "Which bucket?", options: null }]);
    renderRow(wait, { answerQuestion: vi.fn(async () => false) });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    const form = screen.getByRole("group", { name: "Answer: Which bucket?" });
    fireEvent.change(within(form).getByLabelText("Your answer"), { target: { value: "staging" } });
    fireEvent.click(within(form).getByRole("button", { name: "Answer" }));
    expect((await within(form).findByRole("alert")).textContent).toContain("not sent");
    expect(within(form).getByLabelText<HTMLTextAreaElement>("Your answer").value).toBe("staging");
  });

  it("returns focus to Answer on Cancel", () => {
    const wait = questionWait([{ title: "Which bucket?", options: null }]);
    renderRow(wait, { answerQuestion: vi.fn(async () => true) });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Answer: Which bucket?" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Answer" }));
  });

  it("keeps focus on the row once an answer is sent", async () => {
    const wait = questionWait([{ title: "Which bucket?", options: null }]);
    renderRow(wait, { answerQuestion: vi.fn(async (_text: string) => true) });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "staging" } });
    fireEvent.click(within(screen.getByRole("group")).getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Show question in thread: Which bucket?" }),
    ));
  });

  it("closes the form when the row leaves the thread on screen", () => {
    const wait = questionWait([{ title: "Which bucket?", options: null }]);
    const props = {
      wait, unread: false, respond: vi.fn(), openWait: vi.fn(),
      dismissQuestion: vi.fn(async () => undefined),
    };
    const answerQuestion = vi.fn(async (_text: string) => true);
    const { rerender } = render(<OperatorWaitRow {...props} current answerQuestion={answerQuestion} />);
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(screen.getByRole("group")).toBeTruthy();
    rerender(<OperatorWaitRow {...props} current={false} />);
    rerender(<OperatorWaitRow {...props} current answerQuestion={answerQuestion} />);
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("says the answer is sent until the reply lands", () => {
    const wait = questionWait([{ title: "Which bucket?", options: null }]);
    renderRow(wait, { answerQuestion: vi.fn(async () => true), questionSent: true });
    expect(screen.getByRole("status").textContent).toContain("Answer sent");
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
  });

  it("opens another thread's question on its card", () => {
    const wait = questionWait([{ title: "Which bucket?", options: null }]);
    const { openWait } = renderRow(wait, { current: false });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(openWait).toHaveBeenCalledWith(wait);
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("answers another thread's question in the row when its owner can take it", async () => {
    const wait = questionWait([{ title: "Which bucket?", options: null }]);
    const answerQuestion = vi.fn(async (_text: string) => true);
    const { openWait } = renderRow(wait, { current: false, answerQuestion });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    const form = screen.getByRole("group", { name: "Answer: Which bucket?" });
    fireEvent.change(within(form).getByLabelText("Your answer"), { target: { value: "staging" } });
    fireEvent.click(within(form).getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledTimes(1));
    // Answering leaves the operator where they are.
    expect(openWait).not.toHaveBeenCalled();
  });

  it("says why the thread's owner refused the answer", async () => {
    const wait = questionWait([{ title: "Which bucket?", options: null }]);
    const refusal = "This thread is locked: Parked. Unlock it before starting a turn.";
    renderRow(wait, {
      current: false,
      answerQuestion: vi.fn(async () => { throw new Error(refusal); }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    const form = screen.getByRole("group", { name: "Answer: Which bucket?" });
    fireEvent.change(within(form).getByLabelText("Your answer"), { target: { value: "staging" } });
    fireEvent.click(within(form).getByRole("button", { name: "Answer" }));
    expect((await within(form).findByRole("alert")).textContent)
      .toBe(`The answer was not sent. ${refusal}`);
    expect(within(form).getByLabelText<HTMLTextAreaElement>("Your answer").value).toBe("staging");
  });
});
