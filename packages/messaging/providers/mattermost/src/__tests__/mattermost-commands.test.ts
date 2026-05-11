import { describe, expect, it } from "vitest";
import {
  appendCommandPath,
  baseTriggerForPrefixed,
  buildMattermostCommandRequest,
  DEFAULT_MATTERMOST_COMMAND_PREFIX,
  desiredMattermostCommands,
  reconcileMattermostCommands,
  sanitizeMattermostCommandPrefix,
  type MattermostCommandRecord,
  type MattermostCommandsApi,
  type MattermostCommandSpec,
} from "../mattermost-commands.ts";

const TEAM_ID = "team-1";
const BASE_URL = "https://callback.example.com/cb";

const SPECS: MattermostCommandSpec[] = [
  {
    trigger: "resume",
    displayName: "PwrAgent Resume",
    description: "Bind this conversation to a PwrAgent thread.",
    autoCompleteDesc: "Choose a PwrAgent thread to control from this conversation.",
    autoCompleteHint: "[--projects | --new]",
  },
  {
    trigger: "status",
    displayName: "PwrAgent Status",
    description: "Show the current PwrAgent thread binding and controls.",
    autoCompleteDesc: "Show the current PwrAgent thread binding and controls.",
  },
];

function existingFor(spec: MattermostCommandSpec, overrides: Partial<MattermostCommandRecord> = {}): MattermostCommandRecord {
  const desired = buildMattermostCommandRequest({
    spec,
    teamId: TEAM_ID,
    callbackBaseUrl: BASE_URL,
  });
  return {
    id: `cmd-${spec.trigger}`,
    token: `token-${spec.trigger}`,
    team_id: TEAM_ID,
    trigger: spec.trigger,
    url: desired.url,
    method: "P",
    display_name: desired.display_name,
    description: desired.description,
    auto_complete: desired.auto_complete,
    auto_complete_desc: desired.auto_complete_desc,
    auto_complete_hint: desired.auto_complete_hint,
    ...overrides,
  };
}

function fakeApi(initial: MattermostCommandRecord[]): {
  api: MattermostCommandsApi;
  state: MattermostCommandRecord[];
  calls: { add: number; edit: number; delete: number };
} {
  const state = [...initial];
  const calls = { add: 0, edit: 0, delete: 0 };
  let nextId = state.length + 1;
  const api: MattermostCommandsApi = {
    async getCustomTeamCommands(teamId) {
      return state.filter((c) => c.team_id === teamId);
    },
    async addCommand(cmd) {
      calls.add += 1;
      const created: MattermostCommandRecord = {
        ...cmd,
        id: `cmd-new-${nextId++}`,
        token: `token-new-${cmd.trigger}`,
      };
      state.push(created);
      return created;
    },
    async editCommand(cmd) {
      calls.edit += 1;
      const idx = state.findIndex((c) => c.id === cmd.id);
      if (idx >= 0) {
        state[idx] = { ...cmd };
      }
      return cmd;
    },
    async deleteCommand(id) {
      calls.delete += 1;
      const idx = state.findIndex((c) => c.id === id);
      if (idx >= 0) {
        state.splice(idx, 1);
      }
      return { status: "OK" };
    },
  };
  return { api, state, calls };
}

describe("appendCommandPath", () => {
  it("appends /command to a base URL with no trailing slash", () => {
    expect(appendCommandPath("https://callback.example.com/cb")).toBe(
      "https://callback.example.com/cb/command",
    );
  });
  it("normalizes trailing slashes (no double slash)", () => {
    expect(appendCommandPath("https://callback.example.com/cb/")).toBe(
      "https://callback.example.com/cb/command",
    );
    expect(appendCommandPath("https://callback.example.com/cb//")).toBe(
      "https://callback.example.com/cb/command",
    );
  });
});

describe("desiredMattermostCommands", () => {
  it("namespaces the canonical command surface with the default prefix", () => {
    const triggers = desiredMattermostCommands().map((c) => c.trigger);
    expect(triggers).toEqual([
      "pwragent_resume",
      "pwragent_status",
      "pwragent_detach",
      "pwragent_monitor",
      "pwragent_help",
    ]);
  });

  it("uses bare triggers when prefix is empty", () => {
    const triggers = desiredMattermostCommands("").map((c) => c.trigger);
    expect(triggers).toEqual(["resume", "status", "detach", "monitor", "help"]);
  });

  it("supports custom prefixes", () => {
    const triggers = desiredMattermostCommands("agent.").map((c) => c.trigger);
    expect(triggers).toEqual([
      "agent.resume",
      "agent.status",
      "agent.detach",
      "agent.monitor",
      "agent.help",
    ]);
  });
});

describe("sanitizeMattermostCommandPrefix", () => {
  it("returns the default when input is undefined", () => {
    expect(sanitizeMattermostCommandPrefix(undefined)).toBe(
      DEFAULT_MATTERMOST_COMMAND_PREFIX,
    );
  });

  it("preserves a valid custom prefix", () => {
    expect(sanitizeMattermostCommandPrefix("agent_")).toBe("agent_");
    expect(sanitizeMattermostCommandPrefix("PwrAgent-")).toBe("PwrAgent-");
  });

  it("allows empty string for bare triggers", () => {
    expect(sanitizeMattermostCommandPrefix("")).toBe("");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeMattermostCommandPrefix("  pwragent_  ")).toBe("pwragent_");
  });

  it("falls back to default with a warning when chars are invalid", () => {
    const logged: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
    const result = sanitizeMattermostCommandPrefix("bad prefix!", (msg, extra) =>
      logged.push({ msg, extra }),
    );
    expect(result).toBe(DEFAULT_MATTERMOST_COMMAND_PREFIX);
    expect(logged).toHaveLength(1);
  });

  it("rejects prefixes that would make the trigger start with /", () => {
    expect(sanitizeMattermostCommandPrefix("/leading-slash")).toBe(
      DEFAULT_MATTERMOST_COMMAND_PREFIX,
    );
  });
});

