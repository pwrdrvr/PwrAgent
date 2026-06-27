import { describe, expect, it } from "vitest";
import {
  NoiseIKHandshake,
  generateNoiseStaticKeyPair,
  noiseKeyPairFromRawPrivate,
  type NoiseKeyPair,
} from "../federation/federation-noise";

// Official test vector for Noise_IK_25519_ChaChaPoly_SHA256 (snow / noise-c
// vector set). Fixed static + ephemeral keys make the handshake deterministic
// so we can byte-compare against the canonical ciphertexts. This is the real
// correctness guarantee for the hand-written state machine.
const VECTOR = {
  prologue:
    "5468657265206973206e6f20726967687420616e642077726f6e672e2054686572652773206f6e6c792066756e20616e6420626f72696e672e",
  initStatic: "f49f93c5112c0787acc808d61716d7e090e076a58f15a3f78d92773f8dcb473b",
  initEphemeral:
    "dae68498c41315cff7e4a34dded8d973199d8f0cf3fcb8b6651c169de77de8be",
  initRemoteStatic:
    "2ea5942829bac414e25aa4cbb1bcc43394816ebb1bd12550d7d0eb4415e42951",
  respStatic: "b790546f98b1e933c48cd01f17e7b281469d46fcacc9a3b584ae65b1d6272e8e",
  respEphemeral:
    "c0875a5b59c8492bd2135e5432d7d484f938e0a1f5009428c4bcb70b2f69f69f",
  messages: [
    {
      payload: "95a8f51c435a9530ff1f30868ed7b23ec952eb513c26a0774fed82d2978a8c81",
      ciphertext:
        "6d21fec9141f3f37cc464e936a48b2d9521b5a44e0f3d960895d3c3fba30282f731f445c25e898e2534ac0536715b24308c108fc46bd260c887b36c3f68e3a05654fc8295c068ed53fb2022560961224e0b10b0835e1efc82fc587cd50f7178fe3d9eb06e0351c6e7334162c10bed670bfa2a105f7b2768a140b3fd597782601",
    },
    {
      payload: "b866b807a6d8b83182b884dbfedc861843c5082bd6e480cb54e4245a72083041",
      ciphertext:
        "e64e1fb8701c4f4bc3850b255fea657d4d835338b059c89acc99628fbe52473b41a4e79e3c1e6abc46bf80f078a005e15d8a3e04f989af3e6cb99b52031165006163ac3e17b928af8c116009d7bf4fb2",
    },
    {
      payload: "e3a4937faef391028f759758b428b57652e0069a8dee64dfed01b60846938740",
      ciphertext:
        "2bebe19102169cdfe79cf41e38930bfd20a5b2fc78ccf33e853ddd939c0983174656eb27b61464a607762848892ca1c0",
    },
    {
      payload: "693972f27b0cb98aeac1fb54d782125431e7540e0cb2fa882cf51a8184d724fd",
      ciphertext:
        "c7c56da33b45d12f4754e17978bd49999c9c8f51d00db460f902aba2e6e245d0c46662f507915de8596f43b1d175f1db",
    },
  ],
} as const;

function hex(value: string): Buffer {
  return Buffer.from(value, "hex");
}

function fixedEphemeral(rawPrivateHex: string): () => NoiseKeyPair {
  return () => noiseKeyPairFromRawPrivate(hex(rawPrivateHex));
}

describe("Noise_IK_25519_ChaChaPoly_SHA256", () => {
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
    const onWire = clientChannel.encrypt(message);
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
