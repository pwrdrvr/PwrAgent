import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { unwrapCommandText } from "../command-action-labels";

const posixShell = fc.constantFrom("sh", "bash", "zsh", "/bin/sh", "/bin/bash", "/bin/zsh");

describe("unwrapCommandText", () => {
  it("unwraps POSIX -c scripts, removing quotes only as a matched pair after the wrapper", () => {
    fc.assert(fc.property(
      posixShell,
      fc.array(fc.constantFrom("pwd", "git status", "printf ready"), { minLength: 2 }),
      fc.constantFrom("\n", "\r\n"),
      fc.constantFrom('"', "'"),
      (shell, lines, newline, quote) => {
        const script = lines.join(`${newline}  `);
        const wrapper = `${shell} -c `;
        const quotedScript = `${quote}${script}${quote}`;
        const mismatchedScript = `${quote}${script}${quote === '"' ? "'" : '"'}`;

        expect(unwrapCommandText(`${wrapper}${quotedScript}`)).toBe(script);
        expect(unwrapCommandText(`${wrapper}${mismatchedScript}`)).toBe(mismatchedScript);
        expect(unwrapCommandText(`${wrapper}${quote}${script}`)).toBe(`${quote}${script}`);
        expect(unwrapCommandText(quotedScript)).toBe(quotedScript);
      },
    ));
  });

  it("keeps POSIX invocations whose quoted script is followed by arguments", () => {
    fc.assert(fc.property(
      posixShell,
      fc.constantFrom("-c", "-lc"),
      fc.constantFrom('"', "'"),
      fc.constantFrom("pwd", "printf ready", "pwd\n  pwd"),
      fc.array(fc.constantFrom("_", "hello", "'two words'", '"three more words"'), { minLength: 1 }),
      (shell, option, quote, script, args) => {
        const command = `${shell} ${option} ${quote}${script}${quote} ${args.join(" ")}`;
        expect(unwrapCommandText(command)).toBe(command);
      },
    ));
  });

  it("keeps the POSIX invocation when the c option is uppercase", () => {
    fc.assert(fc.property(
      posixShell,
      fc.constantFrom("-C", "-lC"),
      fc.constantFrom("./build.sh", "'./build script.sh'", '"./build script.sh"'),
      (shell, option, file) => {
        const command = `${shell} ${option} ${file}`;
        expect(unwrapCommandText(command)).toBe(command);
      },
    ));
  });

  it("keeps the POSIX invocation when its quoted script is blank", () => {
    fc.assert(fc.property(
      posixShell,
      fc.constantFrom("-c", "-lc"),
      fc.constantFrom('"', "'"),
      fc.string({ unit: fc.constantFrom(" ", "\t", "\n", "\r") }),
      (shell, option, quote, whitespace) => {
        const command = `${shell} ${option} ${quote}${whitespace}${quote}`;
        expect(unwrapCommandText(command)).toBe(command);
      },
    ));
  });
});
