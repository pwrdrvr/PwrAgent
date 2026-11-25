import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerThreadActivityEntry } from "@pwragent/shared/contracts/normalized-app-server";
import {
  buildLiveToolDetails,
  getNotificationItem,
} from "../../renderer/src/features/thread-detail/live-transcript-activity";
import { acpToolUpdateNotifications } from "../acp/acp-live-notifications";
import {
  AcpSessionReplayNormalizer,
  acpSessionReplayNormalizerOptions,
} from "../acp/acp-session-normalizer";

const sessionId = "session-acp-file-read";

function activities(normalizer: AcpSessionReplayNormalizer): AppServerThreadActivityEntry[] {
  return normalizer.replay().entries.filter(
    (entry): entry is AppServerThreadActivityEntry => entry.type === "activity",
  );
}

function replay(
  backendId: string,
  frames: Record<string, unknown>[],
  cwd?: string,
): AcpSessionReplayNormalizer {
  const normalizer = new AcpSessionReplayNormalizer(
    acpSessionReplayNormalizerOptions(backendId, cwd),
  );
  frames.forEach((update, index) => {
    normalizer.apply({ sessionId, receivedAt: 1_000 + index, update });
  });
  return normalizer;
}

/** Antigravity ACP `read_file` frames: title omits leading `/`, Path/locations keep it. */
function antigravityReadFileFrames(params: {
  id: string;
  path: string;
  startLine?: number;
  endLine?: number;
  includeLocations?: boolean;
  sparseCompletion?: boolean;
}): Record<string, unknown>[] {
  const rawInput: Record<string, unknown> = {
    Path: params.path,
    ...(params.startLine !== undefined ? { StartLine: params.startLine } : {}),
    ...(params.endLine !== undefined ? { EndLine: params.endLine } : {}),
  };
  const title = `File ${params.path.replace(/^\/+/, "")}`;
  const base = {
    toolCallId: params.id,
    name: "read_file",
    args: rawInput,
    kind: "read",
    title,
    ...(params.includeLocations === false ? {} : { locations: [{ path: params.path }] }),
    rawInput,
  };
  return [
    { sessionUpdate: "tool_call", ...base, status: "in_progress" },
    params.sparseCompletion
      ? { sessionUpdate: "tool_call_update", toolCallId: params.id, status: "completed" }
      : { sessionUpdate: "tool_call_update", ...base, status: "completed" },
  ];
}

