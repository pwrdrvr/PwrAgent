import { writeFile } from "node:fs/promises";
import { MobileDeviceStore } from "../src/main/mobile/device-store";
import { resolveActiveProfilePath } from "../src/main/profile";
import type { MobileScope } from "../../../packages/shared/src/mobile-gateway";

/** Local operator-only administration. Never print bearer/bootstrap secrets. */
async function main(): Promise<void> {
  const [command, value, output] = process.argv.slice(2);
  const store = new MobileDeviceStore(resolveActiveProfilePath("state/mobile-devices.json"));
  if (command === "revoke" && value) { await store.revoke(value); console.log("Device revoked."); return; }
  if (command === "invite" && value && output) {
    const grant = JSON.parse(value) as { scopes: MobileScope[]; machines: string[] | "all" };
    if (!Array.isArray(grant.scopes) || !grant.scopes.includes("read") || grant.scopes.some((scope) => !["read", "send", "voice"].includes(scope))
      || !(grant.machines === "all" || Array.isArray(grant.machines) && grant.machines.length > 0 && grant.machines.every((machine) => typeof machine === "string" && machine.length < 200))) throw new Error("Invalid device grant");
    const code = await store.invite(grant.scopes, grant.machines);
    await writeFile(output, code, { flag: "wx", mode: 0o600 });
    console.log("Pairing code saved to the requested private file; expires in ten minutes. Delete the file after pairing.");
    return;
  }
  throw new Error("Usage: mobile-devices.ts invite '<grant JSON>' <new-private-output-file> | revoke <device-id>. PWRAGENT_PROFILE selects the gateway profile.");
}
void main().catch((error) => { console.error(error instanceof Error ? error.message : "Device administration failed"); process.exitCode = 1; });
