import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MATHOS_API_KEY,
  MATHOS_PLATFORM_DEFAULT_ORIGIN,
  normalizeMathosPlatformOrigin,
  normalizeResearchHarnessConfig,
  resolveResearchHarnessSource,
  type ResearchHarnessConfig,
  type ResearchHarnessSource,
  type ResearchMathosConfig,
} from "@pwragent/shared/research-harness";
import { desktopSettingsPatchToEdits, parseDesktopSettingsToml } from "../settings/desktop-config";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";

vi.mock("@pwrdrvr/codex-discovery", async (importOriginal) => {
  const { stubbedCodexDiscovery } = await import("./helpers/codex-discovery-stub");
  return stubbedCodexDiscovery(await importOriginal<typeof import("@pwrdrvr/codex-discovery")>());
});

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const BASES = [
  "",
  "# header comment\n[general]\ndeveloper_mode = true",
  "# CRLF file\r\n[general]\r\ndeveloper_mode = true\r\n\r\n[research.harness]\r\n# keep\r\ncommand = \"/opt/old/bridge\"\r\nargs = [\r\n  \"--one\",\r\n  \"--two\",\r\n]\r\nextra = \"keep\"\r\n",
  "[research]\nharness_source = \"unknown-future-source\"\nkeep_key = 42\n\n[research.mathos]\nteam = 123\norigin = true\nother = \"stay\"\n",
  "[research.harness]\ncommand = \"/opt/a\"\ncommand = \"/opt/b\"\nargs = [\"--x\"]\n",
];

const segmentArb = fc.stringMatching(/^[A-Za-z0-9._-]{1,10}$/);
const trickyTextArb = fc
  .string({
    unit: fc.oneof(
      fc.constantFrom('"', "\\", "#", "=", "[", "]", "'", " ", "\t", "\n", "\r", "é", "∑"),
      fc.string({ unit: "grapheme", minLength: 1, maxLength: 1 }),
    ),
    minLength: 1,
    maxLength: 20,
  })
  // eslint-disable-next-line no-control-regex -- exclude control characters disallowed by normalizeResearchHarnessConfig.
  .filter((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) && v.trim().length > 0);

const commandArb = fc.oneof(
  fc.array(segmentArb, { minLength: 1, maxLength: 3 }).map((p) => `/${p.join("/")}`),
  fc.array(segmentArb, { minLength: 1, maxLength: 3 }).map((p) => `C:\\${p.join("\\")}`),
  fc.array(segmentArb, { minLength: 2, maxLength: 3 }).map((p) => `\\\\${p.join("\\")}`),
  segmentArb.map((p) => `/opt/${p} with space/bridge`),
  segmentArb.map((p) => `/opt/${p}#hash/bridge`),
);

const endpointArb = fc.option(
  fc.oneof(
    fc.constantFrom(
      "https://models.example.test/v1/chat/completions",
      "http://127.0.0.1:8080/v1/chat/completions",
      "http://localhost:3000/v1",
      "http://[::1]:8080/v1",
      "https://models.example.test/v1/a\nb",
      "https://models.example.test/v1/a\u0001b",
    ),
    segmentArb.map((s) => `https://${s.replace(/[^A-Za-z0-9]/g, "") || "h"}.example.test/v1`),
  ),
  { nil: undefined },
);

const harnessArb: fc.Arbitrary<ResearchHarnessConfig> = fc.record(
  {
    command: commandArb,
    args: fc.array(fc.oneof(trickyTextArb, fc.constant("")), { maxLength: 6 }),
    endpoint: endpointArb,
    model: fc.option(trickyTextArb, { nil: undefined }),
    apiKeyEnv: fc.option(fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,20}$/), { nil: undefined }),
  },
  { requiredKeys: ["command", "args"] },
);

const teamArb = fc.uuid({ version: 4 }).map((id) => `o-${id}`);
const originArb = fc.constantFrom<string | null>(
  null,
  "",
  MATHOS_PLATFORM_DEFAULT_ORIGIN,
  "HTTPS://OS.OPENMATHMODEL.ORG/",
  "https://os.openmathmodel.org:443",
  "https://os-custom.example.test/",
  "http://127.0.0.1:9000",
  "http://localhost:9001/",
  "http://[::1]:9002",
);

type ConfigOp =
  | { kind: "save_bridge"; value: ResearchHarnessConfig }
  | { kind: "remove_bridge" }
  | { kind: "source"; value: ResearchHarnessSource }
  | { kind: "mathos"; team?: string | null; origin?: string | null }
  | { kind: "combined"; source: ResearchHarnessSource; bridge: ResearchHarnessConfig | null; team?: string | null; origin?: string | null };

