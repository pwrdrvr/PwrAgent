// Noise_IK_25519_ChaChaPoly_SHA256 — a hand-written implementation of the one
// Noise handshake pattern federation needs, built on Node's audited crypto
// primitives (X25519, ChaCha20-Poly1305, HMAC-SHA256). We implement only the
// state-machine plumbing; every cryptographic primitive is delegated to
// OpenSSL via node:crypto. Correctness is locked down against the official
// Noise test vectors in federation-noise.test.ts.
//
// IK gives us exactly the two properties LAN federation needs:
//   - the initiator (client) knows the responder's (gateway's) static public
//     key in advance and the handshake proves the gateway holds it (the client
//     "connects to the machine it approved");
//   - the responder learns and authenticates the initiator's static key (the
//     gateway "only talks to a caller it approved").
// Plus confidentiality + integrity + forward secrecy on every transport frame.
//
// IK message pattern (from the Noise spec):
//   <- s                 (pre-message: initiator already knows responder static)
//   -> e, es, s, ss      (message 1, initiator -> responder)
//   <- e, ee, se         (message 2, responder -> initiator)
//   ... Split() -> transport cipher states
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

const PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_SHA256";
const HASHLEN = 32;
const TAGLEN = 16;
const KEYLEN = 32;

// Fixed DER prefixes for raw <-> KeyObject conversion of X25519 keys (RFC 8410).
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex"); // + 32-byte public
const X25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b656e04220420",
  "hex",
); // + 32-byte private seed

export type NoiseKeyPair = {
  privateKey: KeyObject;
  publicKeyRaw: Buffer;
};

export type NoiseRole = "initiator" | "responder";

export type NoiseTransport = {
  /** Encrypt an outbound transport frame (AEAD, monotonic nonce). */
  encrypt(plaintext: Buffer): Buffer;
  /** Decrypt an inbound transport frame; throws on tamper/replay. */
  decrypt(ciphertext: Buffer): Buffer;
  /** Final handshake hash `h` — bind higher-layer identity proofs to this. */
  handshakeHash: Buffer;
};

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

// Noise's HKDF (HMAC chain), returning the first two 32-byte outputs.
function hkdf2(chainingKey: Buffer, ikm: Buffer): [Buffer, Buffer] {
  const tempKey = hmac(chainingKey, ikm);
  const output1 = hmac(tempKey, Buffer.from([0x01]));
  const output2 = hmac(tempKey, Buffer.concat([output1, Buffer.from([0x02])]));
  return [output1, output2];
}

export function rawPublicKey(key: KeyObject): Buffer {
  return Buffer.from(key.export({ type: "spki", format: "der" })).subarray(
    -KEYLEN,
  );
}

export function importNoisePublicKey(raw: Buffer): KeyObject {
  if (raw.length !== KEYLEN) {
    throw new Error("Invalid X25519 public key length");
  }
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function generateNoiseStaticKeyPair(): NoiseKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { privateKey, publicKeyRaw: rawPublicKey(publicKey) };
}

