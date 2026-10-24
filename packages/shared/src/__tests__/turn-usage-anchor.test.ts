import { describe, expect, it } from "vitest";
import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadTurnMetadata,
} from "../contracts/normalized-app-server";
import { anchorTurnUsageEntries } from "../thread-usage-display";

// The real mixed-clock shape: Codex stamps the user message at turn start and
// the final reply with its second-truncated completion; commentary and tool
// rows carry no time; the renderer stamps live rows and the usage row with the
// millisecond it saw them. The usage row reads as older than the reply.
const turnT = {
  id: "turn-t",
  status: "completed",
  startedAt: 1_792_852_051_000,
  completedAt: 1_792_852_200_000,
} satisfies AppServerThreadTurnMetadata;
const turnV = {
  id: "turn-v",
  status: "completed",
  startedAt: 1_792_853_600_000,
  completedAt: 1_792_853_760_000,
} satisfies AppServerThreadTurnMetadata;

function usage(
  turn: AppServerThreadTurnMetadata,
  createdAt: number,
): AppServerThreadActivityEntry {
  return {
    type: "activity",
    id: `live-turn-usage-${turn.id}`,
    summary: "Turn usage: 26,512 uncached in",
    status: "completed",
    details: [],
    createdAt,
    turn,
  };
}

const tUser: AppServerThreadEntry = {
  type: "message", id: "t-user", role: "user", text: "Authorize one packet",
  createdAt: turnT.startedAt, turn: turnT,
};
const tCommentary: AppServerThreadEntry = {
  type: "message", id: "t-commentary", role: "assistant", phase: "commentary",
  text: "Checking the probe.", turn: turnT,
};
const tTools: AppServerThreadEntry = {
  type: "activity", id: "activity-exec-t", summary: "Ran 6 commands",
  status: "completed", details: [], turn: turnT,
};
const tLive: AppServerThreadEntry = {
  type: "activity", id: "live-protocol-t", summary: "Used 2 tools",
  status: "completed", details: [], createdAt: turnT.completedAt + 400, turn: turnT,
};
const tFinal: AppServerThreadEntry = {
  type: "message", id: "t-final", role: "assistant", phase: "final",
  text: "The probe is running.", createdAt: turnT.completedAt, turn: turnT,
};
const vUser: AppServerThreadEntry = {
  type: "message", id: "v-user", role: "user", text: "Monitor finished",
  createdAt: turnV.startedAt, turn: turnV,
};
const vFinal: AppServerThreadEntry = {
  type: "message", id: "v-final", role: "assistant", phase: "final",
  text: "The serial packet is running.", createdAt: turnV.completedAt, turn: turnV,
};

function ids(entries: AppServerThreadEntry[]): string[] {
  return entries.map((entry) => entry.id);
}

describe("anchorTurnUsageEntries", () => {
  it("moves a turn total below its turn's final reply", () => {
    // Usage arrived before the final reply and was stamped first.
    const entries = [tUser, tCommentary, tTools, usage(turnT, turnT.completedAt - 300), tFinal];

    expect(ids(anchorTurnUsageEntries(entries))).toEqual([
      "t-user", "t-commentary", "activity-exec-t", "t-final", "live-turn-usage-turn-t",
    ]);
  });

  it("moves a turn total below a later live row of its own turn", () => {
    const entries = [tUser, tTools, tFinal, usage(turnT, turnT.completedAt + 200), tLive];

    expect(ids(anchorTurnUsageEntries(entries))).toEqual([
      "t-user", "activity-exec-t", "t-final", "live-protocol-t", "live-turn-usage-turn-t",
    ]);
  });

  it("moves a turn total back above a later turn", () => {
    const entries = [tUser, tTools, tFinal, vUser, vFinal, usage(turnT, turnT.completedAt + 200)];

    expect(ids(anchorTurnUsageEntries(entries))).toEqual([
      "t-user", "activity-exec-t", "t-final", "live-turn-usage-turn-t", "v-user", "v-final",
    ]);
  });

  it("keeps a turn total beside its turn when a row without a turn sits between", () => {
    const transition: AppServerThreadEntry = {
      type: "activity", id: "messaging-binding-transition-bind-1",
      summary: "Bound to Telegram", status: "completed", details: [],
      createdAt: turnT.completedAt + 100,
    };
    const entries = [tUser, tFinal, transition, usage(turnT, turnT.completedAt + 300)];

    expect(ids(anchorTurnUsageEntries(entries))).toEqual([
      "t-user", "t-final", "live-turn-usage-turn-t", "messaging-binding-transition-bind-1",
    ]);
  });

  it("anchors by the ledger turn when the row has no turn metadata", () => {
    const { turn: _turn, ...withoutTurn } = usage(turnT, turnT.completedAt - 300);
    const row: AppServerThreadActivityEntry = {
      ...withoutTurn,
      id: "usage-from-ledger",
      usageLine: { turnId: turnT.id } as AppServerThreadActivityEntry["usageLine"],
    };

    expect(ids(anchorTurnUsageEntries([tUser, row, tFinal, vUser]))).toEqual([
      "t-user", "t-final", "usage-from-ledger", "v-user",
    ]);
  });

  it("leaves monitor and per-request usage where they are", () => {
    const monitor: AppServerThreadEntry = {
      type: "activity", id: "monitor-usage-t", summary: "Monitor usage: 4,000 uncached in",
      status: "completed", details: [], createdAt: turnT.startedAt + 10, turn: turnT,
    };
    const latest: AppServerThreadEntry = {
      type: "activity", id: "live-token-usage-turn-t",
      summary: "Latest request usage: 1,000 uncached in", status: "completed",
      details: [], createdAt: turnT.startedAt + 20, turn: turnT,
    };
    const entries = [tUser, monitor, latest, tFinal];

    expect(anchorTurnUsageEntries(entries)).toBe(entries);
  });

  it("leaves a turn total in place when its turn has no other entry", () => {
    const entries = [vUser, usage(turnT, turnT.completedAt), vFinal];

    expect(anchorTurnUsageEntries(entries)).toBe(entries);
  });

  it("returns the same array when every total is already anchored", () => {
    const entries = [tUser, tFinal, usage(turnT, turnT.completedAt - 300), vUser, vFinal];

    expect(anchorTurnUsageEntries(entries)).toBe(entries);
  });
});
