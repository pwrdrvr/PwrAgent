import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyFederationConfigPatch, subscribeFederationConfig } from "../federation/federation-config-subscription";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "federation-config-subscription-"));
  const configPath = path.join(directory, "config.toml");
  writeFileSync(configPath, '[federation]\nmode = "dual"\nlisten_port = 47830\n');
  const store = new DesktopConfigStore({ configPath });
  const runtime = {
    restart: vi.fn(async () => {}),
    applyCloudflareGatewaySetting: vi.fn(async () => {}),
  };
  const onError = vi.fn();
  const unsubscribe = subscribeFederationConfig(store, runtime, onError);
  cleanups.push(() => {
    unsubscribe();
    store.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  return { configPath, store, runtime, onError };
}

describe("federation config subscription", () => {
  it("applies persisted Cloudflare toggles without restarting unrelated connections", async () => {
    const { store, runtime } = fixture();
    for (const enabled of [false, true]) {
      await store.write({ federation: { cloudflareGatewayEnabled: enabled } }, ["federation"]);
      expect(runtime.restart).not.toHaveBeenCalled();
    }
    expect(runtime.applyCloudflareGatewaySetting).toHaveBeenCalledTimes(2);
  });

  it("handles external toggle edits and restores the enabled default when removed", () => {
    const { configPath, store, runtime } = fixture();
    writeFileSync(configPath, '[federation]\nmode = "dual"\nlisten_port = 47830\ncloudflare_gateway_enabled = false\n');
    store.reloadFromDisk("watch");
    expect(runtime.applyCloudflareGatewaySetting).toHaveBeenCalledOnce();
    writeFileSync(configPath, '[federation]\nmode = "dual"\nlisten_port = 47830\n');
    store.reloadFromDisk("watch");
    expect(runtime.applyCloudflareGatewaySetting).toHaveBeenCalledTimes(2);
    expect(runtime.restart).not.toHaveBeenCalled();
  });

  it("does not restart for explicit true replacing the enabled default or unrelated settings", async () => {
    const { store, runtime } = fixture();
    await store.write({ federation: { cloudflareGatewayEnabled: true } }, ["federation"]);
    await store.write({ general: { developerMode: true } }, ["general"]);
    expect(runtime.restart).not.toHaveBeenCalled();
    expect(runtime.applyCloudflareGatewaySetting).not.toHaveBeenCalled();
  });

  it("still restarts for listener changes, including changes bundled with the toggle", async () => {
    const { store, runtime } = fixture();
    await store.write({ federation: { listenPort: 49000 } }, ["federation"]);
    await store.write({ federation: { mode: "gateway", cloudflareGatewayEnabled: false } }, ["federation"]);
    expect(runtime.restart).toHaveBeenCalledTimes(2);
    expect(runtime.applyCloudflareGatewaySetting).not.toHaveBeenCalled();
  });

  it("reports targeted refresh failures", async () => {
    const { store, runtime, onError } = fixture();
    const error = new Error("connector failed");
    runtime.applyCloudflareGatewaySetting.mockRejectedValueOnce(error);
    await store.write({ federation: { cloudflareGatewayEnabled: false } }, ["federation"]);
    expect(onError).toHaveBeenCalledWith(error);
    expect(runtime.restart).not.toHaveBeenCalled();
  });

  it("keeps direct Settings writes on the targeted path but restarts for mixed patches", async () => {
    const { runtime } = fixture();
    await applyFederationConfigPatch(runtime, { cloudflareGatewayEnabled: false });
    expect(runtime.applyCloudflareGatewaySetting).toHaveBeenCalledOnce();
    expect(runtime.restart).not.toHaveBeenCalled();
    await applyFederationConfigPatch(runtime, { cloudflareGatewayEnabled: true, listenPort: 49000 });
    expect(runtime.restart).toHaveBeenCalledOnce();
  });
});