const configOpArb: fc.Arbitrary<ConfigOp> = fc.oneof(
  { weight: 3, arbitrary: harnessArb.map((value) => ({ kind: "save_bridge" as const, value })) },
  { weight: 1, arbitrary: fc.constant({ kind: "remove_bridge" as const }) },
  { weight: 2, arbitrary: fc.constantFrom<ResearchHarnessSource>("mathos", "bridge").map((value) => ({ kind: "source" as const, value })) },
  { weight: 2, arbitrary: fc.record({ team: fc.option(teamArb, { nil: null }), origin: originArb }, { requiredKeys: [] }).map((v) => ({ kind: "mathos" as const, ...v })) },
  {
    weight: 2,
    arbitrary: fc.record({
      source: fc.constantFrom<ResearchHarnessSource>("mathos", "bridge"),
      bridge: fc.option(harnessArb, { nil: null }),
      team: fc.option(teamArb, { nil: null }),
      origin: originArb,
    }).map((v) => ({ kind: "combined" as const, ...v })),
  },
);

function applyMathosModel(
  current: ResearchMathosConfig | undefined,
  change: { team?: string | null; origin?: string | null },
): ResearchMathosConfig | undefined {
  const next: ResearchMathosConfig = { ...current };
  if (change.team !== undefined) {
    const trimmed = change.team?.trim();
    if (trimmed) next.team = trimmed;
    else delete next.team;
  }
  if (change.origin !== undefined) {
    const norm = normalizeMathosPlatformOrigin(change.origin ?? undefined);
    if (!norm.ok) throw new Error(norm.error);
    if (norm.origin !== MATHOS_PLATFORM_DEFAULT_ORIGIN) next.origin = norm.origin;
    else delete next.origin;
  }
  return Object.keys(next).length ? next : undefined;
}

