import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import * as domains from "../settings/config-store/config-domains";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { readProfileConfigFile } from "../settings/config-store/profile-config-file";
import * as toml from "../settings/toml-editor";

const acknowledged = '[general.messaging_acknowledgment]\nacknowledged_at = "2026-01-01T00:00:00Z"\n';
const quiet = '[messaging]\ntool_update_mode = "show_none"\n';
const loud = '[messaging]\ntool_update_mode = "show_all"\n';
const disabledMcp = "[mcp_connections]\npwrgit_enabled = false\n";
const malformed = "[broken\n";
const strictOnly = '[research.harness]\ncommand = { unsupported = true }\n';
const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-config-reads-"));
  cleanups.push(() => fs.rmSync(dir, { force: true, recursive: true }));
  const configPath = path.join(dir, "config.toml");
  fs.writeFileSync(configPath, text);
  return configPath;
}

it("reconciles an unchanged watcher event and checks saved messaging settings without another parse", () => {
  const configPath = fixture(quiet + acknowledged);
  const parse = vi.spyOn(toml, "parseTomlTables");
  let notify: (() => void) | undefined;
  const store = new DesktopConfigStore({
    configPath,
    createFileWatcher: ({ onChange }) => {
      notify = onChange;
      return { close: () => undefined };
    },
  });
  try {
    store.startWatching();
    notify!();
    expect(store.readSavedDevelopmentWorkingUpdatesMode()).toBe("show_none");
    expect(() => store.requireSavedMessagingSafetyAcknowledgment()).not.toThrow();
    expect(parse.mock.calls.length).toBe(1);
  } finally {
    store.dispose();
  }
});

it("shares the saved profile parse with bootstrap readers and gives each caller its own result", () => {
  const configPath = fixture(quiet);
  const parse = vi.spyOn(toml, "parseTomlTables");
  const first = readProfileConfigFile(configPath);
  first.messaging!.toolUpdateMode = "show_all";
  expect(readProfileConfigFile(configPath).messaging?.toolUpdateMode).toBe("show_none");
  expect(parse.mock.calls.length).toBe(1);
});

it("reads a config without an MCP section once per lookup and shares the parse across list and get", () => {
  const configPath = fixture(quiet);
  const read = vi.spyOn(fs, "readFileSync");
  const parse = vi.spyOn(toml, "parseTomlTables");
  const registry = new McpConnectionRegistry({ configPath });
  expect(registry.list().find(({ id }) => id === "pwrgit")?.enabled).toBe(true);
  expect(registry.get("pwrgit")?.enabled).toBe(true);
  expect(read.mock.calls.filter(([file]) => file === configPath).length).toBe(2);
  expect(parse.mock.calls.length).toBe(1);
});

it("uses the published domains after a no-op Settings save", async () => {
  const configPath = fixture(quiet);
  const store = new DesktopConfigStore({ configPath });
  const normalize = vi.spyOn(domains, "normalizeConfigDomains");
  try {
    await expect(store.write({ messaging: { toolUpdateMode: "show_none" } }, ["messaging"]))
      .resolves.toMatchObject({ changedDomains: [], values: { messaging: { toolUpdateMode: "show_none" } } });
    expect(normalize.mock.calls.length).toBe(0);
  } finally {
    store.dispose();
  }
});

it("sees a same-size, same-mtime peer replacement and the next local MCP Settings write", () => {
  const configPath = fixture("[mcp_connections]\npwrgit_enabled = true \n");
  const timestamp = new Date("2026-01-01T00:00:00Z");
  fs.utimesSync(configPath, timestamp, timestamp);
  const { size, mtimeMs } = fs.statSync(configPath);
  const registry = new McpConnectionRegistry({ configPath });
  const parse = vi.spyOn(toml, "parseTomlTables");
  expect(registry.get("pwrgit")?.enabled).toBe(true);

  const peer = `${configPath}.peer`;
  fs.writeFileSync(peer, disabledMcp);
  fs.utimesSync(peer, timestamp, timestamp);
  fs.renameSync(peer, configPath);
  expect(fs.statSync(configPath)).toMatchObject({ size, mtimeMs });
  expect(registry.get("pwrgit")?.enabled).toBe(false);
  expect(registry.list().find(({ id }) => id === "pwrgit")?.enabled).toBe(false);
  expect(parse.mock.calls.length).toBe(2);

  expect(registry.setEnabled("pwrgit", true).enabled).toBe(true);
  expect(registry.get("pwrgit")?.enabled).toBe(true);
  expect(parse.mock.calls.length).toBe(3);
});

