import { describe, expect, it } from "vitest";
import {
  NoiseIKHandshake,
  generateNoiseStaticKeyPair,
  noiseKeyPairFromRawPrivate,
  type NoiseKeyPair,
} from "../federation/federation-noise";

// Independent screech/titanous-noise test vector for
// Noise_IK_25519_AESGCM_SHA256. Fixed static + ephemeral keys make the
// handshake deterministic so we can byte-compare against canonical
// ciphertexts from another implementation.
const VECTOR = {
  prologue: "6e6f74736563726574",
  initStatic: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  initEphemeral:
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
  initRemoteStatic:
    "07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c",
  respStatic: "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
  respEphemeral:
    "4142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60",
  messages: [
    {
      payload: "746573745f6d73675f30",
      ciphertext:
        "358072d6365880d1aeea329adf9121383851ed21a28e3b75e965d0d2cd16625419d6fab175300a577115c701c41ed681373f0432f81d3bf8676bd05216cd1919e61b75ccef0c0cf0b216fcdf371d0859e6d8177aa9777fe9b8435bb6f8202c3acd9051a9aee0a63e76f6",
    },
    {
      payload: "746573745f6d73675f31",
      ciphertext:
        "64b101b1d0be5a8704bd078f9895001fc03e8e9f9522f188dd128d9846d4846658a7bb8caac5097833909e90778571d34ce0e5b6ea4c3a76f102",
    },
    {
      payload: "79656c6c6f777375626d6172696e65",
      ciphertext:
        "80a75e75c8e8d2e9c2a6c7bc6e550c4997d6d2b45429a530821c4aa5d36f27",
    },
    {
      payload: "7375626d6172696e6579656c6c6f77",
      ciphertext:
        "b8475410da62a98493d33a1e669f8f56dd8f61d449b53bd375299c3435424a",
    },
  ],
} as const;

function hex(value: string): Buffer {
  return Buffer.from(value, "hex");
}

function fixedEphemeral(rawPrivateHex: string): () => NoiseKeyPair {
  return () => noiseKeyPairFromRawPrivate(hex(rawPrivateHex));
}

