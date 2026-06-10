import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ErrorListener = (error: Error) => void;

const mocks = vi.hoisted(() => {
  const consoleWriteFn = vi.fn();
  const consoleTransport = Object.assign(vi.fn(), {
    level: "silly" as string | false,
    writeFn: consoleWriteFn,
  });

  const fileTransport = Object.assign(vi.fn(), {
    fileName: "",
    level: "silly" as string | false,
    getFile: vi.fn(() => ({ path: "/tmp/profile-default.main.log" })),
  });

  const scope = Object.assign(vi.fn(), {
    labelPadding: true,
  });

  return {
    consoleTransport,
    consoleWriteFn,
    electronLog: {
      hooks: [] as unknown[],
      initialize: vi.fn(),
      scope,
      transports: {
        console: consoleTransport,
        file: fileTransport,
      },
    },
    fileTransport,
    scope,
  };
});

vi.mock("electron-log/main.js", () => ({
  default: mocks.electronLog,
}));

vi.mock("../app-logs", () => ({
  appendAppLogEntry: vi.fn(),
}));

function makeBrokenPipeError(): Error & { code: string } {
  return Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
}

function makeMessage() {
  return {
    data: ["hello"],
    date: new Date("2026-06-10T00:00:00.000Z"),
    level: "info",
  };
}

describe("initializeMainLogger stdio handling", () => {
  let stdoutErrorListeners: ErrorListener[];
  let stderrErrorListeners: ErrorListener[];

  beforeEach(() => {
    stdoutErrorListeners = process.stdout.listeners("error") as ErrorListener[];
    stderrErrorListeners = process.stderr.listeners("error") as ErrorListener[];
    vi.resetModules();
    mocks.electronLog.hooks = [];
    mocks.electronLog.initialize.mockClear();
    mocks.scope.mockClear();
    mocks.scope.labelPadding = true;
    mocks.consoleWriteFn.mockReset();
    mocks.consoleTransport.level = "silly";
    mocks.consoleTransport.writeFn = mocks.consoleWriteFn;
    mocks.fileTransport.fileName = "";
    mocks.fileTransport.level = "silly";
    mocks.fileTransport.getFile.mockClear();
  });

  afterEach(() => {
    for (const listener of process.stdout.listeners("error") as ErrorListener[]) {
      if (!stdoutErrorListeners.includes(listener)) {
        process.stdout.off("error", listener);
      }
    }

    for (const listener of process.stderr.listeners("error") as ErrorListener[]) {
      if (!stderrErrorListeners.includes(listener)) {
        process.stderr.off("error", listener);
      }
    }
  });

  it("disables console logging when the console transport hits a broken stdout pipe", async () => {
    mocks.consoleWriteFn.mockImplementation(() => {
      throw makeBrokenPipeError();
    });

    const { initializeMainLogger } = await import("../log");
    initializeMainLogger();

    mocks.consoleTransport.level = "silly";

    expect(() => mocks.consoleTransport.writeFn(makeMessage())).not.toThrow();
    expect(mocks.consoleWriteFn).toHaveBeenCalledTimes(1);
    expect(mocks.consoleTransport.level).toBe(false);

    mocks.consoleTransport.writeFn(makeMessage());
    expect(mocks.consoleWriteFn).toHaveBeenCalledTimes(1);
  });

  it("disables console logging when stdout emits an asynchronous broken-pipe error", async () => {
    const { initializeMainLogger } = await import("../log");
    initializeMainLogger();

    mocks.consoleTransport.level = "silly";

    expect(() => process.stdout.emit("error", makeBrokenPipeError())).not.toThrow();
    expect(mocks.consoleTransport.level).toBe(false);
  });

  it("keeps file logging configured when console logging is disabled", async () => {
    const { initializeMainLogger } = await import("../log");
    initializeMainLogger();

    process.stderr.emit("error", makeBrokenPipeError());

    expect(mocks.consoleTransport.level).toBe(false);
    expect(mocks.fileTransport.level).toBe("info");
    expect(mocks.electronLog.initialize).toHaveBeenCalledTimes(1);
  });
});
