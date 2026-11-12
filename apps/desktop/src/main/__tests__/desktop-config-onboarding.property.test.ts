import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDesktopSettingsPatch,
  readDesktopSettingsConfig,
} from "../settings/desktop-config";

// The Outpost (`owner-services.ts`) writes `{ onboarding: { completed: true } }`
// on every boot. A profile whose config.toml has no `completed` key used to
// get the key appended twice, which is invalid TOML for any strict reader.

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-onboarding-"));
  configPath = path.join(dir, "config.toml");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Count `completed = …` lines inside the first `[onboarding]` table. */
function countOnboardingKey(text: string, key: string): number {
  let inOnboarding = false;
  let count = 0;
  for (const line of text.split("\n")) {
    const header = /^\s*\[\s*([^[\]]+?)\s*\]\s*(#.*)?$/.exec(line);
    if (header) {
      inOnboarding = header[1] === "onboarding";
      continue;
    }
    if (inOnboarding && new RegExp(`^\\s*${key}\\s*=`).test(line)) {
      count += 1;
    }
  }
  return count;
}

describe("onboarding completed writes", () => {
  it("writes the key once when the table exists without it (Outpost boot)", () => {
    fs.writeFileSync(configPath, "[onboarding]\n", "utf8");

    applyDesktopSettingsPatch(configPath, { onboarding: { completed: true } });
    applyDesktopSettingsPatch(configPath, { onboarding: { completed: true } });

    const text = fs.readFileSync(configPath, "utf8");
    expect(countOnboardingKey(text, "completed")).toBe(1);
    expect(readDesktopSettingsConfig(configPath).onboarding?.completed).toBe(true);
  });

  it("writes the key once into a config with no onboarding table", () => {
    fs.writeFileSync(configPath, "[general]\ndeveloper_mode = true\n", "utf8");

    applyDesktopSettingsPatch(configPath, { onboarding: { completed: true } });

    const text = fs.readFileSync(configPath, "utf8");
    expect(countOnboardingKey(text, "completed")).toBe(1);
  });

  it("reads an existing duplicate and repairs it on the next onboarding write", () => {
    const damaged = [
      "# operator note",
      "[onboarding]",
      "completed = true",
      "completed = true",
      "",
      "[general]",
      "developer_mode = true # keep me",
      "",
    ].join("\n");
    fs.writeFileSync(configPath, damaged, "utf8");

    expect(readDesktopSettingsConfig(configPath).onboarding?.completed).toBe(true);

    applyDesktopSettingsPatch(configPath, { onboarding: { completed: true } });

    expect(fs.readFileSync(configPath, "utf8")).toBe([
      "# operator note",
      "[onboarding]",
      "completed = true",
      "",
      "[general]",
      "developer_mode = true # keep me",
      "",
    ].join("\n"));
  });

  it("keeps an explicit false marker distinct from an absent key", () => {
    fs.writeFileSync(configPath, "[onboarding]\ncompleted = true\n", "utf8");

    applyDesktopSettingsPatch(configPath, { onboarding: { completed: false } });

    expect(readDesktopSettingsConfig(configPath).onboarding?.completed).toBe(false);
  });
});

const initialConfig = fc.record({
  header: fc.constantFrom("", "# operator comment\n"),
  table: fc.constantFrom("absent", "empty", "other-key"),
  existing: fc.array(fc.boolean(), { maxLength: 3 }),
  trailer: fc.constantFrom("", "\n[general]\ndeveloper_mode = true # keep\n"),
});

type InitialConfig = typeof initialConfig extends fc.Arbitrary<infer T> ? T : never;

function renderInitial(config: InitialConfig): string {
  if (config.table === "absent") return config.header + config.trailer;
  const lines = ["[onboarding]"];
  if (config.table === "other-key") lines.push('completed_source = "wizard"');
  for (const value of config.existing) lines.push(`completed = ${value}`);
  return `${config.header}${lines.join("\n")}\n${config.trailer}`;
}

const onboardingPatch = fc.record(
  {
    completed: fc.boolean(),
    completedSource: fc.constantFrom("wizard", "migrated"),
  },
  { requiredKeys: [] },
);

describe("onboarding writes (property)", () => {
  it("any sequence of onboarding writes leaves at most one key per name, and exactly one completed once written", () => {
    fc.assert(
      fc.property(
        initialConfig,
        fc.array(onboardingPatch, { minLength: 1, maxLength: 6 }),
        (initial, patches) => {
          const source = renderInitial(initial);
          fs.writeFileSync(configPath, source, "utf8");
          let lastCompleted: boolean | undefined;
          for (const patch of patches) {
            applyDesktopSettingsPatch(configPath, {
              onboarding: patch as { completed?: boolean; completedSource?: "wizard" | "migrated" },
            });
            if (patch.completed !== undefined) lastCompleted = patch.completed;
          }
          const text = fs.readFileSync(configPath, "utf8");
          if (lastCompleted !== undefined) {
            expect(countOnboardingKey(text, "completed")).toBe(1);
            expect(readDesktopSettingsConfig(configPath).onboarding?.completed)
              .toBe(lastCompleted);
          }
          expect(countOnboardingKey(text, "completed_source")).toBeLessThanOrEqual(1);
          if (initial.header) expect(text.startsWith(initial.header)).toBe(true);
          if (initial.trailer) expect(text).toContain("developer_mode = true # keep");
        },
      ),
      { numRuns: 300 },
    );
  });
});