describe("research config writer/reader and secret round-trip model", () => {
  it("round-trips [research.harness], harness_source and [research.mathos] across random edit sequences", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BASES),
        fc.array(configOpArb, { minLength: 1, maxLength: 12 }),
        (base, ops) => {
          let text = base;
          const initial = parseDesktopSettingsToml(text, "config.toml").research;
          let modelHarness: ResearchHarnessConfig | undefined = initial?.harness;
          let modelSource: ResearchHarnessSource | undefined = initial?.source;
          let modelMathos: ResearchMathosConfig | undefined = initial?.mathos;

          const apply = (patch: Parameters<typeof desktopSettingsPatchToEdits>[0]) => {
            const edits = desktopSettingsPatchToEdits(patch, parseTomlTables(text, "config.toml"));
            text = applyTomlEdits(text, edits);
          };

          for (const op of ops) {
            if (op.kind === "save_bridge") {
              const norm = normalizeResearchHarnessConfig(op.value);
              if (!norm.ok) {
                expect(() => apply({ research: { harness: op.value } })).toThrow();
                continue;
              }
              apply({ research: { harness: op.value } });
              modelHarness = norm.value;
            } else if (op.kind === "remove_bridge") {
              apply({ research: { harness: null } });
              modelHarness = undefined;
            } else if (op.kind === "source") {
              apply({ research: { source: op.value } });
              modelSource = op.value;
            } else if (op.kind === "mathos") {
              const { kind: _k, ...change } = op;
              apply({ research: { mathos: change } });
              modelMathos = applyMathosModel(modelMathos, change);
            } else {
              const norm = op.bridge ? normalizeResearchHarnessConfig(op.bridge) : undefined;
              if (norm && !norm.ok) {
                expect(() => apply({ research: { source: op.source, harness: op.bridge, mathos: { team: op.team, origin: op.origin } } })).toThrow();
                continue;
              }
              apply({ research: { source: op.source, harness: op.bridge, mathos: { team: op.team, origin: op.origin } } });
              modelSource = op.source;
              modelHarness = norm ? norm.value : undefined;
              modelMathos = applyMathosModel(modelMathos, { team: op.team, origin: op.origin });
            }

            // Written TOML MUST NOT contain raw unescaped control characters (illegal in TOML 1.0)!
            // eslint-disable-next-line no-control-regex -- verifying TOML 1.0 validity.
            expect(text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
            // Re-parsing MUST always succeed and match the model exactly!
            const parsed = parseDesktopSettingsToml(text, "config.toml");
            expect(parsed.research?.harness).toEqual(modelHarness);
            expect(parsed.research?.source).toBe(modelSource);
            expect(parsed.research?.mathos).toEqual(modelMathos);
            expect(resolveResearchHarnessSource(parsed.research)).toBe(modelSource ?? (modelHarness ? "bridge" : "mathos"));
            // Unrelated keys and comments stay intact
            if (base.includes("developer_mode")) expect(parsed.general?.developerMode).toBe(true);
            if (base.includes("keep_key = 42")) expect(text).toContain("keep_key = 42");
            if (base.includes('other = "stay"')) expect(text).toContain('other = "stay"');
            if (base.includes('extra = "keep"')) expect(text).toContain('extra = "keep"');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Shrunk counterexample from 1,000-run model (seed 1959722684):
  // normalizeResearchHarnessConfig accepted control chars in endpoint because WHATWG
  // `new URL()` silently strips \t/\n/\r and percent-encodes 0x01, writing raw illegal bytes.
  it("rejects control characters and newlines in research.harness.endpoint before writing config.toml", () => {
    for (const badEndpoint of [
      "https://models.example.test/v1/a\u0001b",
      "https://models.example.test/v1/a\nb",
      "https://models.example.test/v1/a\rb",
      "https://models.example.test/v1/a\tb",
      "https://models.example.test/v1/a\u007fb",
    ]) {
      const result = normalizeResearchHarnessConfig({ command: "/bin/bridge", args: [], endpoint: badEndpoint });
      expect(result.ok).toBe(false);
      expect(() => desktopSettingsPatchToEdits({ research: { harness: { command: "/bin/bridge", args: [], endpoint: badEndpoint } } }, {})).toThrow(/control character/);
    }
  });

  it("models DesktopSettingsService secret and research config round-trips", async () => {
    const keyArb = fc.stringMatching(/^[\x21-\x7e]{8,64}$/).filter((k) => MATHOS_API_KEY.test(k));
    const secretOpArb = fc.oneof(
      fc.record({ kind: fc.constant("set_secret" as const), value: keyArb }),
      fc.constant({ kind: "clear_secret" as const }),
      fc.record({ kind: fc.constant("set_mathos" as const), team: fc.option(teamArb, { nil: null }), origin: originArb }),
      fc.record({ kind: fc.constant("set_source" as const), source: fc.constantFrom<ResearchHarnessSource>("mathos", "bridge") }),
    );

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-research-cfg-model-"));
    tempRoots.push(root);
    const configPath = path.join(root, "config.toml");

    await fc.assert(
      fc.asyncProperty(fc.array(secretOpArb, { minLength: 1, maxLength: 8 }), async (ops) => {
        fs.rmSync(configPath, { force: true });
        const secretStore = new MemoryDesktopSecretStore();
        const service = new DesktopSettingsService({ configPath, env: {}, secretStore });
        let modelSecret: string | undefined;
        let modelSource: ResearchHarnessSource | undefined;
        let modelMathos: ResearchMathosConfig | undefined;

        for (const op of ops) {
          if (op.kind === "set_secret") {
            const state = await service.replaceSecret("mathosPlatformApiKey", op.value);
            expect(state.configured).toBe(true);
            modelSecret = op.value;
          } else if (op.kind === "clear_secret") {
            const state = await service.clearSecret("mathosPlatformApiKey");
            expect(state.configured).toBe(false);
            modelSecret = undefined;
          } else if (op.kind === "set_mathos") {
            await service.writeConfigPatchTargeted({ research: { mathos: { team: op.team, origin: op.origin } } });
            modelMathos = applyMathosModel(modelMathos, { team: op.team, origin: op.origin });
          } else {
            await service.writeConfigPatchTargeted({ research: { source: op.source } });
            modelSource = op.source;
          }

          expect(service.resolveMathosPlatformApiKeySync()).toBe(modelSecret);
          expect(await service.hasMathosPlatformApiKey()).toBe(Boolean(modelSecret));
          const snapshot = await service.readSettingsProjection();
          expect(snapshot.research?.platformApiKey.configured).toBe(Boolean(modelSecret));
          expect(snapshot.research?.source).toBe(modelSource ?? "mathos");
          expect(snapshot.research?.mathos).toEqual(modelMathos);
          if (modelSecret) {
            expect(JSON.stringify(snapshot)).not.toContain(modelSecret);
            if (fs.existsSync(configPath)) {
              expect(fs.readFileSync(configPath, "utf8")).not.toContain(modelSecret);
            }
          }
        }
      }),
      { numRuns: 40 },
    );
  });
});
