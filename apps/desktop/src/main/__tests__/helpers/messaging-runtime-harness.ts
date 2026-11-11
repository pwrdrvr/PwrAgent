import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { MessagingBackendBridge } from "../../messaging/core/messaging-adapter";
import type { DesktopMessagingConfig } from "../../messaging/messaging-config";

// Shared setup for tests that drive the real DesktopMessagingRuntime with fake
// adapters. Each test file still declares its own `vi.mock` calls (log, state
// migration, an in-memory state.db), because vitest hoists them per file.

export function createBackendBridge(): MessagingBackendBridge {
  return {
    getNavigationSnapshot: vi.fn(async () => {
      throw new Error("not used");
    }),
    onEvent: () => () => {},
  } as unknown as MessagingBackendBridge;
}

export function telegramConfig(inputDebounceMs: number): DesktopMessagingConfig {
  return {
    inputDebounceMs,
    telegram: {
      channel: "telegram",
      botToken: "telegram-token",
      authorizedActorIds: [{ id: "user-1", displayName: "" }],
    },
  } as DesktopMessagingConfig;
}

const tempDirs: string[] = [];

/** A fresh PwrAgent root, app state and messaging store for one case. */
export async function prepareMessagingRuntimeStore(prefix: string): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  vi.stubEnv("PWRAGENT_HOME", tempDir);
  const { initializeAppState, resetAppStateForTests } = await import(
    "../../state/app-state"
  );
  resetAppStateForTests();
  initializeAppState();
  const { resetDesktopMessagingStoreForTests } = await import(
    "../../messaging/desktop-messaging-store"
  );
  resetDesktopMessagingStoreForTests();
}

export async function initializeFederationForMessagingTests(): Promise<void> {
  const { initializeDesktopFederationRuntime } = await import(
    "../../federation/federation-runtime"
  );
  initializeDesktopFederationRuntime();
}

export async function cleanupMessagingRuntimeStores(): Promise<void> {
  vi.useRealTimers();
  const { resetAppStateForTests } = await import("../../state/app-state");
  resetAppStateForTests();
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs.splice(0).map(async (tempDir) => {
      await rm(tempDir, { recursive: true, force: true });
    }),
  );
}
