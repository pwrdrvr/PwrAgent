import { describe, expect, it } from "vitest";
import { parseForkCommand } from "../composer-fork-command";
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

  it("keeps fork parameter suggestions open after a space", () => {
    const text = "/fork --wt ";
    expect(findSlashCommandTrigger(text, text.length)?.query).toBe("fork --wt ");
    expect(findSlashCommandTrigger("/review ", 8)).toBeUndefined();
    expect(findSlashCommandTrigger("/forklift ", 10)).toBeUndefined();
  });
});
