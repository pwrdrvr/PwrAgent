import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listModelSettingsRecents,
  recordModelSettingsRecent,
} from "../state/model-settings-recents-store.js";
import { StateDb } from "../state/state-db.js";

describe("model settings recents store", () => {
  let root: string;
  let stateDb: StateDb;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "pwragent-recents-"));
    stateDb = StateDb.open(path.join(root, "state.db"), {
      profileName: "dev",
    });
  });

  afterEach(() => {
    stateDb.close();
    rmSync(root, { force: true, recursive: true });
  });

  it("starts empty", () => {
    expect(listModelSettingsRecents(stateDb, "review")).toEqual([]);
  });

  it("returns most recent first", () => {
    recordModelSettingsRecent(stateDb, "review", {
      backend: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    recordModelSettingsRecent(stateDb, "review", {
      backend: "acp:grok",
      model: "grok-4",
      reasoningEffort: "high",
    });

    expect(listModelSettingsRecents(stateDb, "review")).toEqual([
      { backend: "acp:grok", model: "grok-4", reasoningEffort: "high" },
      { backend: "codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
    ]);
  });

  it("bumps a repeated combination to the front instead of duplicating it", () => {
    const codex = {
      backend: "codex" as const,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    };
    recordModelSettingsRecent(stateDb, "review", codex);
    recordModelSettingsRecent(stateDb, "review", {
      backend: "acp:kimi",
      model: "kimi-k2-thinking",
    });
    recordModelSettingsRecent(stateDb, "review", codex);

    const listed = listModelSettingsRecents(stateDb, "review");
    expect(listed).toHaveLength(2);
    expect(listed[0]).toEqual(codex);
  });

  it("treats a differing reasoning effort as a distinct combination", () => {
    recordModelSettingsRecent(stateDb, "review", {
      backend: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    recordModelSettingsRecent(stateDb, "review", {
      backend: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
    });

    expect(listModelSettingsRecents(stateDb, "review")).toHaveLength(2);
  });

  it("caps the list at ten per scope", () => {
    for (let index = 0; index < 14; index += 1) {
      recordModelSettingsRecent(stateDb, "review", {
        backend: "codex",
        model: `model-${index}`,
      });
    }

    const listed = listModelSettingsRecents(stateDb, "review");
    expect(listed).toHaveLength(10);
    expect(listed[0]?.model).toBe("model-13");
    expect(listed[9]?.model).toBe("model-4");
  });

  it("keeps scopes independent", () => {
    recordModelSettingsRecent(stateDb, "review", {
      backend: "codex",
      model: "gpt-5.6-sol",
    });
    recordModelSettingsRecent(stateDb, "composer", {
      backend: "acp:kimi",
      model: "kimi-k2-thinking",
    });

    expect(listModelSettingsRecents(stateDb, "review")).toEqual([
      { backend: "codex", model: "gpt-5.6-sol" },
    ]);
    expect(listModelSettingsRecents(stateDb, "composer")).toEqual([
      { backend: "acp:kimi", model: "kimi-k2-thinking" },
    ]);
  });

  it("ignores an entry with no backend", () => {
    recordModelSettingsRecent(stateDb, "review", {
      model: "gpt-5.6-sol",
    } as never);

    expect(listModelSettingsRecents(stateDb, "review")).toEqual([]);
  });

  it("self-heals from a corrupt persisted value", () => {
    stateDb.setMeta("modelSettingsRecents", "{not json");

    expect(listModelSettingsRecents(stateDb, "review")).toEqual([]);

    recordModelSettingsRecent(stateDb, "review", {
      backend: "codex",
      model: "gpt-5.6-sol",
    });
    expect(listModelSettingsRecents(stateDb, "review")).toEqual([
      { backend: "codex", model: "gpt-5.6-sol" },
    ]);
  });
});
