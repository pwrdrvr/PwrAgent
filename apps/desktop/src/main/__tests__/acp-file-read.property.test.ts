import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerThreadActivityEntry } from "@pwragent/shared/contracts/normalized-app-server";
import {
  buildLiveToolDetails,
  getNotificationItem,
  mergeActivityDetails,
  summarizeLiveActivity,
} from "../../renderer/src/features/thread-detail/live-transcript-activity";
import { AcpLiveToolUpdateResolver, acpToolUpdateNotifications } from "../acp/acp-live-notifications";
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

function liveDetails(backendId: string, frames: Record<string, unknown>[]) {
  const resolver = new AcpLiveToolUpdateResolver();
  const context = { backendId, threadId: sessionId, turnId: "turn-1" };
  let details: AppServerThreadActivityEntry["details"] = [];
  for (const update of frames) {
    const resolved = resolver.resolve({ ...context, update });
    if (!resolved) {
      continue;
    }
    for (const notification of acpToolUpdateNotifications({ ...context, update: resolved })) {
      const item = getNotificationItem(notification.params);
      if (item) {
        details = mergeActivityDetails(details, buildLiveToolDetails(item));
      }
    }
  }
  return details;
}

function expectLiveAndReplayLabels(backendId: string, frames: Record<string, unknown>[]): void {
  const [activity] = activities(replay(backendId, frames));
  const details = liveDetails(backendId, frames);
  expect(details).toHaveLength(1);
  expect(details[0]).toMatchObject({
    kind: activity?.details[0]?.kind,
    label: activity?.details[0]?.label,
    path: activity?.details[0]?.path,
  });
  expect(summarizeLiveActivity(details)).toBe(activity?.summary);
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
    expectLateReadRange("acp:grok", "/repo/file.ts", "file.ts", [{
      target_file: "/repo/file.ts", offset: 2, limit: 1,
    }], 2, 2);
  });

  it("keeps late read ranges in both labels after sparse updates", () => {
    fc.assert(fc.property(
      fc.constantFrom("acp:grok", "acp:antigravity"),
      fc.stringMatching(/^[a-z]{1,12}\.ts$/u),
      fc.integer({ min: 1, max: 2_000 }),
      fc.integer({ min: 1, max: 500 }),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      (backendId, fileName, start, limit, includePath, windows, splitBounds) => {
        const path = windows ? `C:\\repo\\${fileName}` : `/repo/${fileName}`;
        const end = start + limit - 1;
        const from = backendId === "acp:grok"
          ? { offset: start, ...(includePath ? { target_file: path } : {}) }
          : { StartLine: start, ...(includePath ? { Path: path } : {}) };
        const to = backendId === "acp:grok" ? { limit } : { EndLine: end };
        const inputs = splitBounds ? [from, to] : [{ ...from, ...to }];
        expectLateReadRange(backendId, path, fileName, inputs, start, end);
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
    const frames = [
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
    ];
    const [activity] = activities(replay("acp:antigravity", frames));

    expect(activity).toMatchObject({
      summary: "Listed desktop",
      status: "completed",
      details: [{ kind: "read", label: "Listed desktop", path: target }],
    });
    expectLiveAndReplayLabels("acp:antigravity", frames);
    const listing = liveDetails("acp:antigravity", frames);
    expect(summarizeLiveActivity([
      ...listing,
      { id: "other-read", kind: "read", label: "Read example.ts", path: "/repo/example.ts" },
    ])).toBe("Explored 1 file, 1 list");
  });

  it("keeps live and replay directory labels aligned when input arrives after locations", () => {
    fc.assert(fc.property(
      fc.constantFrom("acp:grok", "acp:antigravity"),
      fc.constantFrom("/repo/", "C:\\repo\\"),
      fc.stringMatching(/^[a-z]{1,12}$/u),
      (backendId, root, dirName) => {
        const toolCallId = "call-late-list";
        const opening = backendId === "acp:grok"
          ? { _meta: { "x.ai/tool": { name: "list_dir", kind: "list" } } }
          : { name: "list_dir" };
        const path = `${root}${dirName}`;
        const rawInput = backendId === "acp:grok" ? { target_directory: path } : { Path: path };
        expectLiveAndReplayLabels(backendId, [
          {
            sessionUpdate: "tool_call", toolCallId, kind: "read", status: "in_progress",
            locations: [{ path: `${root}pending` }], title: "List directory", ...opening,
          },
          { sessionUpdate: "tool_call_update", toolCallId, rawInput },
          { sessionUpdate: "tool_call_update", toolCallId, status: "completed" },
        ]);
      },
    ));
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
    inputs: Record<string, unknown>[],
    start: number,
    end: number,
  ): void {
    const toolCallId = "late-range-read";
    const label = `Read ${fileName} (lines ${start}-${end})`;
    const frames = [
      {
        sessionUpdate: "tool_call", toolCallId, name: "read_file", title: "read_file",
        kind: "read", status: "in_progress", locations: [{ path }],
      },
      ...inputs.map((rawInput) => ({ sessionUpdate: "tool_call_update", toolCallId, rawInput })),
      // A repeated location with no input must preserve the richer metadata too.
      { sessionUpdate: "tool_call_update", toolCallId, locations: [{ path }] },
      { sessionUpdate: "tool_call_update", toolCallId, status: "completed" },
    ];
    expect(activities(replay(backendId, frames))).toMatchObject([{
      summary: label,
      status: "completed",
      details: [{ kind: "read", label, path }],
    }]);
    expectLiveAndReplayLabels(backendId, frames);
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
