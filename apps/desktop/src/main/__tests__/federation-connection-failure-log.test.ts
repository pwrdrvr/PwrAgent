import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import {
  CloudflareAccessRefusedError,
  CloudflareSignInRequiredError,
} from "../federation/cloudflare-access-oauth";

const logger = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../log")>();
  return {
    ...actual,
    getMainLogger: (scope: string) => scope === "pwragent:federation-runtime"
      ? logger
      : actual.getMainLogger(scope),
  };
});

vi.mock("../state/app-state", () => ({
  isAppStateInitialized: () => false,
}));

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: () => ({
    readFederationConfig: () => ({
      cloudflareAccessOAuthEnabled: true,
      cloudflareEndpoint: ENDPOINT,
    }),
  }),
}));

type FailureHarness = {
  stopping: boolean;
  parked: boolean;
  configuredEndpoints: string[];
  lastConnectionError?: string;
  lastConnectionFailureKind?: string;
  lastConnectedAt?: number;
  reconnectAttempt: number;
  connectClient(endpoint: string): Promise<void>;
  markEndpointConnected(endpoint: string): void;
  handleClientConnectionFailure(error: unknown): void;
  store(): { appendAudit: (entry: unknown) => void };
};

const ENDPOINT = "ws://192.0.2.1:47830";
const FAILURE = "Federation gateway is unreachable on every configured endpoint. "
  + `${ENDPOINT}: connect ECONNREFUSED 192.0.2.1:47830`;
const MINUTE_MS = 60_000;

describe("federation connection failure logging", () => {
  let runtime: DesktopFederationRuntime;
  let harness: FailureHarness;

  beforeEach(() => {
    vi.clearAllMocks();
    logger.warn.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    runtime = new DesktopFederationRuntime();
    harness = runtime as unknown as FailureHarness;
    harness.stopping = false;
    harness.configuredEndpoints = [ENDPOINT];
    vi.spyOn(harness, "store").mockReturnValue({ appendAudit: vi.fn() });
    vi.spyOn(harness, "connectClient").mockRejectedValue(new Error("connect ECONNREFUSED"));
  });

  afterEach(async () => {
    await runtime.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("logs three concise failures with the actual retry delay and next log interval", async () => {
    harness.handleClientConnectionFailure(new Error(FAILURE));
    await vi.advanceTimersToNextTimerAsync();
    await vi.advanceTimersToNextTimerAsync();

    expect(logger.warn.mock.calls).toEqual([
      ["Couldn't connect to federation gateway for 0s; retrying in 1s; logging again in 1s."],
      ["Couldn't connect to federation gateway for 1s; retrying in 2s; logging again in 2s."],
      ["Couldn't connect to federation gateway for 3s; retrying in 4s; logging again in 5m."],
    ]);
    expect(harness.lastConnectionError).toContain("ECONNREFUSED");
    expect(harness.lastConnectionFailureKind).toBe("transport");
  });

  it("spaces later logs by 5, 30, then 60 minutes while still retrying every minute", async () => {
    const warningTimes: number[] = [];
    logger.warn.mockImplementation(() => warningTimes.push(Date.now()));
    harness.handleClientConnectionFailure(new Error(FAILURE));
    await vi.advanceTimersByTimeAsync(4 * 60 * MINUTE_MS);

    expect(warningTimes).toEqual([0, 1_000, 3_000, 303_000, 2_103_000, 5_703_000, 9_303_000, 12_903_000]);
    expect(logger.warn.mock.calls.slice(3)).toEqual([
      ["Couldn't connect to federation gateway for 5m 3s; retrying every 1m; logging every 30m."],
      ["Couldn't connect to federation gateway for 35m 3s; retrying every 1m; logging every 60m."],
      ["Couldn't connect to federation gateway for 1h 35m; retrying every 1m; logging every 60m."],
      ["Couldn't connect to federation gateway for 2h 35m; retrying every 1m; logging every 60m."],
      ["Couldn't connect to federation gateway for 3h 35m; retrying every 1m; logging every 60m."],
    ]);
    // Suppressed warnings must not suppress dialing or detailed diagnostics.
    expect(harness.connectClient).toHaveBeenCalledTimes(244);
    expect(harness.lastConnectionError).toContain(ENDPOINT);
    expect(harness.store().appendAudit).toHaveBeenCalledTimes(245);
  });

  it("starts a fresh outage after a successful connection", async () => {
    harness.handleClientConnectionFailure(new Error(FAILURE));
    await vi.advanceTimersByTimeAsync(40 * MINUTE_MS);
    vi.mocked(harness.connectClient).mockImplementation(async (endpoint) => {
      harness.markEndpointConnected(endpoint);
    });
    await vi.advanceTimersToNextTimerAsync();
    logger.warn.mockClear();
    harness.handleClientConnectionFailure(new Error(FAILURE));

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      "Couldn't connect to federation gateway for 0s; retrying every 1m; logging again in 1m.",
    );
  });

  it("resets the log backoff when the runtime stops", async () => {
    harness.handleClientConnectionFailure(new Error(FAILURE));
    await vi.advanceTimersByTimeAsync(40 * MINUTE_MS);
    await runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
    harness.stopping = false;
    harness.configuredEndpoints = [ENDPOINT];
    logger.warn.mockClear();
    harness.handleClientConnectionFailure(new Error(FAILURE));

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      "Couldn't connect to federation gateway for 0s; retrying in 1s; logging again in 1s.",
    );
  });

  it.each([
    new CloudflareSignInRequiredError(),
    new CloudflareAccessRefusedError("fixture.invalid"),
  ])("retains the actionable warning when retries are parked: %s", (error) => {
    harness.handleClientConnectionFailure(error);

    expect(harness.parked).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      "federation client connection failed", { endpoints: 1, error: error.message },
    );
  });

  it("keeps the reason visible for an authentication failure that is still retried", () => {
    const error = new Error("Invalid federation auth challenge signature");
    harness.handleClientConnectionFailure(error);

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      "Couldn't connect to federation gateway for 0s; retrying in 1s; logging again in 1s.",
      { error: error.message },
    );
    expect(harness.parked).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each([
    { sessionAgeMs: 59_999, retry: "every 1m" },
    { sessionAgeMs: 60_000, retry: "in 1s" },
  ])("resets dialing backoff only after a durable session: $sessionAgeMs ms", ({ sessionAgeMs, retry }) => {
    vi.setSystemTime(120_000);
    harness.reconnectAttempt = 10;
    harness.lastConnectedAt = Date.now() - sessionAgeMs;
    harness.handleClientConnectionFailure(new Error(FAILURE));

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      `Couldn't connect to federation gateway for 0s; retrying ${retry}; logging again ${retry.replace("every", "in")}.`,
    );
  });

  it("does not log or retry after shutdown", () => {
    harness.stopping = true;
    harness.handleClientConnectionFailure(new Error(FAILURE));

    expect(logger.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
