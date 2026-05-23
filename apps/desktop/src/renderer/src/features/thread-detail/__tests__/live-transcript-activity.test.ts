import { describe, expect, it } from "vitest";
import { buildLiveToolDetails } from "../live-transcript-activity";

describe("buildLiveToolDetails", () => {
  it("surfaces collaboration agent activity from live tool items", () => {
    const details = buildLiveToolDetails({
      type: "collabAgentToolCall",
      id: "collab-spawn-1",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: "parent-thread",
      receiverThreadIds: ["019e5630-b147-7980-9f33-3cd7997c235a"],
      prompt: "You are the correctness reviewer.",
      agentsStates: {
        "019e5630-b147-7980-9f33-3cd7997c235a": {
          status: "running",
          message: "Inspecting the diff.\nStill running reviewer output.",
        },
      },
    });

    expect(details).toEqual([
      {
        id: "collab-spawn-1",
        kind: "command",
        label: "Spawning agent 019e5630",
        status: "in_progress",
        command: expect.objectContaining({
          displayCommand: "spawnAgent 019e5630",
          output: expect.stringContaining("Prompt: You are the correctness reviewer."),
        }),
      },
    ]);
    expect(details[0]?.command?.output).toContain("Still running reviewer output.");
  });
});
