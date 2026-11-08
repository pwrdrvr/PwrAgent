import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { writeDesktopSecretsToProfile } from "../settings/profile-secret-service";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { PWRAGENT_HOME_ENV } from "../profile";

const encryption = vi.hoisted(() => ({ available: true }));
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryption.available,
    encryptString: (value: string) => {
      if (value === "fixture-denied") throw new Error("fixture encryption denied");
      return Buffer.from(`encrypted:${value}`);
    },
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("closes every transient profile writer and preserves partial writes when later encryption fails", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const names = ["discordBotToken", "telegramBotToken"] as const;
  const operation = fc.record({
    profile: fc.integer({ min: 0, max: 1 }),
    available: fc.boolean(),
    disabled: fc.boolean(),
    values: fc.tuple(...names.map(() => fc.constantFrom("", "fixture-value", "fixture-denied"))),
  });
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 15 }), async (operations) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-profile-secret-model-"));
    vi.stubEnv(PWRAGENT_HOME_ENV, root);
    const databases = [0, 1].map(index => {
      const directory = path.join(root, "profiles", `fixture-${index}`, "state");
      fs.mkdirSync(directory, { recursive: true });
      return StateDb.open(path.join(directory, "state.db"), { profileName: `fixture-${index}` });
    });
    const model = [new Map<string, string>(), new Map<string, string>()];
    const open = vi.spyOn(StateDb, "open");
    const close = vi.spyOn(StateDb.prototype, "close");
    try {
      for (const op of operations) {
        open.mockClear();
        close.mockClear();
        encryption.available = op.available;
        vi.stubEnv("PWRAGENT_DEV_DISABLE_SECRET_STORAGE", op.disabled ? "1" : "0");
        const expectedWritten: string[] = [];
        let failed = false;
        if (!op.disabled && op.available) {
          for (const [index, name] of names.entries()) {
            const value = op.values[index]!;
            if (value === "fixture-denied") { failed = true; break; }
            if (value === "") model[op.profile]!.delete(name);
            else model[op.profile]!.set(name, value);
            expectedWritten.push(name);
          }
        }
        const mutation = await measureSqliteWrites(() => {
          const call = () => writeDesktopSecretsToProfile({
            profile: `fixture-${op.profile}`,
            secrets: Object.fromEntries(names.map((name, index) => [name, op.values[index]])),
          });
          if (!op.disabled && (!op.available || failed)) expect(call).toThrow(op.available ? "fixture encryption denied" : "encryption is unavailable");
          else expect(call().written).toEqual(expectedWritten);
        });
        expect(mutation.writes.commits).toBe(expectedWritten.length);
        const opens = !op.disabled && op.available ? 1 : 0;
        expect(open).toHaveBeenCalledTimes(opens);
        expect(close).toHaveBeenCalledTimes(opens);
        for (const result of open.mock.results) {
          if (result.type === "return") expect((result.value as StateDb).raw.open).toBe(false);
        }
        for (const [profile, db] of databases.entries()) {
          for (const name of names) {
            const value = model[profile]!.get(name);
            expect(db.getSecret(name)?.toString()).toBe(value === undefined ? undefined : `encrypted:${value}`);
          }
        }
      }
    } finally {
      open.mockRestore();
      close.mockRestore();
      for (const db of databases) db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }), { numRuns: 25 });
});
