import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { unwrapCommandText } from "../command-action-labels";

describe("unwrapCommandText", () => {
  it("unwraps POSIX -c scripts, removing quotes only as a matched pair after the wrapper", () => {
    fc.assert(fc.property(
      fc.constantFrom("sh", "bash", "zsh", "/bin/sh", "/bin/bash", "/bin/zsh"),
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
});