describe("baseTriggerForPrefixed", () => {
  it("recovers the canonical base from a namespaced trigger", () => {
    expect(baseTriggerForPrefixed("/pwragent_resume", "pwragent_")).toBe("resume");
    expect(baseTriggerForPrefixed("/pwragent_status", "pwragent_")).toBe("status");
    expect(baseTriggerForPrefixed("/pwragent_monitor", "pwragent_")).toBe("monitor");
  });

  it("handles bare triggers when prefix is empty", () => {
    expect(baseTriggerForPrefixed("/resume", "")).toBe("resume");
  });

  it("returns undefined for unknown commands", () => {
    expect(baseTriggerForPrefixed("/pwragent_weather", "pwragent_")).toBeUndefined();
  });

  it("is case-insensitive for trigger lookup", () => {
    expect(baseTriggerForPrefixed("/PwrAgent_Resume", "pwragent_")).toBe("resume");
  });
});

describe("reconcileMattermostCommands", () => {
  it("creates all desired commands when team has none", async () => {
    const { api, state, calls } = fakeApi([]);
    const result = await reconcileMattermostCommands({
      api,
      teamId: TEAM_ID,
      callbackBaseUrl: BASE_URL,
      desired: SPECS,
    });
    expect(result.created).toEqual(["resume", "status"]);
    expect(result.updated).toEqual([]);
    expect(result.tokensByTrigger.size).toBe(2);
    expect(calls.add).toBe(2);
    expect(state).toHaveLength(2);
  });

  it("leaves matching commands untouched and caches their tokens", async () => {
    const initial = SPECS.map((spec) => existingFor(spec));
    const { api, calls } = fakeApi(initial);
    const result = await reconcileMattermostCommands({
      api,
      teamId: TEAM_ID,
      callbackBaseUrl: BASE_URL,
      desired: SPECS,
    });
    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(calls.add).toBe(0);
    expect(calls.edit).toBe(0);
    expect(result.tokensByTrigger.get("resume")).toBe("token-resume");
    expect(result.tokensByTrigger.get("status")).toBe("token-status");
  });

  it("edits commands whose URL drifted (e.g. operator changed callback base URL)", async () => {
    const initial = SPECS.map((spec) =>
      existingFor(spec, { url: "https://stale.example.com/cb/command" }),
    );
    const { api, state, calls } = fakeApi(initial);
    const result = await reconcileMattermostCommands({
      api,
      teamId: TEAM_ID,
      callbackBaseUrl: BASE_URL,
      desired: SPECS,
    });
    expect(result.updated).toEqual(["resume", "status"]);
    expect(calls.edit).toBe(2);
    expect(state[0].url).toBe(`${BASE_URL}/command`);
    expect(state[1].url).toBe(`${BASE_URL}/command`);
  });

  it("does not delete commands whose triggers are outside the desired set", async () => {
    // Bot may share the team with other integrations — we should not
    // sweep commands we don't own.
    const initial: MattermostCommandRecord[] = [
      existingFor(SPECS[0]),
      {
        id: "third-party-cmd",
        token: "third-party-token",
        team_id: TEAM_ID,
        trigger: "weather",
        url: "https://weather-bot.example.com/command",
        method: "P",
        display_name: "Weather",
        description: "Get the weather.",
        auto_complete: true,
        auto_complete_desc: "Get the weather.",
        auto_complete_hint: "[city]",
      },
    ];
    const { api, state, calls } = fakeApi(initial);
    await reconcileMattermostCommands({
      api,
      teamId: TEAM_ID,
      callbackBaseUrl: BASE_URL,
      desired: SPECS,
    });
    expect(calls.delete).toBe(0);
    expect(state.find((c) => c.trigger === "weather")).toBeDefined();
  });

  it("logs and skips per-command failures without aborting reconciliation", async () => {
    const { api: workingApi } = fakeApi([]);
    const failingApi: MattermostCommandsApi = {
      ...workingApi,
      async addCommand(cmd) {
        if (cmd.trigger === "resume") {
          throw new Error("missing manage_slash_commands permission");
        }
        return workingApi.addCommand(cmd);
      },
    };
    const logged: string[] = [];
    const result = await reconcileMattermostCommands({
      api: failingApi,
      teamId: TEAM_ID,
      callbackBaseUrl: BASE_URL,
      desired: SPECS,
      log: (msg) => logged.push(msg),
    });
    expect(result.created).toEqual(["status"]); // resume failed
    expect(logged).toContain("mattermost commands: create failed");
  });

  it("returns empty token map when listing fails (e.g. no permission)", async () => {
    const failingApi: MattermostCommandsApi = {
      async getCustomTeamCommands() {
        throw new Error("403 forbidden");
      },
      async addCommand() {
        throw new Error("never reached");
      },
      async editCommand() {
        throw new Error("never reached");
      },
      async deleteCommand() {
        throw new Error("never reached");
      },
    };
    const result = await reconcileMattermostCommands({
      api: failingApi,
      teamId: TEAM_ID,
      callbackBaseUrl: BASE_URL,
      desired: SPECS,
    });
    expect(result.tokensByTrigger.size).toBe(0);
    expect(result.created).toEqual([]);
  });
});
