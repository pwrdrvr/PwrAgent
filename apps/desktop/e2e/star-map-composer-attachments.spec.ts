import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { startInProcessFederationGateway } from "./fixtures/federation-gateway";
import { openStarMapWindow } from "./fixtures/star-map-window";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(
  specDir,
  "fixtures/star-map/replay.fixture.json",
);
const LOCAL_THREAD_TITLE = "Star map attention thread";
const REMOTE_THREAD_TITLE = "Remote attachment thread";

type StartTurnInputItem = {
  mimeType?: string;
  name?: string;
  path?: string;
  text?: string;
  textPreview?: string;
  type: string;
};

type StartTurnRequest = {
  input: StartTurnInputItem[];
  threadId: string;
};

async function openChatCard(
  mapWindow: Page,
  title: string,
): Promise<Locator> {
  const starMap = mapWindow.getByRole("region", {
    name: "Star Map",
    exact: true,
  });
  await expect(starMap).toBeVisible();
  const threadCard = starMap.getByRole("button", {
    name: `Open thread: ${title}`,
  });
  await expect(threadCard).toBeVisible({ timeout: 30_000 });
  await threadCard.click();

  const chatCard = mapWindow.getByRole("region", {
    name: `Chat: ${title}`,
  });
  await expect(chatCard).toBeVisible();
  return chatCard;
}

async function attachPng(
  messageInput: Locator,
  options: { color: string; event: "drop" | "paste"; name: string },
): Promise<void> {
  await messageInput.evaluate(async (input, params) => {
    const canvas = document.createElement("canvas");
    canvas.width = 24;
    canvas.height = 16;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas context not available");
    context.fillStyle = params.color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (value) resolve(value);
        else reject(new Error("Could not create PNG blob"));
      }, "image/png");
    });
    const file = new File([blob], params.name, { type: "image/png" });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    input.dispatchEvent(
      params.event === "paste"
        ? new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: dataTransfer,
          })
        : new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer,
          }),
    );
  }, options);
}

async function attachFilesystemFile(
  mapWindow: Page,
  messageInput: Locator,
  localPath: string,
): Promise<void> {
  await mapWindow.evaluate(() => {
    const fileInput = document.createElement("input");
    fileInput.id = "star-map-e2e-file-input";
    fileInput.type = "file";
    document.body.append(fileInput);
  });
  const fileInput = mapWindow.locator("#star-map-e2e-file-input");
  await fileInput.setInputFiles(localPath);
  await messageInput.evaluate((input) => {
    const file = document.querySelector<HTMLInputElement>(
      "#star-map-e2e-file-input",
    )?.files?.[0];
    if (!file) throw new Error("Filesystem-backed test file was not selected");
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    input.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }),
    );
  });
}

