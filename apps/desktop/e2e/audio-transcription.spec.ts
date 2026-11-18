import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

const THREAD_ID = "audio-transcription-fixture";
const THREAD_TITLE = "Kitchen recording";
const DRAFT = "Check the location described in this recording.";
const TRANSCRIPT = "The blue lantern is beside the kitchen window.";
const API_KEY = "fixture-transcription-project-key";
const RECORDING = fileURLToPath(new URL("./fixtures/audio-transcription.mp3", import.meta.url));
const OPENAI_URL = "https://api.openai.com/v1/audio/transcriptions";

test("transcribes a synthetic recording into an editable draft through the desktop IPC", async () => {
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
      { id: "start", kind: "response", method: "turn/start", result: { turnId: "transcript-turn" } },
    ],
  }));
  const requests: Array<{
    method?: string;
    path?: string;
    authorization?: string;
    model: FormDataEntryValue | null;
    format: FormDataEntryValue | null;
    fileName?: string;
    fileHash?: string;
  }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const form = await new Response(new Uint8Array(Buffer.concat(chunks)), {
        headers: { "content-type": request.headers["content-type"] ?? "" },
      }).formData();
      const file = form.get("file");
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        model: form.get("model"),
        format: form.get("response_format"),
        fileName: file instanceof File ? file.name : undefined,
        fileHash: file instanceof File
          ? createHash("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex")
          : undefined,
      });
      response.setHeader("Content-Type", "application/json");
      if (requests.length === 1) {
        response.writeHead(401).end(JSON.stringify({ error: { message: "Provider-private error fixture" } }));
        return;
      }
      response.end(JSON.stringify({ text: TRANSCRIPT }));
    })().catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture HTTP server has no port");
  let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  try {
    const desktop = app = await launchElectronApp({
      fixturePath,
      env: { PWRAGENT_E2E_MEMORY_SECRET_STORAGE: "1" },
    });
    const page = desktop.window;
    // Replace the native dialog and the single external destination. The app
    // still opens the selected file and makes a real multipart HTTP request.
    await desktop.electronApp.evaluate(({ dialog }, { path, upstream, local }) => {
      let pickCount = 0;
      const nativePicker = dialog.showOpenDialog.bind(dialog);
      dialog.showOpenDialog = async (
        ...args: [Electron.OpenDialogOptions] | [Electron.BaseWindow, Electron.OpenDialogOptions]
      ) => {
        if (args.length === 1) return await nativePicker(args[0]);
        if (args[1].title !== "Choose audio to send to OpenAI") return await nativePicker(...args);
        pickCount += 1;
        return pickCount === 1
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePaths: [path] };
      };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => await originalFetch(url === upstream ? local : url, init);
    }, {
      path: RECORDING,
      upstream: OPENAI_URL,
      local: `http://127.0.0.1:${address.port}/v1/audio/transcriptions`,
    });

    const thread = page.getByRole("button", { name: THREAD_TITLE, exact: true });
    const reply = page.getByRole("textbox", { name: "Reply", exact: true });
    const dialog = page.getByRole("dialog", { name: "Transcribe audio" });
    const choose = dialog.getByRole("button", { name: "Choose audio file…" });
    const openTranscription = async () => {
      await page.getByRole("button", { name: "Add reference", exact: true }).click();
      await page.getByRole("button", { name: "Transcribe audio…", exact: true }).click();
      await expect(dialog).toBeVisible();
    };

    await thread.click();
    await expect(reply).toBeEditable();
    await reply.fill(DRAFT);
    await openTranscription();
    await expect(dialog).toContainText("$0.0045 per minute ($0.27 per hour)");
    await dialog.screenshot({ path: testInfo.outputPath("audio-transcription-consent.png") });
    await choose.click();
    await expect(dialog.getByRole("alert")).toContainText("Settings → AI Providers → Audio transcription");
    expect(requests).toHaveLength(0);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();

    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "AI Providers", exact: true }).click();
    await page.getByRole("button", { name: /Audio transcription/ }).click();
    const settings = page.getByRole("region", { name: "Audio transcription settings" });
    const secret = settings.getByLabel("OpenAI project API key", { exact: true });
    await secret.fill(API_KEY);
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings.getByRole("button", { name: "Clear", exact: true })).toBeEnabled();
    await expect(secret).toHaveValue("");
    await page.getByRole("button", { name: "Exit Settings", exact: true }).click();
    await expect(reply).toHaveText(DRAFT);

    await openTranscription();
    await choose.click();
    await expect(choose).toBeEnabled();
    expect(requests).toHaveLength(0);
    await choose.click();
    await expect(dialog.getByRole("alert")).toContainText("OpenAI refused the transcription API key");
    await expect(dialog).not.toContainText("Provider-private error fixture");
    await expect(reply).toHaveText(DRAFT);
    await choose.click();
    await expect(dialog.getByText(TRANSCRIPT, { exact: true })).toBeVisible();
    const expectedRequest = {
      method: "POST",
      path: "/v1/audio/transcriptions",
      authorization: `Bearer ${API_KEY}`,
      model: "gpt-transcribe",
      format: "json",
      fileName: "recording.mp3",
      fileHash: createHash("sha256").update(await readFile(RECORDING)).digest("hex"),
    };
    expect(requests).toEqual([expectedRequest, expectedRequest]);
    await expect(reply).toHaveText(DRAFT);
    expect(await desktop.getLastStartTurn()).toBeFalsy();
    await dialog.screenshot({ path: testInfo.outputPath("audio-transcription-preview.png") });

    await dialog.getByRole("button", { name: "Add to draft", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(reply.locator("p")).toHaveText([DRAFT, TRANSCRIPT]);
    await expect(reply).toBeEditable();
    expect(await desktop.getLastStartTurn()).toBeFalsy();
  } finally {
    try {
      await app?.close();
    } finally {
      server.close();
    }
  }
});