// Rebuild a keypair from a raw 32-byte X25519 private seed. Used for the
// persisted static key and for injecting fixed keys in test vectors.
export function noiseKeyPairFromRawPrivate(raw: Buffer): NoiseKeyPair {
  if (raw.length !== KEYLEN) {
    throw new Error("Invalid X25519 private key length");
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
  return { privateKey, publicKeyRaw: rawPublicKey(createPublicKey(privateKey)) };
}

export function rawPrivateKey(key: KeyObject): Buffer {
  return Buffer.from(key.export({ type: "pkcs8", format: "der" })).subarray(
    -KEYLEN,
  );
}

export type FederationNoiseStaticKeyPair = {
  /** Raw 32-byte X25519 private seed, base64. Persisted in the secret store. */
  privateKeyBase64: string;
  /** Raw 32-byte X25519 public key, base64. Pinned by peers. */
  publicKeyBase64: string;
};

export function generateFederationNoiseStaticKeyPair(): FederationNoiseStaticKeyPair {
  const keyPair = generateNoiseStaticKeyPair();
  return {
    privateKeyBase64: rawPrivateKey(keyPair.privateKey).toString("base64"),
    publicKeyBase64: keyPair.publicKeyRaw.toString("base64"),
  };
}

export function noisePublicKeyBase64FromPrivateBase64(
  privateKeyBase64: string,
): string {
  return noiseKeyPairFromRawPrivate(
    Buffer.from(privateKeyBase64, "base64"),
  ).publicKeyRaw.toString("base64");
}

function dh(localPrivate: KeyObject, remoteRaw: Buffer): Buffer {
  return diffieHellman({
    privateKey: localPrivate,
    publicKey: importNoisePublicKey(remoteRaw),
  });
}

class CipherState {
  private key?: Buffer;
  private nonce = 0n;

  initializeKey(key: Buffer): void {
    this.key = key;
    this.nonce = 0n;
  }

  hasKey(): boolean {
    return this.key !== undefined;
  }

  private nextNonce(): Buffer {
    // Noise nonce: 4 zero bytes followed by the 64-bit counter, little-endian.
    const buf = Buffer.alloc(12);
    buf.writeBigUInt64LE(this.nonce, 4);
    return buf;
  }

  encryptWithAd(ad: Buffer, plaintext: Buffer): Buffer {
    if (this.key === undefined) return plaintext;
    if (this.nonce >= 0xffffffffffffffffn) {
      throw new Error("Noise nonce exhausted");
    }
    const cipher = createCipheriv("chacha20-poly1305", this.key, this.nextNonce(), {
      authTagLength: TAGLEN,
    });
    cipher.setAAD(ad, { plaintextLength: plaintext.length });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.nonce += 1n;
    return Buffer.concat([ciphertext, tag]);
  }

  decryptWithAd(ad: Buffer, data: Buffer): Buffer {
    if (this.key === undefined) return data;
    if (data.length < TAGLEN) {
      throw new Error("Noise ciphertext too short");
    }
    if (this.nonce >= 0xffffffffffffffffn) {
      throw new Error("Noise nonce exhausted");
    }
    const ciphertext = data.subarray(0, data.length - TAGLEN);
    const tag = data.subarray(data.length - TAGLEN);
    const decipher = createDecipheriv(
      "chacha20-poly1305",
      this.key,
      this.nextNonce(),
      { authTagLength: TAGLEN },
    );
    decipher.setAAD(ad, { plaintextLength: ciphertext.length });
    decipher.setAuthTag(tag);
    // final() throws if the tag does not verify; only advance on success.
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    this.nonce += 1n;
    return plaintext;
  }
}

class SymmetricState {
  private chainingKey: Buffer;
  hash: Buffer;
  readonly cipher = new CipherState();

  constructor() {
    const name = Buffer.from(PROTOCOL_NAME, "utf8");
    // Protocol name is <= HASHLEN, so h is the name zero-padded to 32 bytes —
    // NOT hashed.
    this.hash =
      name.length <= HASHLEN
        ? Buffer.concat([name, Buffer.alloc(HASHLEN - name.length)])
        : sha256(name);
    this.chainingKey = Buffer.from(this.hash);
  }

  mixKey(ikm: Buffer): void {
    const [chainingKey, tempKey] = hkdf2(this.chainingKey, ikm);
    this.chainingKey = chainingKey;
    this.cipher.initializeKey(tempKey);
  }

  mixHash(data: Buffer): void {
    this.hash = sha256(Buffer.concat([this.hash, data]));
  }

  encryptAndHash(plaintext: Buffer): Buffer {
    const ciphertext = this.cipher.encryptWithAd(this.hash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Buffer): Buffer {
    const plaintext = this.cipher.decryptWithAd(this.hash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(this.chainingKey, Buffer.alloc(0));
    const c1 = new CipherState();
    c1.initializeKey(k1);
    const c2 = new CipherState();
    c2.initializeKey(k2);
    return [c1, c2];
  }
}

export type NoiseHandshakeOptions = {
  role: NoiseRole;
  localStatic: NoiseKeyPair;
  /** Required for the initiator: the pinned responder (gateway) static pubkey. */
  remoteStaticPublicKey?: Buffer;
  prologue?: Buffer;
  /** Test seam: supply a deterministic ephemeral keypair. Defaults to random. */
  generateEphemeral?: () => NoiseKeyPair;
};

export class NoiseIKHandshake {
  private readonly sym = new SymmetricState();
  private readonly role: NoiseRole;
  private readonly localStatic: NoiseKeyPair;
  private readonly generateEphemeral: () => NoiseKeyPair;
  private localEphemeral?: NoiseKeyPair;
  private remoteStatic?: Buffer;
  private remoteEphemeral?: Buffer;

  constructor(options: NoiseHandshakeOptions) {
    this.role = options.role;
    this.localStatic = options.localStatic;
    this.generateEphemeral =
      options.generateEphemeral ?? generateNoiseStaticKeyPair;

    this.sym.mixHash(options.prologue ?? Buffer.alloc(0));

    // Pre-message: IK has `<- s` (responder static), hashed by both sides.
    if (this.role === "initiator") {
      if (!options.remoteStaticPublicKey) {
        throw new Error("Initiator requires the pinned responder static key");
      }
      this.remoteStatic = Buffer.from(options.remoteStaticPublicKey);
      this.sym.mixHash(this.remoteStatic);
    } else {
      this.sym.mixHash(this.localStatic.publicKeyRaw);
    }
  }

  /** Initiator: write message 1 (e, es, s, ss + payload). */
  writeMessage1(payload: Buffer = Buffer.alloc(0)): Buffer {
    if (this.role !== "initiator") throw new Error("writeMessage1 is initiator-only");
    if (!this.remoteStatic) throw new Error("Missing pinned responder static");
    this.localEphemeral = this.generateEphemeral();
    this.sym.mixHash(this.localEphemeral.publicKeyRaw);
    this.sym.mixKey(dh(this.localEphemeral.privateKey, this.remoteStatic)); // es
    const encStatic = this.sym.encryptAndHash(this.localStatic.publicKeyRaw); // s
    this.sym.mixKey(dh(this.localStatic.privateKey, this.remoteStatic)); // ss
    const encPayload = this.sym.encryptAndHash(payload);
    return Buffer.concat([this.localEphemeral.publicKeyRaw, encStatic, encPayload]);
  }

  /** Responder: read message 1. Returns the (decrypted) payload. */
  readMessage1(message: Buffer): Buffer {
    if (this.role !== "responder") throw new Error("readMessage1 is responder-only");
    let offset = 0;
    this.remoteEphemeral = message.subarray(offset, offset + KEYLEN);
    offset += KEYLEN;
    this.sym.mixHash(this.remoteEphemeral);
    this.sym.mixKey(dh(this.localStatic.privateKey, this.remoteEphemeral)); // es
    const encStatic = message.subarray(offset, offset + KEYLEN + TAGLEN);
    offset += KEYLEN + TAGLEN;
    this.remoteStatic = this.sym.decryptAndHash(encStatic); // s
    this.sym.mixKey(dh(this.localStatic.privateKey, this.remoteStatic)); // ss
    return this.sym.decryptAndHash(message.subarray(offset));
  }

  /** Responder: write message 2 (e, ee, se + payload). */
  writeMessage2(payload: Buffer = Buffer.alloc(0)): Buffer {
    if (this.role !== "responder") throw new Error("writeMessage2 is responder-only");
    if (!this.remoteEphemeral || !this.remoteStatic) {
      throw new Error("writeMessage2 requires readMessage1 first");
    }
    this.localEphemeral = this.generateEphemeral();
    this.sym.mixHash(this.localEphemeral.publicKeyRaw);
    this.sym.mixKey(dh(this.localEphemeral.privateKey, this.remoteEphemeral)); // ee
    this.sym.mixKey(dh(this.localEphemeral.privateKey, this.remoteStatic)); // se (responder: DH(e, rs))
    const encPayload = this.sym.encryptAndHash(payload);
    return Buffer.concat([this.localEphemeral.publicKeyRaw, encPayload]);
  }

  /** Initiator: read message 2. Returns the (decrypted) payload. */
  readMessage2(message: Buffer): Buffer {
    if (this.role !== "initiator") throw new Error("readMessage2 is initiator-only");
    if (!this.localEphemeral) throw new Error("readMessage2 requires writeMessage1 first");
    let offset = 0;
    this.remoteEphemeral = message.subarray(offset, offset + KEYLEN);
    offset += KEYLEN;
    this.sym.mixHash(this.remoteEphemeral);
    this.sym.mixKey(dh(this.localEphemeral.privateKey, this.remoteEphemeral)); // ee
    this.sym.mixKey(dh(this.localStatic.privateKey, this.remoteEphemeral)); // se (initiator: DH(s, re))
    return this.sym.decryptAndHash(message.subarray(offset));
  }

  /** The remote static key the responder learned during the handshake. */
  remoteStaticPublicKey(): Buffer | undefined {
    return this.remoteStatic ? Buffer.from(this.remoteStatic) : undefined;
  }

  /** Finalize: split into directional transport cipher states. */
  split(): NoiseTransport {
    const [c1, c2] = this.sym.split();
    // Initiator sends with the first cipher state; responder with the second.
    const send = this.role === "initiator" ? c1 : c2;
    const recv = this.role === "initiator" ? c2 : c1;
    const handshakeHash = Buffer.from(this.sym.hash);
    return {
      handshakeHash,
      encrypt: (plaintext) => send.encryptWithAd(Buffer.alloc(0), plaintext),
      decrypt: (ciphertext) => recv.decryptWithAd(Buffer.alloc(0), ciphertext),
    };
  }
}
