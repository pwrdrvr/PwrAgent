import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MATHOS_PLATFORM_API_KEY_ENV,
  normalizeResearchHarnessConfig,
  researchHarnessArgsFromLines,
  type ResearchHarnessConfig,
} from "@pwragent/shared/research-harness";
import { desktopSettingsPatchToEdits, parseDesktopSettingsToml } from "../settings/desktop-config";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";
import { researchHarnessEnvironment } from "../research/research-harness-process";
import { assertModelRequestOmitsPlatformKey } from "../research/research-runtime";

// `DesktopSettingsService` builds a real `CodexDiscoveryCoordinator` unless the
// test injects one; keep its probe off this machine's Codex installs.
vi.mock("@pwrdrvr/codex-discovery", async (importOriginal) => {
  const { stubbedCodexDiscovery } = await import("./helpers/codex-discovery-stub");
  return stubbedCodexDiscovery(await importOriginal<typeof import("@pwrdrvr/codex-discovery")>());
});

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Files the operator may already have. Settings must leave their comments and
 * other keys alone, including keys inside `[research.harness]` it does not own.
 */
const BASES = [
  "",
  "# operator notes stay\n[general]\ndeveloper_mode = true\n\n[experimental]\nresearch_enabled = true\n",
  "[research.harness]\n# hand-written bridge\ncommand = \"/opt/old/bridge\"\nargs = [\"--old\"]\napi_key_env = \"OLD_MODEL_KEY\"\nnote = \"kept\"\n\n[general]\ndeveloper_mode = true\n",
];

const segment = fc.stringMatching(/^[A-Za-z0-9._ -]{1,12}$/);
const command = fc.oneof(
  fc.array(segment, { minLength: 1, maxLength: 4 }).map((parts) => `/${parts.join("/")}`),
  fc.array(segment, { minLength: 1, maxLength: 3 }).map((parts) => `C:\\${parts.join("\\")}`),
).filter((value) => value.trim() === value);
// Printable text, including quotes, backslashes, `#`, `=`, brackets and non-ASCII.
const printable = fc.string({ unit: fc.oneof(fc.constantFrom("\"", "\\", "#", "=", "[", "]", "'", " ", "é", "∑"), fc.string({ unit: "grapheme", minLength: 1, maxLength: 1 })), maxLength: 24 })
  // eslint-disable-next-line no-control-regex -- control characters are tested separately.
  .filter((value) => !/[\u0000-\u001f\u007f]/.test(value));
// What a hand-edited file may hold and the TOML writer escapes: tab, newline, carriage return.
const escapable = fc.string({ unit: fc.oneof(fc.constantFrom("\t", "\n", "\r"), fc.string({ unit: "grapheme", minLength: 1, maxLength: 1 })), maxLength: 24 })
  // eslint-disable-next-line no-control-regex -- only the characters the writer cannot escape are excluded.
  .filter((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
const harness: fc.Arbitrary<ResearchHarnessConfig> = fc.record({
  command,
  args: fc.array(fc.oneof(printable, escapable), { maxLength: 6 }),
  endpoint: fc.option(fc.oneof(
    fc.constantFrom("https://models.example.test/v1/chat/completions", "http://127.0.0.1:8080/v1/chat/completions", "http://localhost/v1"),
    segment.map((part) => `https://${part.replace(/[^A-Za-z0-9]/g, "") || "host"}.example.test/v1`),
  ), { nil: undefined }),
  model: fc.option(printable.filter((value) => value.trim().length > 0), { nil: undefined }),
  apiKeyEnv: fc.option(fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,20}$/).filter((name) => name !== MATHOS_PLATFORM_API_KEY_ENV), { nil: undefined }),
}, { requiredKeys: ["command", "args"] });

type Op = { kind: "save"; value: ResearchHarnessConfig } | { kind: "remove" };
const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: harness.map((value) => ({ kind: "save" as const, value })) },
  { weight: 1, arbitrary: fc.constant({ kind: "remove" as const }) },
);

function write(text: string, patch: Parameters<typeof desktopSettingsPatchToEdits>[0]): string {
  return applyTomlEdits(text, desktopSettingsPatchToEdits(patch, parseTomlTables(text, "config.toml")));
}

