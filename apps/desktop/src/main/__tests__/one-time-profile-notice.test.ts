import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OneTimeProfileNotice } from "../notices/one-time-profile-notice";

describe("OneTimeProfileNotice", () => {
  let root: string;
  let marker: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-gh-notice-"));
    marker = path.join(root, "default", "state", "notices", "github-pr-authentication-failure");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("delivers once to subscribed windows and stays suppressed across restarts", () => {
    const firstWindow = vi.fn();
    const secondWindow = vi.fn();
    const notice = new OneTimeProfileNotice(marker);
    notice.publish([firstWindow, secondWindow]);
    notice.acknowledge();
    for (let poll = 0; poll < 20; poll += 1) {
      notice.publish([firstWindow, secondWindow]);
    }
    new OneTimeProfileNotice(marker).publish([firstWindow]);

    expect(firstWindow).toHaveBeenCalledTimes(1);
    expect(secondWindow).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("does not consume the notice before a live window subscribes", () => {
    const deliver = vi.fn();
    const notice = new OneTimeProfileNotice(marker);
    notice.publish([]);
    expect(fs.existsSync(marker)).toBe(false);
    notice.publish([deliver]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("deduplicates existing instances sharing a profile but keeps profiles independent", () => {
    const first = new OneTimeProfileNotice(marker);
    const second = new OneTimeProfileNotice(marker);
    const deliver = vi.fn();
    first.publish([deliver]);
    first.acknowledge();
    second.publish([deliver]);
    expect(deliver).toHaveBeenCalledTimes(1);
    new OneTimeProfileNotice(path.join(root, "other", "notice")).publish([deliver]);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("retries events lost before the renderer listener mounts, including after restart", () => {
    const loadingWindowSend = vi.fn();
    const notice = new OneTimeProfileNotice(marker);
    notice.publish([loadingWindowSend]);
    expect(loadingWindowSend).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(marker)).toBe(false);

    const restarted = new OneTimeProfileNotice(marker);
    const receive = vi.fn(() => restarted.acknowledge());
    restarted.publish([receive]);
    restarted.publish([receive]);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("retries an unacknowledged delivery on the next poll without restarting", () => {
    const notice = new OneTimeProfileNotice(marker);
    notice.publish([vi.fn()]);
    const receive = vi.fn(() => notice.acknowledge());
    notice.publish([receive]);
    notice.publish([receive]);
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it("does not consume an acknowledgement before publishing", () => {
    new OneTimeProfileNotice(marker).acknowledge();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("logs persistence failures and still limits the notice to once per process", () => {
    fs.writeFileSync(path.join(root, "default"), "blocks directory creation");
    const onError = vi.fn();
    const deliver = vi.fn();
    const notice = new OneTimeProfileNotice(marker, onError);
    notice.publish([deliver]);
    notice.acknowledge();
    notice.publish([deliver]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
