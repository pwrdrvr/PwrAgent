/** Manual live probe: synthetic silent WebRTC audio, no device capture or tool execution. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "@playwright/test";
import { NATIVE_VOICE_PROMPTS, cameraStatusText } from "../src/main/codex-app-server/native-voice-prompts";
import { cameraCueText } from "../src/shared/native-voice-camera";

const option = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const runtime = process.argv.includes("--codex") ? option("--codex") : undefined;
if (!runtime || !isAbsolute(runtime)) throw new Error("Pass --codex with the absolute path to an authenticated Codex runtime.");
const executablePath = process.argv.includes("--browser") ? option("--browser") : undefined;
const browser = await chromium.launch({ headless: true, executablePath, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
const workspace = await mkdtemp(join(tmpdir(), "pwragent-camera-context-"));
const child = spawn(runtime, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const transcripts: { phase: string; text: string }[] = [];
let next = 0;
let phase = "startup";
let threadId: string | undefined;
let failure: Error | undefined;
// Server diagnostics can include account/configuration details. Print only synthetic transcripts.
child.stderr.on("data", () => {});
child.on("error", (error) => { failure = error; });
child.stdin.on("error", (error) => { failure = error; });
child.on("exit", () => {
  for (const response of pending.values()) response.reject(new Error("Probe App Server exited"));
  pending.clear();
});
const rpc = (method: string, params: unknown, timeout = 15_000): Promise<unknown> => new Promise((resolve, reject) => {
  const id = ++next;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
  pending.set(id, {
    resolve: (value) => { clearTimeout(timer); resolve(value); },
    reject: (error) => { clearTimeout(timer); reject(error); },
  });
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let message: { id?: number; method?: string; result?: unknown; error?: { message: string }; params?: Record<string, unknown> };
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && pending.has(message.id)) {
    const response = pending.get(message.id)!;
    pending.delete(message.id);
    if (message.error) response.reject(new Error(message.error.message));
    else response.resolve(message.result);
    return;
  }
  if (message.id !== undefined && message.method) {
    child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "No tools in this probe" } })}\n`);
    failure = new Error("Unexpected backend tool request");
    return;
  }
  const params = message.params ?? {};
  if (message.method === "thread/realtime/sdp" && typeof params.sdp === "string") {
    void page.evaluate((sdp) => window.cameraProbe.peer.setRemoteDescription({ type: "answer", sdp }), params.sdp)
      .catch((error: Error) => { failure = error; });
  }
  if (message.method === "thread/realtime/error") failure = new Error(String(params.message));
  if (message.method === "thread/realtime/transcript/done" && params.role === "assistant" && typeof params.text === "string") {
    transcripts.push({ phase, text: params.text });
    console.log(JSON.stringify(transcripts.at(-1)));
  }
});

declare global {
  interface Window {
    cameraProbe: { peer: RTCPeerConnection; audio: AudioContext; receipts: number };
  }
}

async function offer(): Promise<string> {
  return await page.evaluate(async () => {
    if (window.cameraProbe) {
      window.cameraProbe.peer.close();
      await window.cameraProbe.audio.close();
    }
    const audio = new AudioContext();
    await audio.resume();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const destination = audio.createMediaStreamDestination();
    gain.gain.value = 0;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    const peer = new RTCPeerConnection();
    peer.addTrack(destination.stream.getAudioTracks()[0]);
    const channel = peer.createDataChannel("oai-events");
    window.cameraProbe = { peer, audio, receipts: 0 };
    channel.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string };
        if (message.type === "session.context.appended") window.cameraProbe.receipts++;
      } catch { /* Audio is media transport; ignore non-JSON data. */ }
    };
    peer.ontrack = (event) => {
      const output = document.createElement("audio");
      output.autoplay = true;
      output.muted = true;
      output.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      document.body.replaceChildren(output);
      void output.play();
    };
    await peer.setLocalDescription(await peer.createOffer());
    if (peer.iceGatheringState !== "complete") await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      peer.onicegatheringstatechange = () => {
        if (peer.iceGatheringState === "complete") { clearTimeout(timer); resolve(); }
      };
    });
    return peer.localDescription!.sdp;
  });
}

async function waitFor(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (failure) throw failure;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function start(): Promise<void> {
  const sdp = await offer();
  await rpc("thread/realtime/start", {
    threadId, realtimeSessionId: crypto.randomUUID(), version: "v3", outputModality: "audio",
    transport: { type: "webrtc", sdp }, clientManagedHandoffs: true,
    flushTranscriptTailOnSessionEnd: false, includeStartupContext: false, prompt: NATIVE_VOICE_PROMPTS.director,
  });
  await page.waitForFunction(() => window.cameraProbe.peer.connectionState === "connected", undefined, { timeout: 20_000 });
  if (failure) throw failure;
}

async function append(text: string, role: "developer" | "user"): Promise<void> {
  // This probe has one append in flight and no backend outputs. Counting wire
  // receipts here is deliberate; production must not correlate concurrent
  // appends this way because this legacy event carries no client event id.
  const before = await page.evaluate(() => window.cameraProbe.receipts);
  await rpc("thread/realtime/appendText", { threadId, text, role });
  await page.waitForFunction((count) => window.cameraProbe.receipts > count, before, { timeout: 20_000 });
  if (failure) throw failure;
}

async function ask(name: string, question: string, expected: RegExp[]): Promise<void> {
  phase = name;
  const before = transcripts.length;
  await append(question, "user");
  await waitFor(() => transcripts.length > before, `${name} answer`);
  const answer = transcripts.slice(before).map((row) => row.text).join(" ");
  for (const pattern of expected) assert.match(answer, pattern, `${name}: ${answer}`);
}

try {
  await rpc("initialize", { clientInfo: { name: "pwragent-camera-context-probe", version: "1" }, capabilities: { experimentalApi: true } });
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  const started = await rpc("thread/start", { cwd: workspace, ephemeral: true, approvalPolicy: "never", sandbox: "read-only", dynamicTools: [] }) as { thread: { id: string } };
  threadId = started.thread.id;
  await start();
  await append(cameraStatusText(true), "developer");
  await ask("enabled-waiting", "Is my camera enabled? Have any cues arrived in this session?", [/enabled|turned on|camera is on|cues are on/i, /waiting|no (?:confident|camera) (?:cue|observation)|none.*yet/i]);
  await append(cameraCueText("head_nod"), "developer");
  await ask("nod", "Did any camera cues arrive? What did you receive?", [/nod/i]);
  await append(cameraStatusText(false), "developer");
  await ask("disabled", "Is my camera enabled now? Are those observations current?", [/disabled|off/i, /earlier|previous|not current|historical|no longer/i]);
  await rpc("thread/realtime/stop", { threadId });
  await start();
  await ask("new-session", "What camera cues have you received since this voice session began?", [/no (?:camera |confident )?(?:cue|observation)|none|haven.t received|off|disabled/i]);
  console.log("PASS: enabled/waiting, nod recall, opt-out, and fresh-session isolation; wire context receipts observed.");
} finally {
  if (threadId) await rpc("thread/realtime/stop", { threadId }, 5000).catch(() => {});
  child.stdin.end();
  const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const timer = setTimeout(() => child.kill("SIGTERM"), 2500);
  if (child.exitCode === null) await stopped;
  clearTimeout(timer);
  lines.close();
  await browser.close();
  await rm(workspace, { recursive: true, force: true });
}
