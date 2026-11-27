import type { buildHeadlessDriverFixture } from "../main/__tests__/helpers/headless-driver-fixture";

export type OracleFixture<T> = { value: T } | { error: string };
export type PortableOutpostFixture = { root: string; directory: string; externalTargets: Record<string, string> };

declare module "vitest" {
  export interface ProvidedContext {
    headlessDriver: OracleFixture<Awaited<ReturnType<typeof buildHeadlessDriverFixture>>>;
    desktopEntryHasFileKey: OracleFixture<boolean>;
    portableOutpost: OracleFixture<PortableOutpostFixture>;
  }
}

export function requireOracleFixture<T>(fixture: OracleFixture<T>): T {
  if ("error" in fixture) throw new Error(fixture.error);
  return fixture.value;
}