describe("ACP file read and listing normalization", () => {
  it("keeps a late Grok line range after a location-only start and sparse completion", () => {
    expectLateReadRange("acp:grok", "/repo/file.ts", "file.ts", {
      target_file: "/repo/file.ts", offset: 2, limit: 1,
    }, 2, 2);
  });

  it("keeps late read ranges in both labels after sparse updates", () => {
    fc.assert(fc.property(
      fc.constantFrom("acp:grok", "acp:antigravity"),
      fc.stringMatching(/^[a-z]{1,12}\.ts$/u),
      fc.integer({ min: 1, max: 2_000 }),
      fc.integer({ min: 1, max: 500 }),
      fc.boolean(),
      (backendId, fileName, start, limit, includePath) => {
        const path = `/repo/${fileName}`;
        const end = start + limit - 1;
        const rawInput = backendId === "acp:grok"
          ? { offset: start, limit, ...(includePath ? { target_file: path } : {}) }
          : { StartLine: start, EndLine: end, ...(includePath ? { Path: path } : {}) };
        expectLateReadRange(backendId, path, fileName, rawInput, start, end);
      },
    ));
  });

  it("names an Antigravity read_file row by its filename instead of its slashless worktree path", () => {
    const target = "/Users/dev/.pwragent/worktrees/ab12/PwrAgnt/docs/local-cpu-checkout.md";
    const [activity] = activities(
      replay(
        "acp:antigravity",
        antigravityReadFileFrames({ id: "call-read-1", path: target }),
        "/Users/dev/.pwragent/worktrees/ab12/PwrAgnt",
      ),
    );

    expect(activity).toMatchObject({
      summary: "Read local-cpu-checkout.md",
      status: "completed",
      details: [{
        kind: "read",
        label: "Read local-cpu-checkout.md",
        path: target,
      }],
    });
  });

  it("includes StartLine and EndLine ranges on Antigravity read_file rows", () => {
    const target = "/Users/dev/.pwragent/worktrees/ab12/PwrAgnt/apps/desktop/src/main/app-server/managed-review-service.ts";
    const [ranged] = activities(
      replay(
        "acp:antigravity",
        antigravityReadFileFrames({ id: "call-range", path: target, startLine: 900, endLine: 1030 }),
      ),
    );
    expect(ranged?.summary).toBe("Read managed-review-service.ts (lines 900-1030)");

    const [fromLine] = activities(
      replay(
        "acp:antigravity",
        antigravityReadFileFrames({ id: "call-from", path: target, startLine: 50 }),
      ),
    );
    expect(fromLine?.summary).toBe("Read managed-review-service.ts (from line 50)");

    const [upToLine] = activities(
      replay(
        "acp:antigravity",
        antigravityReadFileFrames({ id: "call-to", path: target, endLine: 80 }),
      ),
    );
    expect(upToLine?.summary).toBe("Read managed-review-service.ts (lines 1-80)");
  });

  it("names generic ACP list_dir calls by their directory name", () => {
    const target = "/Users/dev/.pwragent/worktrees/ab12/PwrAgnt/apps/desktop";
    const [activity] = activities(
      replay("acp:antigravity", [
        {
          sessionUpdate: "tool_call",
          toolCallId: "call-list-1",
          name: "list_dir",
          kind: "read",
          status: "in_progress",
          title: `Dir ${target.slice(1)}`,
          rawInput: { Path: target },
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-list-1",
          status: "completed",
        },
      ]),
    );

    expect(activity).toMatchObject({
      summary: "Listed desktop",
      status: "completed",
      details: [{ kind: "read", label: "Listed desktop", path: target }],
    });
  });

  it.each([
    ["/repo/docs/guide.md", "guide.md"],
    ["C:\\repo\\docs\\guide.md", "guide.md"],
  ])("displays the live ACP read at %s by filename using rawInput.Path alone", (target, fileName) => {
    expectLiveReadLabel(target, fileName);
  });

  it("displays live ACP reads by filename across Windows path forms", () => {
    fc.assert(fc.property(
      fc.constantFrom("C:\\", "D:\\", "\\\\server\\share\\", "C:/"),
      fc.array(fc.stringMatching(/^[a-z]{1,12}$/u), { minLength: 1, maxLength: 5 }),
      fc.stringMatching(/^[a-z]{1,12}\.md$/u),
      (root, directories, fileName) => {
        const separator = root.endsWith("\\") ? "\\" : "/";
        expectLiveReadLabel(`${root}${[...directories, fileName].join(separator)}`, fileName);
      },
    ));
  });

  function expectLiveReadLabel(target: string, fileName: string): void {
    const [opening] = antigravityReadFileFrames({
      id: "call-live-read",
      path: target,
      includeLocations: false,
    });
    const [notification] = acpToolUpdateNotifications({
      backendId: "acp:antigravity",
      threadId: sessionId,
      turnId: "turn-1",
      update: { ...opening, title: fileName },
    });
    expect(notification?.method).toBe("item/started");
    const item = getNotificationItem(notification!.params);
    expect(item?.commandActions).toMatchObject([{ type: "read", path: target }]);
    expect(buildLiveToolDetails(item!)).toMatchObject([{ kind: "read", label: `Read ${fileName}` }]);
  }

  function expectLateReadRange(
    backendId: string,
    path: string,
    fileName: string,
    rawInput: Record<string, unknown>,
    start: number,
    end: number,
  ): void {
    const toolCallId = "late-range-read";
    const label = `Read ${fileName} (lines ${start}-${end})`;
    const normalizer = replay(backendId, [
      {
        sessionUpdate: "tool_call", toolCallId, name: "read_file", title: "read_file",
        kind: "read", status: "in_progress", locations: [{ path }],
      },
      { sessionUpdate: "tool_call_update", toolCallId, rawInput },
      // A repeated location with no input must preserve the richer metadata too.
      { sessionUpdate: "tool_call_update", toolCallId, locations: [{ path }] },
      { sessionUpdate: "tool_call_update", toolCallId, status: "completed" },
    ]);
    expect(activities(normalizer)).toMatchObject([{
      summary: label,
      status: "completed",
      details: [{ kind: "read", label, path }],
    }]);
  }

  it("property: ACP read_file calls across backends always name the file and preserve the full path", () => {
    const segment = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,10}$/u);
    const scenario = fc.record({
      backendId: fc.constantFrom("acp:antigravity", "acp:grok", "acp:gemini", "acp:qwen", "acp:kimi"),
      pathKey: fc.constantFrom("Path", "target_file", "file_path", "path"),
      segments: fc.array(segment, { minLength: 2, maxLength: 6 }),
      startLine: fc.option(fc.integer({ min: 1, max: 2_000 }), { nil: undefined }),
      span: fc.option(fc.integer({ min: 0, max: 500 }), { nil: undefined }),
      includeLocations: fc.boolean(),
      sparseCompletion: fc.boolean(),
    });

    fc.assert(
      fc.property(scenario, (input) => {
        const fileName = input.segments.at(-1)!;
        const fullPath = `/${input.segments.join("/")}`;
        const endLine = input.span !== undefined
          ? (input.startLine ?? 1) + input.span
          : undefined;
        const rawInput: Record<string, unknown> = {
          [input.pathKey]: fullPath,
          ...(input.startLine !== undefined ? { StartLine: input.startLine } : {}),
          ...(endLine !== undefined ? { EndLine: endLine } : {}),
        };
        const opening: Record<string, unknown> = {
          sessionUpdate: "tool_call",
          toolCallId: "call-prop-read",
          name: "read_file",
          kind: "read",
          status: "in_progress",
          title: `File ${fullPath.slice(1)}`,
          rawInput,
          ...(input.includeLocations ? { locations: [{ path: fullPath }] } : {}),
        };
        const completion: Record<string, unknown> = input.sparseCompletion
          ? { sessionUpdate: "tool_call_update", toolCallId: "call-prop-read", status: "completed" }
          : { ...opening, sessionUpdate: "tool_call_update", status: "completed" };

        const [activity] = activities(replay(input.backendId, [opening, completion]));
        const expectedRange = endLine !== undefined
          ? `lines ${input.startLine ?? 1}-${endLine}`
          : input.startLine !== undefined && input.startLine > 1
            ? `from line ${input.startLine}`
            : undefined;
        const expectedLabel = `Read ${fileName}${expectedRange ? ` (${expectedRange})` : ""}`;

        expect(activity?.summary).toBe(expectedLabel);
        expect(activity?.details).toHaveLength(1);
        expect(activity?.details[0]).toMatchObject({
          kind: "read",
          label: expectedLabel,
          path: fullPath,
        });

        const [live] = acpToolUpdateNotifications({
          backendId: input.backendId,
          threadId: sessionId,
          turnId: "turn-1",
          update: opening,
        });
        expect(live).toMatchObject({
          params: {
            item: {
              commandActions: [expect.objectContaining({ type: "read", path: fullPath })],
            },
          },
        });
      }),
      { numRuns: 300 },
    );
  });
});