test("sends pasted, dropped, and local-file attachments from a Star Map chat card", async () => {
  test.slow();
  const fileRoot = await mkdtemp(
    path.join(os.tmpdir(), "pwragent-star-map-attachments-"),
  );
  const notesPath = path.join(fileRoot, "star-map-notes.txt");
  await writeFile(notesPath, "renderer preload attachment evidence\n", "utf8");
  const app = await launchElectronApp({ fixturePath });

  try {
    const mapWindow = await openStarMapWindow(app);
    const chatCard = await openChatCard(mapWindow, LOCAL_THREAD_TITLE);
    const messageInput = chatCard.getByRole("textbox", {
      name: `Message ${LOCAL_THREAD_TITLE}`,
    });

    await attachPng(messageInput, {
      color: "#2255aa",
      event: "paste",
      name: "pasted-star-map.png",
    });
    const pastedPreview = chatCard.getByRole("img", {
      name: "pasted-star-map.png",
    });
    await expect(pastedPreview).toBeVisible();
    await expect(pastedPreview).toHaveAttribute("src", /^data:image\/png;base64,/);

    await attachPng(messageInput, {
      color: "#aa5522",
      event: "drop",
      name: "dropped-star-map.png",
    });
    const droppedPreview = chatCard.getByRole("img", {
      name: "dropped-star-map.png",
    });
    await expect(droppedPreview).toBeVisible();
    await expect(droppedPreview).toHaveAttribute("src", /^data:image\/png;base64,/);

    await attachFilesystemFile(mapWindow, messageInput, notesPath);
    await expect(
      chatCard.locator('[aria-label="Attached files"]'),
    ).toContainText("star-map-notes.txt");

    await messageInput.fill("Inspect these Star Map attachments");
    await chatCard.getByRole("button", { name: "Send" }).click();

    await expect.poll(async () => await app.getLastStartTurn()).not.toBeNull();
    const request = await app.getLastStartTurn() as StartTurnRequest;
    expect(request.threadId).toBe("thread-star-map-active");

    const textInput = request.input.find((item) => item.type === "text");
    expect(textInput?.text).toContain("Inspect these Star Map attachments");
    expect(textInput?.text).toContain(`[@star-map-notes.txt](${notesPath})`);

    const imageInputs = request.input.filter(
      (item) => item.type === "localImage",
    );
    expect(imageInputs.map((item) => item.name)).toEqual([
      "pasted-star-map.png",
      "dropped-star-map.png",
    ]);
    for (const imageInput of imageInputs) {
      expect(imageInput.path).toBeTruthy();
      const imageBytes = await readFile(imageInput.path!);
      expect(imageBytes.subarray(0, 8).toString("hex")).toBe(
        "89504e470d0a1a0a",
      );
    }

    const localFileInput = request.input.find(
      (item) => item.type === "localFile",
    );
    expect(localFileInput).toEqual(
      expect.objectContaining({
        mimeType: "text/plain",
        name: "star-map-notes.txt",
        path: notesPath,
        textPreview: "renderer preload attachment evidence\n",
        type: "localFile",
      }),
    );
  } finally {
    await app.close();
    await rm(fileRoot, { recursive: true, force: true });
  }
});

test("rejects a local file on a remote Star Map chat card", async () => {
  test.slow();
  const fileRoot = await mkdtemp(
    path.join(os.tmpdir(), "pwragent-star-map-remote-attachment-"),
  );
  const notesPath = path.join(fileRoot, "remote-notes.txt");
  await writeFile(notesPath, "must remain local\n", "utf8");
  const gateway = await startInProcessFederationGateway({
    threads: [
      {
        id: "remote-attachment-thread",
        title: REMOTE_THREAD_TITLE,
        threadStatus: "active",
        updatedAt: Date.now(),
      },
    ],
  });
  const app = await launchElectronApp({
    fixturePath,
    secretStorage: "memory",
  });

  try {
    await app.window.getByRole("button", { name: "Open settings" }).click();
    await app.window
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Federation" })
      .click();
    await app.window.getByLabel("Import invite").fill(gateway.invite);
    await app.window.getByRole("button", { name: "Import invite" }).click();
    await gateway.waitForConnection(30_000);
    await expect(
      app.window
        .getByRole("region", { name: "Connection" })
        .getByText("Connected", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await app.window.getByRole("button", { name: "Exit Settings" }).click();

    const mapWindow = await openStarMapWindow(app);
    const chatCard = await openChatCard(mapWindow, REMOTE_THREAD_TITLE);
    const messageInput = chatCard.getByRole("textbox", {
      name: `Message ${REMOTE_THREAD_TITLE}`,
    });
    await attachFilesystemFile(mapWindow, messageInput, notesPath);

    await expect(chatCard.getByRole("alert")).toContainText(
      "Local files cannot be attached to a thread on another instance.",
    );
    await expect(
      chatCard.locator('[aria-label="Attached files"]'),
    ).toHaveCount(0);
    await expect(chatCard.locator(".compact-composer__send")).toBeDisabled();
  } finally {
    await app.close();
    await gateway.close();
    await rm(fileRoot, { recursive: true, force: true });
  }
});
