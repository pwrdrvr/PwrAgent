import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DesktopApplicationsSnapshot } from "@pwragent/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  resetDecodedApplicationIconsForTests,
  withApplicationIcons,
} from "../settings/application-discovery";
import {
  FAKE_APPLICATION_ID,
  REAL_APPLICATION_PATH,
  installFakeApplicationBundle,
} from "./helpers/fake-application-bundle";

const { createFromBuffer } = vi.hoisted(() => ({
  createFromBuffer: vi.fn(async (buffer: Buffer) => ({
    isEmpty: () => false,
    resize: () => ({ toDataURL: () => `data:image/png;base64,${buffer.toString("base64")}` }),
  })),
}));

vi.mock("../owner-host", async (importOriginal) => ({
  ...await importOriginal<typeof import("../owner-host")>(),
  imageCodec: { createFromBuffer },
}));

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-application-icons-"));
  resetDecodedApplicationIconsForTests();
  createFromBuffer.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tempDir, { recursive: true, force: true });
});

function bundleWithIcon(name: string, bytes: string): { appPath: string; iconPath: string } {
  const appPath = path.join(tempDir, `${name}.app`);
  const resources = path.join(appPath, "Contents", "Resources");
  mkdirSync(resources, { recursive: true });
  const iconPath = path.join(resources, "AppIcon.icns");
  writeFileSync(iconPath, bytes);
  return { appPath, iconPath };
}

function snapshotOf(appPath: string): DesktopApplicationsSnapshot {
  return {
    editors: [{ id: "editor", kind: "editor", name: "Editor", source: "application", appPath, canOpenWorkspace: true }],
    terminals: [],
    preferredEditorId: { value: "", source: "default" },
    preferredTerminalId: { value: "", source: "default" },
    gh: { enabled: { value: false, source: "default" }, path: { value: "", source: "default" }, discovery: { candidates: [] } },
    git: { path: { value: "", source: "default" }, discovery: { candidates: [] } },
  };
}

it("discovery decodes no icon, on any host", async () => {
  // Discovery also looks in ~/Applications, so a fake home gives every host,
  // Linux CI included, a bundle with a decodable icon to discover. A Mac
  // with the real app in /Applications discovers that one first, and its
  // icon decodes too.
  const home = path.join(tempDir, "home");
  const { appPath } = installFakeApplicationBundle(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  // The known applications are built from os.homedir() when the module loads.
  vi.resetModules();
  const discovery = await import("../settings/application-discovery");

  const snapshot = await discovery.discoverDesktopApplications();
  const discovered = snapshot.editors.find((candidate) => candidate.id === FAKE_APPLICATION_ID);
  expect([appPath, REAL_APPLICATION_PATH]).toContain(discovered?.appPath);
  expect(createFromBuffer).not.toHaveBeenCalled();
  for (const candidate of [...snapshot.editors, ...snapshot.terminals]) {
    expect(candidate.iconDataUrl).toBeUndefined();
  }

  // The bundle's icon does decode once a surface asks, so the zero above is
  // discovery declining to decode, not an icon nothing could decode.
  const withIcons = await discovery.withApplicationIcons(snapshot);
  expect(createFromBuffer).toHaveBeenCalled();
  expect(withIcons.editors.find((candidate) => candidate.id === FAKE_APPLICATION_ID)?.iconDataUrl)
    .toMatch(/^data:image\/png;base64,/);
});

it("decodes an icon once per icon file version, on the read that asks for it", async () => {
  const { appPath, iconPath } = bundleWithIcon("Editor", "first");
  const snapshot = snapshotOf(appPath);

  const first = await withApplicationIcons(snapshot);
  const again = await withApplicationIcons(snapshot);
  expect(createFromBuffer).toHaveBeenCalledTimes(1);
  expect(first.editors[0]?.iconDataUrl).toBe(`data:image/png;base64,${Buffer.from("first").toString("base64")}`);
  expect(again.editors[0]?.iconDataUrl).toBe(first.editors[0]?.iconDataUrl);
  // The discovered snapshot is left as discovery produced it.
  expect(snapshot.editors[0]?.iconDataUrl).toBeUndefined();

  // An updated bundle replaces its icon file; the next read decodes it.
  writeFileSync(iconPath, "second!");
  utimesSync(iconPath, new Date(2030, 0, 1), new Date(2030, 0, 1));
  const updated = await withApplicationIcons(snapshot);
  expect(createFromBuffer).toHaveBeenCalledTimes(2);
  expect(updated.editors[0]?.iconDataUrl).toBe(`data:image/png;base64,${Buffer.from("second!").toString("base64")}`);
});

it("concurrent reads share one decode", async () => {
  const { appPath } = bundleWithIcon("Editor", "icon");
  const snapshot = snapshotOf(appPath);
  await Promise.all([withApplicationIcons(snapshot), withApplicationIcons(snapshot)]);
  expect(createFromBuffer).toHaveBeenCalledTimes(1);
});
