import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

test("reopens its selected chat, disclosed projects and loaded rows in a new process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-navigation-resume-"));
  const fixture = JSON.parse(await readFile(path.join(import.meta.dirname, "fixtures/a11y-directories/replay.fixture.json"), "utf8"));
  const listing = fixture.steps.find((step: { method?: string }) => step.method === "thread/list");
  const secondary = listing.result.at(-1);
  listing.result.push({ ...secondary, id: "third-project-thread", title: "Third project thread",
    linkedDirectories: [{ id: "third-project", kind: "local", label: "PwrGit", path: "/repo/PwrGit" }] });
  const fixturePath = path.join(root, "replay.fixture.json");
  await writeFile(fixturePath, JSON.stringify(fixture));
  const first = await launchElectronApp({ fixturePath });
  let second: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  try {
    await expect(first.window.getByRole("heading", { level: 2, name: "Directories lens thread 01" })).toBeVisible();
    await first.window.getByRole("tab", { name: "Directories", exact: true }).click();
    const project = first.window.locator(".directory-row").filter({ has: first.window.getByRole("button", { name: /^PwrAgent(,|$)/ }) });
    await project.getByRole("button", { name: /Load more threads/ }).click();
    await first.window.getByRole("button", { name: /Directories lens thread 13/ }).first().click();
    await expect(first.window.getByRole("heading", { level: 2, name: "Directories lens thread 13" })).toBeVisible();
    await first.window.getByRole("button", { name: /^PwrSnap(,|$)/ }).click();
    const firstPid = await first.electronApp.evaluate(() => process.pid);
    // Close the process, retaining only its isolated profile. The fixture's
    // ordinary close() also deletes that profile, so defer it to finally.
    await first.closeApplication();
    second = await launchElectronApp({ fixturePath, homeRoot: first.homeRoot });
    expect(await second.electronApp.evaluate(() => process.pid)).not.toBe(firstPid);
    await expect(second.window.getByRole("tab", { name: "Directories", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(second.window.getByRole("heading", { level: 2, name: "Directories lens thread 13" })).toBeVisible();
    await expect(second.window.getByRole("button", { name: /^PwrAgent(,|$)/ })).toHaveAttribute("aria-expanded", "true");
    await expect(second.window.getByRole("button", { name: /^PwrSnap(,|$)/ })).toHaveAttribute("aria-expanded", "true");
    await expect(second.window.getByRole("button", { name: /^PwrGit(,|$)/ })).toHaveAttribute("aria-expanded", "false");
    // An unselected row past page one proves this restored pagination rather
    // than merely presenting the selected chat through its exact lookup.
    await expect(second.window.getByRole("button", { name: /Directories lens thread 12/ }).first()).toBeVisible();
  } finally {
    await second?.close();
    await first.close();
    await rm(root, { recursive: true, force: true });
  }
});
