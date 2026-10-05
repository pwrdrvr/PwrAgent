import { describe, expect, it } from "vitest";
import { forkCommandHint, parseForkCommand } from "../composer-fork-command";
import { findSlashCommandTrigger } from "../composer-slash-commands";

describe("fork command parsing", () => {
  it.each([
    ["/fork", "same", false],
    [" /fork --wt new ", "new", false],
    ["/fork --no-history --wt new", "new", true],
    ["/fork --wt same --no-history", "same", true],
  ] as const)("parses %s", (text, worktree, noHistory) => {
    expect(parseForkCommand(text)).toEqual({ worktree, noHistory });
  });

  it.each([
    "/fork --wt",
    "/fork --wt local",
    "/fork --wt same --wt new",
    "/fork --no-history --no-history",
    "/fork please branch this",
    "/fork\n--no-history",
  ])("rejects invalid arguments in %s", (text) => {
    expect(parseForkCommand(text)?.error).toBeDefined();
  });

  it.each(["/forklift", "Please use /fork", "/review", ""])(
    "leaves ordinary text %s alone",
    (text) => expect(parseForkCommand(text)).toBeUndefined(),
  );

  it("closes the command menu once /fork takes arguments", () => {
    expect(findSlashCommandTrigger("/fork", 5)?.query).toBe("fork");
    expect(findSlashCommandTrigger("/fork ", 6)).toBeUndefined();
    expect(findSlashCommandTrigger("/fork --wt ", 11)).toBeUndefined();
  });
});

describe("fork command hint", () => {
  it.each([
    ["/fork", " [--wt same|new] [--no-history]"],
    ["/fork ", "[--wt same|new] [--no-history]"],
    ["/fork --w", "t same|new [--no-history]"],
    ["/fork --wt", " same|new [--no-history]"],
    ["/fork --wt ", "same|new [--no-history]"],
    ["/fork --wt n", "ew [--no-history]"],
    ["/fork --wt new", " [--no-history]"],
    ["/fork --wt new ", "[--no-history]"],
    ["/fork --n", "o-history [--wt same|new]"],
    ["/fork --no-history ", "[--wt same|new]"],
    ["/fork --no-history --wt ", "same|new"],
    ["/FORK ", "[--wt same|new] [--no-history]"],
  ])("hints %j with %j", (text, hint) => {
    expect(forkCommandHint(text)).toBe(hint);
  });

  it.each([
    "/forklift",
    "Please /fork",
    "/fork --wt new --no-history",
    "/fork --wt new --no-history ",
    "/fork --",
    "/fork --wt x",
    "/fork --wt other ",
    "/fork please",
    "/fork --no-history --no-history",
    "/fork\n",
  ])("has no hint for %j", (text) => {
    expect(forkCommandHint(text)).toBeUndefined();
  });
});
