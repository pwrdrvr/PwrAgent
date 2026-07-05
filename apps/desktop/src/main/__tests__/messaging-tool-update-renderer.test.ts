import { describe, expect, it } from "vitest";

import type { MessagingToolActivity } from "../messaging/core/messaging-tool-activity.js";
import {
  buildToolUpdateBatchMessageIntent,
  buildToolUpdateMessageIntent,
} from "../messaging/core/messaging-renderer.js";

const tool = (id: string, title: string): MessagingToolActivity => ({
  id,
  kind: "tool",
  status: "completed",
  title,
});

const prose = (id: string, text: string): MessagingToolActivity => ({
  id,
  kind: "prose",
  status: "completed",
  title: text,
});

describe("tool-update renderer prose handling", () => {
  it("renders an individual tool activity as a system tool-update line", () => {
    const intent = buildToolUpdateMessageIntent({
      activity: tool("t1", "Ran tests"),
      bindingId: "b1",
      createdAt: 1,
      id: "i1",
    });
    expect(intent.role).toBe("system");
    expect(intent.parts[0]).toMatchObject({
      text: "Tool update: Ran tests",
      markdown: "light",
    });
  });

  it("renders individual prose verbatim as an assistant markdown message", () => {
    const intent = buildToolUpdateMessageIntent({
      activity: prose("p1", "Let me check the config first."),
      bindingId: "b1",
      createdAt: 1,
      id: "i2",
    });
    expect(intent.role).toBe("assistant");
    expect(intent.parts[0]).toMatchObject({
      text: "Let me check the config first.",
      markdown: "markdown",
    });
  });

  it("keeps the tool-only batch header and format unchanged", () => {
    const intent = buildToolUpdateBatchMessageIntent({
      activities: [tool("t1", "Ran tests"), tool("t2", "Edited app.ts")],
      bindingId: "b1",
      createdAt: 1,
      id: "i3",
    });
    expect(intent.role).toBe("system");
    const part = intent.parts[0];
    expect("text" in part ? part.text : "").toBe(
      "Tool updates: ran 2 tools\n- Ran tests\n- Edited app.ts",
    );
  });

  it("renders a mixed prose+tool batch as assistant with prose above the tool summary", () => {
    const intent = buildToolUpdateBatchMessageIntent({
      activities: [
        prose("p1", "Looking into the failing test."),
        tool("t1", "Ran tests"),
      ],
      bindingId: "b1",
      createdAt: 1,
      id: "i4",
    });
    expect(intent.role).toBe("assistant");
    const part = intent.parts[0];
    const text = "text" in part ? part.text : "";
    expect(text).toBe(
      "Looking into the failing test.\n\nTool updates: ran 1 tool\n- Ran tests",
    );
    expect(part).toMatchObject({ markdown: "markdown" });
  });
});
