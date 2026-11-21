import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { DictationApi } from "../src/shared/audio-transcription";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

const THREAD_ID = "audio-transcription-fixture";
const THREAD_TITLE = "Composer dictation";
const DRAFT = "Keep this original draft.";
const PARTIAL = "The blue lantern";
const TRANSCRIPT = "The blue lantern is beside the kitchen window.";
const API_KEY = "fixture-transcription-project-key";
const RECORDING = fileURLToPath(new URL("./fixtures/audio-transcription.mp3", import.meta.url));
const OPENAI_URL = "wss://api.openai.com/v1/realtime?intent=transcription";

test("dictates synthetic microphone audio into the draft without a Codex turn", async () => {
  const testInfo = test.info();
  const fixturePath = testInfo.outputPath("replay.fixture.json");
  await writeFile(fixturePath, JSON.stringify({
    metadata: { backend: "codex", scenario: "audio-transcription" },
    steps: [
      { id: "init", kind: "response", method: "initialize", result: {
        serverInfo: { name: "Replay Codex", version: "1.0.0" },
        methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
      } },
      { id: "list", kind: "response", method: "thread/list", result: [{
        id: THREAD_ID, title: THREAD_TITLE, titleSource: "explicit", source: "codex",
        summary: THREAD_TITLE, executionMode: "default", linkedDirectories: [],
        inbox: { inInbox: true }, updatedAt: 1_791_600_000_000,
      }] },
      { id: "read", kind: "response", method: "thread/read", result: {
        entries: [], messages: [], threadStatus: "idle",
        pagination: { supportsPagination: false, hasPreviousPage: false },
      } },
      { id: "skills", kind: "response", method: "skills/list", result: { data: [] } },
    ],
  }));
  const app = await launchElectronApp({ fixturePath, secretStorage: "memory" });
  try {
    const page = app.window;
    // Substitute only OpenAI's socket. Chromium still runs the AudioWorklet,
    // and the audio and transcript events travel through the actual preload.
    const connection = await app.electronApp.evaluateHandle((_electron, args) => {
      const wire = {
        started: 0,
        closed: 0,
        committed: 0,
        bytes: 0,
        matchedKey: false,
        nonSilent: false,
        configuration: undefined as unknown,
        unexpected: [] as string[],
      };
      const Original = globalThis.WebSocket;
      class RealtimeFixture extends EventTarget {
        readyState: number = Original.OPEN;
        bufferedAmount = 0;
        constructor(options?: { headers?: HeadersInit }) {
          super();
          wire.started++;
          wire.matchedKey = new Headers(options?.headers).get("Authorization") === `Bearer ${args.key}`;
          queueMicrotask(() => this.dispatchEvent(new Event("open")));
        }
        receive(value: object) {
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
        }
        send(raw: string) {
          const event = JSON.parse(raw);
          if (event.type === "session.update") {
            wire.configuration = event.session;
            this.receive({ type: "session.updated", session: { type: "transcription" } });
          } else if (event.type === "input_audio_buffer.append") {
            const pcm = Buffer.from(event.audio, "base64");
            wire.bytes += pcm.length;
            if (!wire.nonSilent && pcm.some((byte) => byte !== 0)) {
              wire.nonSilent = true;
              this.receive({ type: "conversation.item.input_audio_transcription.delta", item_id: "audio", delta: args.partial });
            }
          } else if (event.type === "input_audio_buffer.commit") {
            wire.committed++;
            this.receive({ type: "input_audio_buffer.committed", item_id: "audio" });
            this.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "audio", transcript: args.final });
          } else {
            wire.unexpected.push(event.type);
          }
        }
        close() {
          this.readyState = Original.CLOSED;
          wire.closed++;
        }
      }
      globalThis.WebSocket = new Proxy(Original, {
        construct(target, parameters) {
          if (parameters[0] === args.upstream) return new RealtimeFixture(parameters[1]);
          return Reflect.construct(target, parameters);
        },
      });
      return wire;
    }, { upstream: OPENAI_URL, key: API_KEY, partial: PARTIAL, final: TRANSCRIPT });

    await page.evaluate(async (encoded) => {
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const context = new AudioContext();
      const buffer = await context.decodeAudioData(bytes.buffer);
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        value: async (): Promise<MediaStream> => {
          const destination = context.createMediaStreamDestination();
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(destination);
          await context.resume();
          source.start(context.currentTime + 0.5);
          return destination.stream;
        },
      });
    }, (await readFile(RECORDING)).toString("base64"));

    await page.getByRole("button", { name: THREAD_TITLE, exact: true }).click();
    const reply = page.getByRole("textbox", { name: "Reply", exact: true });
    const start = page.getByRole("button", { name: "Dictate with OpenAI", exact: true });
    await expect(reply).toBeEditable();
    await reply.fill(DRAFT);
    await expect(start).toHaveCount(0);
    expect((await connection.jsonValue()).started).toBe(0);

    const openTranscriptionSettings = async (status: string) => {
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
      await page.getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "AI Providers", exact: true }).click();
      const detail = page.getByRole("button", { name: "Open Audio transcription settings", exact: true });
      await expect(detail).toHaveText(new RegExp(status));
      await detail.click();
    };
    const exitSettings = page.getByRole("button", { name: "Exit Settings", exact: true });
    await openTranscriptionSettings("No API key");
    const settings = page.getByRole("region", { name: "Audio transcription settings" });
    const enabled = settings.getByRole("switch", { name: "Enabled — Audio transcription" });
    const clear = settings.getByRole("button", { name: "Remove saved OpenAI project API key", exact: true });
    const savedKey = settings.getByText(/aved in keychain$/);
    await expect(settings).toContainText("$0.017 per minute ($1.02 per hour)");
    const secret = settings.getByLabel("OpenAI project API key", { exact: true });
    await secret.fill(API_KEY);
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(secret).toHaveValue("");
    await expect(savedKey).toBeVisible();
    await expect(enabled).toBeChecked();
    await exitSettings.click();
    await expect(start).toBeEnabled();

    await openTranscriptionSettings("Enabled");
    await enabled.click();
    await expect(enabled).not.toBeChecked();
    await expect(savedKey).toBeVisible();
    await expect(clear).toBeEnabled();
    await exitSettings.click();
    await expect(start).toHaveCount(0);
    await expect(page.evaluate(() => {
      const bridge = (window as Window & { pwragent?: { dictation: DictationApi } }).pwragent;
      if (!bridge) throw new Error("Missing PwrAgent preload bridge");
      return bridge.dictation.start("disabled-dictation");
    })).rejects.toThrow("Audio transcription is turned off");
    expect((await connection.jsonValue()).started).toBe(0);

    await openTranscriptionSettings("Disabled");
    await expect(enabled).not.toBeChecked();
    await expect(savedKey).toBeVisible();
    await enabled.click();
    await expect(enabled).toBeChecked();
    await exitSettings.click();
    await expect(reply).toHaveText(DRAFT);

    await start.click();
    await expect(page.getByRole("button", { name: "Stop dictation", exact: true })).toBeVisible();
    await expect(page.getByLabel("Live transcript")).toHaveText(PARTIAL);
    await expect(reply).toHaveText(DRAFT);
    await expect.poll(async () => (await connection.jsonValue()).bytes).toBeGreaterThan(48_000);
    expect(await app.getLastStartTurn()).toBeFalsy();
    await reply.locator("xpath=ancestor::form[1]").screenshot({ path: testInfo.outputPath("composer-dictating.png") });

    await page.getByRole("button", { name: "Stop dictation", exact: true }).click();
    await expect(reply.locator("p")).toHaveText([DRAFT, TRANSCRIPT]);
    await expect(reply).toBeEditable();
    expect(await app.getLastStartTurn()).toBeFalsy();
    expect(await connection.jsonValue()).toMatchObject({
      started: 1,
      committed: 1,
      matchedKey: true,
      nonSilent: true,
      configuration: {
        type: "transcription",
        audio: { input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "gpt-live-transcribe" }, turn_detection: null } },
      },
      unexpected: [],
    });
    await reply.locator("xpath=ancestor::form[1]").screenshot({ path: testInfo.outputPath("composer-dictated.png") });

    for (const [open, exit] of [
      ["Open settings", "Exit Settings"],
      ["Open automations", "Exit Automations"],
    ]) {
      const before = await connection.jsonValue();
      await start.click();
      await expect(page.getByRole("button", { name: "Stop dictation", exact: true })).toBeVisible();
      await expect.poll(async () => (await connection.jsonValue()).bytes).toBeGreaterThan(before.bytes);
      await page.getByRole("button", { name: open, exact: true }).first().click();
      await expect(page.locator(".app-main")).toHaveAttribute("inert", "");
      await expect.poll(async () => (await connection.jsonValue()).closed).toBe(before.closed + 1);
      expect((await connection.jsonValue()).committed).toBe(before.committed);

      await page.getByRole("button", { name: exit, exact: true }).click();
      await expect(start).toBeEnabled();
      await expect(reply.locator("p")).toHaveText([DRAFT, TRANSCRIPT]);
    }
  } finally {
    await app.close();
  }
});