function expected(value: ResearchHarnessConfig): ResearchHarnessConfig {
  const normalized = normalizeResearchHarnessConfig(value);
  if (!normalized.ok) throw new Error(`generator produced an invalid config: ${normalized.error}`);
  return normalized.value;
}

describe("[research.harness] written by Settings", () => {
  it("reads back exactly what was last saved, and nothing after Remove bridge, across any sequence", () => {
    fc.assert(fc.property(fc.constantFrom(...BASES), fc.array(op, { minLength: 1, maxLength: 6 }), (base, ops) => {
      // The model: the last save, or nothing after a remove.
      let model: ResearchHarnessConfig | undefined;
      let text = base;
      for (const next of ops) {
        if (next.kind === "save") {
          text = write(text, { research: { harness: next.value } });
          model = expected(next.value);
        } else {
          text = write(text, { research: { harness: null } });
          model = undefined;
        }
        const parsed = parseDesktopSettingsToml(text, "config.toml");
        // Optional keys left blank are absent, never empty strings.
        expect(parsed.research?.harness).toEqual(model);
        // Unrelated settings and comments are untouched by any save or removal.
        if (base.includes("developer_mode")) expect(parsed.general?.developerMode).toBe(true);
        if (base.includes("research_enabled")) expect(parsed.experimental?.researchEnabled).toBe(true);
        for (const line of base.split("\n").filter((entry) => entry.startsWith("#") || entry.startsWith("note ="))) {
          expect(text).toContain(line);
        }
      }
    }), { numRuns: 300 });
  });

  it("refuses an invalid value before writing anything", () => {
    const invalid = fc.oneof(
      fc.constant<ResearchHarnessConfig>({ command: "relative/bridge", args: [] }),
      fc.constant<ResearchHarnessConfig>({ command: "/bin/bridge", args: ["bad\u0001arg"] }),
      fc.constant<ResearchHarnessConfig>({ command: "/bin/bridge", args: ["bad\u000barg"] }),
      fc.constant<ResearchHarnessConfig>({ command: "/bin/bridge", args: [], model: "bad\u007fmodel" }),
      fc.constant<ResearchHarnessConfig>({ command: "/bin/bridge", args: [], endpoint: "http://models.example.test/v1" }),
      fc.constant<ResearchHarnessConfig>({ command: "/bin/bridge", args: [], endpoint: "https://user:pass@models.example.test/v1" }),
      fc.constant<ResearchHarnessConfig>({ command: "/bin/bridge", args: [], apiKeyEnv: "not a name" }),
      fc.constant<ResearchHarnessConfig>({ command: "/bin/bridge", args: [], apiKeyEnv: MATHOS_PLATFORM_API_KEY_ENV }),
      fc.constant<ResearchHarnessConfig>({ command: "/bin/bridge", args: Array.from({ length: 65 }, () => "x") }),
    );
    fc.assert(fc.property(fc.constantFrom(...BASES), invalid, (base, value) => {
      expect(normalizeResearchHarnessConfig(value).ok).toBe(false);
      expect(() => desktopSettingsPatchToEdits({ research: { harness: value } }, parseTomlTables(base, "config.toml"))).toThrow();
    }));
  });

  it("reads a table without bridge keys as no bridge, and a table with keys but no command as invalid", () => {
    expect(parseDesktopSettingsToml("[research.harness]\n", "config.toml").research).toBeUndefined();
    // What Remove bridge leaves of a hand-written table: the operator's own keys and comments.
    expect(parseDesktopSettingsToml("[research.harness]\n# mine\nnote = \"kept\"\n", "config.toml").research).toBeUndefined();
    expect(() => parseDesktopSettingsToml("[research.harness]\nmodel = \"m\"\n", "config.toml")).toThrow(/research.harness.command/);
  });

  it("takes one argument per non-blank line", () => {
    fc.assert(fc.property(fc.array(printable.filter((value) => value.trim().length > 0), { maxLength: 8 }), fc.constantFrom("\n", "\r\n"), (args, eol) => {
      const trimmed = args.map((arg) => arg.trim());
      expect(researchHarnessArgsFromLines(`${trimmed.join(`${eol}${eol}`)}${eol}`)).toEqual(trimmed);
    }));
  });
});

