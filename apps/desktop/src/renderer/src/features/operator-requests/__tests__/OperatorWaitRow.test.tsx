import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
