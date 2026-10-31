import { isAbsolute } from "node:path";
import { readFile } from "node:fs/promises";
import { resolveActiveProfilePath } from "../profile";
import { MobileDeviceStore } from "./device-store";
import { createMobileAdapter } from "./adapter";
import { startMobileGateway } from "./server";

/** An explicitly installed profile-local config enables this listener. */
export async function startConfiguredMobileGateway(): Promise<(() => Promise<void>) | undefined> {
  let text: string;
  try { text = await readFile(resolveActiveProfilePath("mobile-gateway.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const config = JSON.parse(text) as { host?: string; port?: number; tlsCertificate?: string; tlsKey?: string };
  if (!config.tlsCertificate || !config.tlsKey || !isAbsolute(config.tlsCertificate) || !isAbsolute(config.tlsKey) || !Number.isInteger(config.port) || config.port! < 1024 || config.port! > 65535) throw new Error("Mobile gateway requires TLS certificate/key and a port from 1024–65535");
  const [cert, key] = await Promise.all([readFile(config.tlsCertificate), readFile(config.tlsKey)]);
  const gateway = await startMobileGateway({ host: config.host ?? "127.0.0.1", port: config.port!, tls: { cert, key, minVersion: "TLSv1.2" }, devices: new MobileDeviceStore(resolveActiveProfilePath("state/mobile-devices.json")), adapter: createMobileAdapter() });
  return () => gateway.close();
}