it("reports unchanged malformed MCP settings on every lookup with one parse", () => {
  const configPath = fixture(malformed);
  const parse = vi.spyOn(toml, "parseTomlTables");
  const registry = new McpConnectionRegistry({ configPath });
  expect(() => registry.list()).toThrow("Invalid TOML");
  expect(() => registry.get("pwrgit")).toThrow("Invalid TOML");
  expect(parse.mock.calls.length).toBe(1);
});

const revisions = [
  { text: quiet + acknowledged, mode: "show_none", ack: true, gitEnabled: true },
  { text: loud + disabledMcp, mode: "show_all", ack: false, gitEnabled: false },
  { text: "", mode: undefined, ack: false, gitEnabled: true },
  { text: malformed, mode: undefined, ack: false, gitEnabled: true, invalid: "syntax" },
  { text: strictOnly + disabledMcp, mode: undefined, ack: false, gitEnabled: false, invalid: "strict" },
  { text: undefined, mode: undefined, ack: false, gitEnabled: true },
] as const;

const action = fc.oneof(
  fc.record({ kind: fc.constant("replace" as const), revision: fc.integer({ min: 0, max: revisions.length - 1 }) }),
  fc.constantFrom("watch", "saved-mode", "ack", "profile", "mcp-list", "mcp-get").map((kind) => ({ kind })),
);

it("agrees with a fresh-file model across passive reads, watch events, and peer replacements", () => {
  const readFile = fs.readFileSync;
  const exists = fs.existsSync;
  let run = 0;
  let reads = 0;
  let configPath = "";
  let revision: (typeof revisions)[number] = revisions[5];
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(fs, "existsSync").mockImplementation((file) =>
    file === configPath ? revision.text !== undefined : exists(file),
  );
  vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
    if (file !== configPath) return readFile(file, options);
    reads++;
    if (revision.text === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return revision.text;
  });
  const parse = vi.spyOn(toml, "parseTomlTables");
  fc.assert(fc.property(fc.array(action, { minLength: 1, maxLength: 24, size: "max" }), (actions) => {
    configPath = path.join(os.tmpdir(), `pwragent-config-reads-model-${run++}`, "config.toml");
    revision = revisions[5];
    const store = new DesktopConfigStore({ configPath });
    const registry = new McpConnectionRegistry({ configPath });
    let published: (typeof revisions)[number] = revision;
    let canonicalText: string | undefined;
    let mcpText: string | undefined;
    for (const step of actions) {
      if (step.kind === "replace") {
        revision = revisions[step.revision];
        continue;
      }
      parse.mockClear();
      reads = 0;
      if (step.kind === "mcp-list" || step.kind === "mcp-get") {
        const lookup = () => step.kind === "mcp-get"
          ? registry.get("pwrgit") : registry.list().find(({ id }) => id === "pwrgit");
        if ("invalid" in revision && revision.invalid === "syntax") {
          expect(lookup).toThrow("Invalid TOML");
        } else {
          expect(lookup()?.enabled).toBe(revision.gitEnabled);
        }
        expect(parse.mock.calls.length).toBe(Number(revision.text !== undefined && revision.text !== mcpText));
        mcpText = revision.text;
        expect(reads).toBe(Number(revision.text !== undefined));
        continue;
      }
      const valid = !("invalid" in revision);
      switch (step.kind) {
        case "watch":
          store.reloadFromDisk("watch");
          if (valid) published = revision;
          expect(store.fileStatus().kind).toBe(!valid ? "invalid" : revision.text === undefined ? "missing" : "valid");
          expect(store.read("messaging").toolUpdateMode).toBe(published.mode);
          break;
        case "saved-mode":
          if (valid) expect(store.readSavedDevelopmentWorkingUpdatesMode()).toBe(revision.mode);
          else expect(() => store.readSavedDevelopmentWorkingUpdatesMode()).toThrow("Cannot read settings");
          break;
        case "ack":
          if (revision.ack) expect(() => store.requireSavedMessagingSafetyAcknowledgment()).not.toThrow();
          else expect(() => store.requireSavedMessagingSafetyAcknowledgment()).toThrow("acknowledge");
          break;
        case "profile":
          if (valid) expect(readProfileConfigFile(configPath).messaging?.toolUpdateMode).toBe(revision.mode);
          else expect(() => readProfileConfigFile(configPath)).toThrow(/Invalid TOML|Unsupported TOML/);
          break;
      }
      expect(parse.mock.calls.length).toBe(Number(revision.text !== undefined && revision.text !== canonicalText));
      expect(reads).toBe(Number(step.kind !== "profile" || revision.text !== undefined));
      canonicalText = revision.text;
    }
    store.dispose();
  }));
});