describe("MathOS Platform API key", () => {
  function createService(): { service: DesktopSettingsService; configPath: string; secretStore: MemoryDesktopSecretStore } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-harness-settings-"));
    tempRoots.push(root);
    const configPath = path.join(root, "config.toml");
    const secretStore = new MemoryDesktopSecretStore();
    return { service: new DesktopSettingsService({ configPath, env: {}, secretStore }), configPath, secretStore };
  }

  const key = fc.stringMatching(/^[A-Za-z0-9_-]{16,48}$/).map((body) => `mathos_${body}`);

  it("round-trips through the encrypted store and never reaches the snapshot or config.toml", async () => {
    await fc.assert(fc.asyncProperty(key, harness, async (secret, bridge) => {
      const { service, configPath } = createService();
      await service.writeConfigPatchTargeted({ research: { harness: bridge } });
      const stored = await service.replaceSecret("mathosPlatformApiKey", secret);
      expect(stored.configured).toBe(true);
      const snapshot = await service.readSettingsProjection();
      expect(snapshot.research?.platformApiKey.configured).toBe(true);
      expect(snapshot.research?.harness).toEqual(expected(bridge));
      // Presence only: the value is in neither the window's snapshot nor the file.
      expect(JSON.stringify(snapshot)).not.toContain(secret);
      expect(fs.readFileSync(configPath, "utf8")).not.toContain(secret);
      // Only the owner's bridge launch reads it back.
      expect(service.resolveMathosPlatformApiKeySync()).toBe(secret);
      expect(await service.hasMathosPlatformApiKey()).toBe(true);
      const cleared = await service.clearSecret("mathosPlatformApiKey");
      expect(cleared.configured).toBe(false);
      expect(service.resolveMathosPlatformApiKeySync()).toBeUndefined();
      expect(await service.hasMathosPlatformApiKey()).toBe(false);
      expect((await service.readSettingsProjection()).research?.platformApiKey.configured).toBe(false);
    }), { numRuns: 15 });
  });

  it("reaches the bridge's environment and nothing else from the parent", () => {
    const parentKey = fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,12}$/);
    fc.assert(fc.property(fc.dictionary(parentKey, fc.string({ minLength: 1, maxLength: 8 })), fc.option(key, { nil: undefined }), (parent, secret) => {
      const env = researchHarnessEnvironment({ ...parent, OPENAI_API_KEY: "model-secret", MODEL_KEY: "model-secret" }, secret);
      const allowed = new Set(["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP", MATHOS_PLATFORM_API_KEY_ENV]);
      for (const name of Object.keys(env)) expect(allowed.has(name)).toBe(true);
      expect(Object.values(env)).not.toContain("model-secret");
      expect(env[MATHOS_PLATFORM_API_KEY_ENV]).toBe(secret);
    }));
  });

  it("refuses a model request that carries the Platform key verbatim, whatever JSON escapes in it", () => {
    const awkward = fc.tuple(key, fc.constantFrom("\\", "\"", "\n", "\u2028")).map(([base, extra]) => `${base}${extra}tail`);
    fc.assert(fc.property(awkward, fc.constantFrom("content", "nested"), (secret, shape) => {
      const messages = shape === "content"
        ? [{ role: "user", content: `before ${secret} after` }]
        : [{ role: "user", content: [{ type: "text", text: secret }] }];
      expect(() => assertModelRequestOmitsPlatformKey(messages, secret)).toThrow(/MathOS Platform key/);
    }));
  });

  it("refuses a model request that carries the Platform key", () => {
    fc.assert(fc.property(key, fc.array(fc.string({ maxLength: 40 }), { maxLength: 4 }), fc.boolean(), (secret, texts, leak) => {
      const messages = texts.map((content) => ({ role: "user", content }));
      if (leak) messages.push({ role: "user", content: `here: ${secret}` });
      const leaked = JSON.stringify(messages).includes(secret);
      if (leaked) expect(() => assertModelRequestOmitsPlatformKey(messages, secret)).toThrow(/MathOS Platform key/);
      else expect(() => assertModelRequestOmitsPlatformKey(messages, secret)).not.toThrow();
      // No stored key: nothing to compare.
      expect(() => assertModelRequestOmitsPlatformKey(messages, undefined)).not.toThrow();
    }));
  });
});
