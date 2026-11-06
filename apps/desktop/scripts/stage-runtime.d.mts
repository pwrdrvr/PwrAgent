// Types for the shared custom-Git consumer. Its JavaScript is pinned by hash
// in every runtime catalog (`consumer_sha256`), so it stays plain .mjs.

export type RuntimePin = {
  manifest: { version: string; source_revision: string; [key: string]: unknown };
  asset: { inventory_sha256: string; sha256?: string; url?: string; [key: string]: unknown };
  key: string;
};

export function readRuntimeManifest(path: string, platform: string, arch: string): RuntimePin;

export function verifyRuntime(
  root: string,
  pin: RuntimePin,
  options?: { requireSigned?: boolean; probe?: boolean },
): { version: string; source_revision: string; [key: string]: unknown };

export function stageRuntime(options: {
  manifestPath: string;
  platform: string;
  arch: string;
  output: string;
  cache?: string;
}): Promise<RuntimePin>;
