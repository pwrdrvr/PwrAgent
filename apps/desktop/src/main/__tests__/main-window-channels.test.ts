import { describe, expect, it } from "vitest";
import {
  AGENT_EVENT_CHANNEL,
  CODEX_RESTART_STATUS_CHANGED_EVENT_CHANNEL,
  HOT_CPU_PROFILE_CAPTURED_EVENT_CHANNEL,
  OPERATOR_REQUESTS_CHANGED_EVENT_CHANNEL,
  PWRSUITE_INSTALLER_EVENT_CHANNEL,
  THREAD_ARCHIVE_SWEEP_STATUS_CHANGED_EVENT_CHANNEL,
  THREAD_TODOS_CHANGED_EVENT_CHANNEL,
} from "../../shared/ipc";
import { mainWindowEventChannels } from "../main-window-channels";

const viewer = mainWindowEventChannels({ scope: "remote", instanceId: "pwr_owner" });
const local = mainWindowEventChannels();

describe("main window event channels", () => {
  // A viewer lists the owner's to-dos and operator requests over federation.
  // Without these channels it loads them once and never hears they changed.
  it("subscribes a federation viewer to its owner's queue changes", () => {
    expect(viewer).toContain(OPERATOR_REQUESTS_CHANGED_EVENT_CHANNEL);
    expect(viewer).toContain(THREAD_TODOS_CHANGED_EVENT_CHANNEL);
    expect(viewer).toContain(AGENT_EVENT_CHANNEL);
  });

  it("keeps this machine's own notices out of a federation viewer", () => {
    for (const channel of [
      HOT_CPU_PROFILE_CAPTURED_EVENT_CHANNEL,
      CODEX_RESTART_STATUS_CHANGED_EVENT_CHANNEL,
      THREAD_ARCHIVE_SWEEP_STATUS_CHANGED_EVENT_CHANNEL,
      PWRSUITE_INSTALLER_EVENT_CHANNEL,
    ]) {
      expect(viewer).not.toContain(channel);
      expect(local).toContain(channel);
    }
  });

  it("gives a local window every channel a viewer has", () => {
    expect(local).toEqual(expect.arrayContaining(viewer));
    expect(new Set(local).size).toBe(local.length);
  });
});
