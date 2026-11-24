import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizeCommandText } from "../command-action-labels";

// A command label strips the quotes a shell wrapper put around its script
// (`/bin/zsh -lc 'git status'`), and nothing else. Stripping any lone leading
// or trailing quote labelled `echo "done"` as `echo "done`.

const word = fc.stringMatching(/^[a-z0-9_./-]{1,12}$/);
const quoted = word.map((value) => `"${value}"`);
const command = fc
  .array(fc.oneof(word, quoted), { minLength: 1, maxLength: 6 })
  .map((parts) => parts.join(" "));

describe("normalizeCommandText quotes", () => {
  it("keeps a bare command's own quotes", () => {
    fc.assert(
      fc.property(command, (text) => {
        expect(normalizeCommandText(text)).toBe(text);
      }),
    );
  });

  it("removes the quotes a shell wrapper put around its script", () => {
    fc.assert(
      fc.property(
        command,
        fc.constantFrom("/bin/zsh -lc", "bash -lc", "/bin/sh -lc"),
        (text, wrapper) => {
          expect(normalizeCommandText(`${wrapper} '${text}'`)).toBe(text);
        },
      ),
    );
  });

  it("removes the quotes around a Windows interpreter's script", () => {
    fc.assert(
      fc.property(word, (text) => {
        expect(normalizeCommandText(`powershell.exe -Command "${text}"`)).toBe(text);
      }),
    );
  });
});
