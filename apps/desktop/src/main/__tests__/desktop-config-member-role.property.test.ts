import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import type { FederationPeerRole } from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDesktopSettingsPatch,
  readDesktopSettingsConfig,
} from "../settings/desktop-config";

// Settings → Federation → "Contain this instance" writes `[federation]
// member_role`. The rule: the write reads back as the role it was given, a
// full member carries no key, and nothing else in the file moves — no other
// key, no comment, in that table or any other.

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-member-role-"));
  configPath = path.join(dir, "config.toml");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const existingRole = fc.constantFrom(
  undefined,
  '"full"',
  '"contained"',
  '"Full"',
  // Values this build reads as contained; a write replaces them.
  '"trusted"',
  "true",
  '""',
);

const initialConfig = fc.record({
  header: fc.constantFrom("", "# operator comment\n"),
  table: fc.constantFrom("absent", "empty", "populated"),
  role: existingRole,
  roleComment: fc.constantFrom("", " # set by hand"),
  trailer: fc.constantFrom(
    "",
    "\n[general]\ndeveloper_mode = true # keep\n",
    "\n# trailing note\n[federation.cloudflare]\nendpoint = \"x\"\n",
  ),
});

type InitialConfig = typeof initialConfig extends fc.Arbitrary<infer T> ? T : never;

function renderInitial(config: InitialConfig): string {
  if (config.table === "absent") return config.header + config.trailer;
  const lines = ["[federation]"];
  if (config.table === "populated") {
    lines.push('mode = "gateway" # gateway on the studio Mac');
    lines.push("# advertised to peers");
    lines.push('instance_label = "Studio"');
  }
  if (config.role !== undefined) lines.push(`member_role = ${config.role}${config.roleComment}`);
  if (config.table === "populated") lines.push("compression_enabled = false");
  return `${config.header}${lines.join("\n")}\n${config.trailer}`;
}

function commentLines(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.trim().startsWith("#"));
}

function memberRoleLines(text: string): number {
  return text.split("\n").filter((line) => /^\s*member_role\s*=/.test(line)).length;
}

function withoutMemberRole(config: ReturnType<typeof readDesktopSettingsConfig>) {
  const { memberRole: _memberRole, ...federation } = config.federation ?? {};
  return { ...config, federation };
}

describe("[federation] member_role writes", () => {
  it("round-trips the role and preserves every other key and comment", () => {
    fc.assert(
      fc.property(
        initialConfig,
        fc.array(fc.constantFrom<FederationPeerRole>("full", "contained"), { minLength: 1, maxLength: 3 }),
        (initial, roles) => {
          const source = renderInitial(initial);
          fs.writeFileSync(configPath, source, "utf8");
          const before = readDesktopSettingsConfig(configPath);

          for (const role of roles) {
            applyDesktopSettingsPatch(configPath, { federation: { memberRole: role } });
          }

          const role = roles.at(-1)!;
          const text = fs.readFileSync(configPath, "utf8");
          const after = readDesktopSettingsConfig(configPath);
          // Full is the default: no key. Contained: exactly one key.
          expect(after.federation?.memberRole).toBe(role === "full" ? undefined : "contained");
          expect(memberRoleLines(text)).toBe(role === "full" ? 0 : 1);
          if (role === "contained") expect(text).toMatch(/^member_role = "contained"/m);
          expect(withoutMemberRole(after)).toEqual(withoutMemberRole(before));
          // Every comment survives, except a trailing comment on a deleted key.
          const kept = commentLines(text);
          for (const comment of commentLines(source)) expect(kept).toContain(comment);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("does not touch member_role on an unrelated federation write", () => {
    fc.assert(
      fc.property(initialConfig, (initial) => {
        const source = renderInitial(initial);
        fs.writeFileSync(configPath, source, "utf8");
        const before = readDesktopSettingsConfig(configPath).federation?.memberRole;
        const lines = source.split("\n").filter((line) => /^\s*member_role\s*=/.test(line));

        applyDesktopSettingsPatch(configPath, { federation: { compressionEnabled: true } });

        const text = fs.readFileSync(configPath, "utf8");
        expect(readDesktopSettingsConfig(configPath).federation?.memberRole).toBe(before);
        expect(text.split("\n").filter((line) => /^\s*member_role\s*=/.test(line))).toEqual(lines);
      }),
      { numRuns: 100 },
    );
  });
});
