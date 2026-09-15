import "reflect-metadata";
import { createPrivateKey, randomBytes, webcrypto, X509Certificate } from "node:crypto";
import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectKeyIdentifierExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";

const algorithm = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
};
const crypto = webcrypto as unknown as Crypto;
export type CloudflareCertificate = { certificate: string; privateKey: string };

async function keys() {
  return crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
}

async function pem(key: CryptoKey): Promise<string> {
  const der = await crypto.subtle.exportKey("pkcs8", key);
  return createPrivateKey({ key: Buffer.from(der), type: "pkcs8", format: "der" })
    .export({ type: "pkcs8", format: "pem" }).toString();
}

function validity(days: number) {
  return {
    serialNumber: randomBytes(16).toString("hex"),
    notBefore: new Date(Date.now() - 5 * 60_000),
    notAfter: new Date(Date.now() + days * 86_400_000),
    signingAlgorithm: algorithm,
  };
}

export async function createCloudflareCa(): Promise<CloudflareCertificate> {
  const pair = await keys();
  const certificate = await X509CertificateGenerator.createSelfSigned({
    ...validity(3650),
    name: `CN=PwrAgent CA ${randomBytes(8).toString("hex")}`,
    keys: pair,
    extensions: [
      new BasicConstraintsExtension(true, 0, true),
      new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
      await SubjectKeyIdentifierExtension.create(pair.publicKey, false, crypto),
    ],
  }, crypto);
  return { certificate: certificate.toString("pem"), privateKey: await pem(pair.privateKey) };
}

export async function issueCloudflareClient(
  ca: CloudflareCertificate,
  commonName: string,
): Promise<CloudflareCertificate> {
  if (!/^pwragent-[a-f0-9]{32}$/.test(commonName)) throw new Error("Invalid certificate identity.");
  const pair = await keys();
  const issuer = new X509Certificate(ca.certificate);
  const signingKey = await crypto.subtle.importKey("pkcs8",
    new Uint8Array(createPrivateKey(ca.privateKey).export({ type: "pkcs8", format: "der" })),
    algorithm, false, ["sign"]);
  const certificate = await X509CertificateGenerator.create({
    ...validity(90),
    subject: `CN=${commonName}`,
    issuer: issuer.subject,
    publicKey: pair.publicKey,
    signingKey,
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.2"], true),
      await SubjectKeyIdentifierExtension.create(pair.publicKey, false, crypto),
      await AuthorityKeyIdentifierExtension.create(issuer.publicKey.export({ type: "spki", format: "der" }), false, crypto),
    ],
  }, crypto);
  return { certificate: certificate.toString("pem"), privateKey: await pem(pair.privateKey) };
}
