import { describe, expect, it } from "vitest";
import {
  validateSlackCallbackHandle,
  validateSlackChannelId,
  validateSlackFileId,
  validateSlackMessageTs,
  validateSlackTeamId,
  validateSlackUserId,
} from "../validate-ids.ts";

describe("Slack identifier validation", () => {
  it("accepts Slack actor, team, channel, file, and timestamp identifiers", () => {
    expect(validateSlackUserId("U012ABCDEF0")).toEqual({ ok: true });
    expect(validateSlackUserId("W012ABCDEF0")).toEqual({ ok: true });
    expect(validateSlackTeamId("T012ABCDEF0")).toEqual({ ok: true });
    expect(validateSlackChannelId("C012ABCDEF0")).toEqual({ ok: true });
    expect(validateSlackChannelId("G012ABCDEF0")).toEqual({ ok: true });
    expect(validateSlackChannelId("D012ABCDEF0")).toEqual({ ok: true });
    expect(validateSlackFileId("F012ABCDEF0")).toEqual({ ok: true });
    expect(validateSlackMessageTs("1712023032.123456")).toEqual({ ok: true });
    expect(validateSlackCallbackHandle("slack:abcdefghijklmnopqr")).toEqual({
      ok: true,
    });
  });

  it("rejects malformed identifiers without permissive regexes", () => {
    expect(validateSlackUserId("u012ABCDEF0")).toEqual({
      ok: false,
      reason: "format",
    });
    expect(validateSlackChannelId("C012_ABC")).toEqual({
      ok: false,
      reason: "format",
    });
    expect(validateSlackMessageTs("1712023032")).toEqual({
      ok: false,
      reason: "format",
    });
    expect(validateSlackCallbackHandle("discord:abcdefghijklmnopqr")).toEqual({
      ok: false,
      reason: "format",
    });
  });
});
