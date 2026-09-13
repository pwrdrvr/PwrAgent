import { createCipheriv, createDecipheriv, randomBytes, scrypt, X509Certificate, createPrivateKey } from "node:crypto";
import { promisify } from "node:util";
import type { CloudflareCertificate } from "./cloudflare-certificates";

const derive = promisify(scrypt);
type Bundle = CloudflareCertificate & { version: 1; endpoint: string; invite: string };

export async function encryptCloudflareBundle(bundle: Bundle, password: string): Promise<string> {
  if (password.length < 12 || password.length > 1024) throw new Error("Use a bundle password with at least 12 characters.");
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = await derive(password, salt, 32) as Buffer;
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(bundle)), cipher.final()]);
  key.fill(0);
  return JSON.stringify({ format: "pwragent-cloudflare-client-v1", salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
}

export async function decryptCloudflareBundle(text: string, password: string): Promise<Bundle> {
  if (text.length > 128_000 || password.length > 1024) throw new Error("Client bundle exceeds the import limit.");
  try {
    const envelope = JSON.parse(text);
    if (envelope.format !== "pwragent-cloudflare-client-v1") throw new Error();
    const salt = Buffer.from(envelope.salt, "base64");
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    if (salt.length !== 32 || iv.length !== 12 || tag.length !== 16) throw new Error();
    const key = await derive(password, salt, 32) as Buffer;
    const cipher = createDecipheriv("aes-256-gcm", key, iv);
    cipher.setAuthTag(tag);
    const data = Buffer.concat([cipher.update(Buffer.from(envelope.data, "base64")), cipher.final()]);
    key.fill(0);
    const bundle = JSON.parse(data.toString("utf8")) as Bundle;
    const url = new URL(bundle.endpoint);
    if (bundle.version !== 1 || url.protocol !== "wss:" || url.username || url.password || url.port
      || url.pathname !== "/" || url.search || url.hash || !/^[a-z0-9-]+\.[a-z0-9.-]+$/.test(url.hostname)
      || typeof bundle.invite !== "string") throw new Error();
    const cert = new X509Certificate(bundle.certificate);
    if (!cert.checkPrivateKey(createPrivateKey(bundle.privateKey)) || Date.parse(cert.validTo) <= Date.now() || cert.ca) throw new Error();
    return bundle;
  } catch { throw new Error("Could not open the client bundle. Check its password, certificate, and file format."); }
}