describe("Noise_IK_25519_AESGCM_SHA256", () => {
  it("derives the responder static public key from the vector private seed", () => {
    const resp = noiseKeyPairFromRawPrivate(hex(VECTOR.respStatic));
    expect(resp.publicKeyRaw.toString("hex")).toBe(VECTOR.initRemoteStatic);
  });

  it("matches the official handshake and transport ciphertexts", () => {
    const initiator = new NoiseIKHandshake({
      role: "initiator",
      localStatic: noiseKeyPairFromRawPrivate(hex(VECTOR.initStatic)),
      remoteStaticPublicKey: hex(VECTOR.initRemoteStatic),
      prologue: hex(VECTOR.prologue),
      generateEphemeral: fixedEphemeral(VECTOR.initEphemeral),
    });
    const responder = new NoiseIKHandshake({
      role: "responder",
      localStatic: noiseKeyPairFromRawPrivate(hex(VECTOR.respStatic)),
      prologue: hex(VECTOR.prologue),
      generateEphemeral: fixedEphemeral(VECTOR.respEphemeral),
    });

    // Message 1: initiator -> responder.
    const msg1 = initiator.writeMessage1(hex(VECTOR.messages[0].payload));
    expect(msg1.toString("hex")).toBe(VECTOR.messages[0].ciphertext);
    expect(responder.readMessage1(msg1).toString("hex")).toBe(
      VECTOR.messages[0].payload,
    );

    // The responder learns and exposes the initiator's static key (the higher
    // layer pins this — "only a caller I approved").
    expect(responder.remoteStaticPublicKey()?.toString("hex")).toBe(
      noiseKeyPairFromRawPrivate(hex(VECTOR.initStatic)).publicKeyRaw.toString(
        "hex",
      ),
    );

    // Message 2: responder -> initiator.
    const msg2 = responder.writeMessage2(hex(VECTOR.messages[1].payload));
    expect(msg2.toString("hex")).toBe(VECTOR.messages[1].ciphertext);
    expect(initiator.readMessage2(msg2).toString("hex")).toBe(
      VECTOR.messages[1].payload,
    );

    const initiatorTransport = initiator.split();
    const responderTransport = responder.split();

    // Both ends derive the same handshake hash (binds higher-layer proofs).
    expect(initiatorTransport.handshakeHash.toString("hex")).toBe(
      responderTransport.handshakeHash.toString("hex"),
    );

    // Transport message 3: initiator -> responder.
    const t1 = initiatorTransport.encrypt(hex(VECTOR.messages[2].payload));
    expect(t1.toString("hex")).toBe(VECTOR.messages[2].ciphertext);
    expect(responderTransport.decrypt(t1).toString("hex")).toBe(
      VECTOR.messages[2].payload,
    );

    // Transport message 4: responder -> initiator.
    const t2 = responderTransport.encrypt(hex(VECTOR.messages[3].payload));
    expect(t2.toString("hex")).toBe(VECTOR.messages[3].ciphertext);
    expect(initiatorTransport.decrypt(t2).toString("hex")).toBe(
      VECTOR.messages[3].payload,
    );
  });

  it("completes a handshake with random keys and exchanges encrypted traffic", () => {
    const gateway = generateNoiseStaticKeyPair();
    const client = generateNoiseStaticKeyPair();

    const initiator = new NoiseIKHandshake({
      role: "initiator",
      localStatic: client,
      remoteStaticPublicKey: gateway.publicKeyRaw,
    });
    const responder = new NoiseIKHandshake({
      role: "responder",
      localStatic: gateway,
    });

    responder.readMessage1(initiator.writeMessage1());
    initiator.readMessage2(responder.writeMessage2());

    const clientChannel = initiator.split();
    const gatewayChannel = responder.split();

    const message = Buffer.from("startTurn: rm -rf nothing", "utf8");
    expect(clientChannel.encryptedByteLength(message.byteLength)).toBe(
      message.byteLength + 16,
    );
    const onWire = clientChannel.encrypt(message);
    expect(onWire.byteLength).toBe(
      clientChannel.encryptedByteLength(message.byteLength),
    );
    expect(onWire.equals(message)).toBe(false); // ciphertext != plaintext
    expect(gatewayChannel.decrypt(onWire).toString("utf8")).toBe(
      message.toString("utf8"),
    );
    // Reverse direction.
    const reply = Buffer.from("ok", "utf8");
    expect(
      clientChannel.decrypt(gatewayChannel.encrypt(reply)).toString("utf8"),
    ).toBe("ok");
  });

  it("rejects a tampered transport frame", () => {
    const gateway = generateNoiseStaticKeyPair();
    const client = generateNoiseStaticKeyPair();
    const initiator = new NoiseIKHandshake({
      role: "initiator",
      localStatic: client,
      remoteStaticPublicKey: gateway.publicKeyRaw,
    });
    const responder = new NoiseIKHandshake({ role: "responder", localStatic: gateway });
    responder.readMessage1(initiator.writeMessage1());
    initiator.readMessage2(responder.writeMessage2());
    const clientChannel = initiator.split();
    const gatewayChannel = responder.split();

    const frame = clientChannel.encrypt(Buffer.from("authentic", "utf8"));
    const tampered = Buffer.from(frame);
    tampered[0] ^= 0x01;
    expect(() => gatewayChannel.decrypt(tampered)).toThrow();
  });

  it("fails the handshake when the client pins the wrong gateway key (MITM / wrong machine)", () => {
    const realGateway = generateNoiseStaticKeyPair();
    const attacker = generateNoiseStaticKeyPair();
    const client = generateNoiseStaticKeyPair();

    // Client pins the ATTACKER's key but connects to the real gateway.
    const initiator = new NoiseIKHandshake({
      role: "initiator",
      localStatic: client,
      remoteStaticPublicKey: attacker.publicKeyRaw,
    });
    const responder = new NoiseIKHandshake({
      role: "responder",
      localStatic: realGateway,
    });

    // The real gateway cannot decrypt message 1 because the `es`/`ss` DH
    // outputs diverge from what the client mixed against the attacker key.
    expect(() => responder.readMessage1(initiator.writeMessage1())).toThrow();
  });
});
