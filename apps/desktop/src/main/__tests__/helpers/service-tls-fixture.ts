import "reflect-metadata";
import { createPrivateKey, webcrypto } from "node:crypto";
import { SubjectAlternativeNameExtension, X509CertificateGenerator } from "@peculiar/x509";

/** Ephemeral certificate, explicitly trusted only by the requesting test. */
export async function serviceTlsFixture(): Promise<{ key: string; cert: string }> {
  const crypto = webcrypto as unknown as Crypto;
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
  const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const certificate = await X509CertificateGenerator.createSelfSigned({
    name: "CN=Service fixture", keys, signingAlgorithm: algorithm,
    notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 3_600_000),
    extensions: [new SubjectAlternativeNameExtension([{ type: "ip", value: "127.0.0.1" }])],
  }, crypto);
  const der = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
  return { key: createPrivateKey({ key: Buffer.from(der), type: "pkcs8", format: "der" }).export({ type: "pkcs8", format: "pem" }).toString(), cert: certificate.toString("pem") };
}
