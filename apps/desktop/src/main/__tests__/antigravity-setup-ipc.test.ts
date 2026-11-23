import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { AntigravitySetupRequest, AntigravitySetupResult } from "../../shared/antigravity-setup";
import { registerAntigravitySetupIpc } from "../shell/ipc/antigravity-setup";

type Sender = { sender: EventEmitter; senderFrame: { parent: null } };
type Handler = (event: Sender, request: AntigravitySetupRequest) => Promise<AntigravitySetupResult>;

const mock = vi.hoisted(() => ({
  handle: vi.fn<(channel: string, handler: Handler) => void>(),
  start: vi.fn(),
  install: vi.fn(),
  read: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: mock.handle, removeHandler: vi.fn() },
  shell: { openExternal: vi.fn() },
  clipboard: { writeText: vi.fn() },
}));
vi.mock("../acp/antigravity-sign-in", () => ({
  AntigravitySignIn: class { start = mock.start; },
  ANTIGRAVITY_SIGN_IN_TIMEOUT_MS: 300_000,
}));
vi.mock("../acp/antigravity-managed-runtime", () => ({
  installManagedAntigravityRuntime: mock.install,
  readManagedAntigravityStatus: mock.read,
}));

afterEach(() => vi.resetAllMocks());

const owner = (): Sender => ({ sender: new EventEmitter(), senderFrame: { parent: null } });
const attemptId = "99999999-9999-4999-9999-999999999999";
const launch = { backendId: "acp:antigravity" as const, command: "/example/agy",
  args: ["acp"], env: {}, distributionKind: "local" as const, registryId: "antigravity" };

it("keeps managed installation passive until requested, then refreshes only local paths", async () => {
  const refresh = vi.fn(async () => launch);
  const dispose = registerAntigravitySetupIpc({ refresh });
  try {
    const call = mock.handle.mock.calls[0]![1];
    const runtime = { command: launch.command, version: "1.5.14" };
    mock.read.mockResolvedValue({ status: "not-installed" });
    mock.install.mockResolvedValue(runtime);
    await expect(call(owner(), { action: "read" })).resolves.toEqual({ ok: true, runtime: { status: "not-installed" } });
    expect(mock.install).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    await expect(call(owner(), { action: "install" })).resolves.toEqual({ ok: true, runtime: { status: "installed", runtime } });
    expect(refresh.mock.calls).toEqual([[false]]);
  } finally {
    dispose();
  }
});

it("only accepts a code from the window that started the attempt and refreshes models after verification", async () => {
  const refresh = vi.fn(async () => launch);
  const dispose = registerAntigravitySetupIpc({ refresh });
  try {
    const call = mock.handle.mock.calls[0]![1];
    const initiator = owner();
    const verification = Promise.withResolvers<void>();
    const submitCode = vi.fn();
    mock.start.mockReturnValue({ ready: Promise.resolve(), completed: verification.promise, submitCode });
    await expect(call(initiator, { action: "start", attemptId })).resolves.toMatchObject({ ok: true });
    const finished = call(initiator, { action: "wait", attemptId });
    await expect(call(owner(), { action: "submit", attemptId, code: "contrived" })).resolves.toMatchObject({ ok: false });
    expect(submitCode).not.toHaveBeenCalled();
    await expect(call(initiator, { action: "submit", attemptId, code: "contrived" })).resolves.toEqual({ ok: true });
    expect(submitCode).toHaveBeenCalledExactlyOnceWith("contrived");
    expect(refresh.mock.calls).toEqual([[false]]);
    verification.resolve();
    await expect(finished).resolves.toEqual({ ok: true, verifiedCommand: launch.command });
    expect(refresh.mock.calls).toEqual([[false], [true]]);
    expect(initiator.sender.listenerCount("destroyed")).toBe(0);
  } finally {
    dispose();
  }
});
