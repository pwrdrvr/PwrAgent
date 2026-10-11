import { expect, test } from "vitest";
import { LiveWindowSession, CHUNK_BYTES } from "./live-session.mjs";
function fixture() {
  let requestId, time = 0;
  const source = { next: (_key, id) => { requestId = id; }, input: c => ({ revision: 1, command: c }) };
  const session = new LiveWindowSession({ owner: "source", viewer: "viewer", source, control: true, now: () => time });
  const open = session.open("viewer");
  const frame = (size = 80, extra = {}) => source.onFrame({ requestId, format: "h264", key: true, width: 800, height: 548,
    data: Buffer.alloc(size, 1).toString("base64"), ...extra });
  return { session, source, open, frame, advance: ms => time += ms, requestId: () => requestId };
}
test("live stream is credit bounded, chunked, and refuses early ACKs", async () => {
  const { session, open, frame } = fixture();
  frame(CHUNK_BYTES + 7);
  frame(4); // unsolicited frame cannot replace the encoded dependency
  const a = await session.pull("viewer", { ...open, offset: 0 });
  expect(Buffer.from(a.data, "base64")).toHaveLength(CHUNK_BYTES);
  expect(() => session.ack("viewer", { ...open, seq: a.seq })).toThrow("invalid_ack");
  await expect(session.pull("viewer", { ...open, offset: 0 })).rejects.toThrow("invalid_offset");
  const b = await session.pull("viewer", { ...open, offset: CHUNK_BYTES });
  expect(Buffer.from(b.data, "base64")).toHaveLength(7);
  session.ack("viewer", { ...open, seq: a.seq });
  expect(session.frame).toBeNull();
});
test("reconnect fences pending pulls/old encode completions and drops control", async () => {
  const { session, source, open, requestId, frame } = fixture();
  const old = requestId();
  const waiting = session.pull("viewer", { ...open, offset: 0 });
  const rejection = expect(waiting).rejects.toThrow("stale_or_unauthorized");
  const next = session.open("viewer");
  expect(next.control).toBe(false);
  source.onFrame({ requestId: old, data: "eA==", format: "h264", width: 800, height: 548, key: true });
  expect(session.frame).toBeNull();
  frame(); await rejection;
  expect(session.frame.epoch).toBe(next.epoch);
});
test("input requires origin, grant, acknowledged scene, fresh challenge and exact input sequence", async () => {
  const { session, open, frame, advance } = fixture(); frame();
  const value = await session.pull("viewer", { ...open, offset: 0 });
  const input = { ...open, displayedSeq: value.seq, nonce: value.nonce, inputSeq: 0, command: { action: "text", text: "fixture" } };
  await expect(session.input("viewer", input)).rejects.toThrow("input_rejected");
  session.ack("viewer", { ...open, seq: value.seq });
  await expect(session.input("intruder", input)).rejects.toThrow("stale_or_unauthorized");
  await expect(session.input("viewer", { ...input, command: { action: "shell", text: "bad" } })).rejects.toThrow("invalid_command");
  expect((await session.input("viewer", input)).revision).toBe(1);
  await expect(session.input("viewer", input)).rejects.toThrow("input_rejected");
  advance(1201);
  await expect(session.input("viewer", { ...input, inputSeq: 1 })).rejects.toThrow("input_rejected");
  session.revoke();
  expect(() => session.open("viewer")).toThrow("not_authorized");
});
test("oversize frames and missing initial codec keyframes revoke the session", () => {
  for (const extra of [{ key: false }, { width: 16000 }]) {
    const { session, frame } = fixture(); frame(50, extra);
    expect(session.stopped).toBe(true);
  }
});
test("suspended capture rejects input even while transport challenges stay fresh", async () => {
  const { session, source, open, frame } = fixture(); frame();
  const value = await session.pull("viewer", { ...open, offset: 0 });
  session.ack("viewer", { ...open, seq: value.seq }); source.available = false;
  await expect(session.input("viewer", { ...open, displayedSeq: value.seq,
    nonce: value.nonce, inputSeq: 0, command: { action: "click", x: .5, y: .5 } })).rejects.toThrow("input_rejected");
});
test("lossless repair remains in the same ordered frame budget after a video ACK", async () => {
  const { session, open, frame } = fixture(); frame();
  const first = await session.pull("viewer", { ...open, offset: 0 });
  session.ack("viewer", { ...open, seq: first.seq });
  const next = session.pull("viewer", { ...open, offset: 0 });
  frame(1000, { format: "png", key: false });
  expect(await next).toMatchObject({ seq: first.seq + 1, format: "png", total: 1000 });
});
