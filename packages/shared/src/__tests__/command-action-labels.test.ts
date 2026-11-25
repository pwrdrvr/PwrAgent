import { describe, expect, it } from "vitest";
import { commandTitleMatchesInvocation, formatSearchCommandActionLabel, unwrapCommandText } from "../command-action-labels";

describe("formatSearchCommandActionLabel", () => {
  it("prefers the search query over its root path", () => {
    expect(
      formatSearchCommandActionLabel({
        query: "grok",
        path: ".",
      }),
    ).toBe('Searched "grok"');
  });

  it("keeps slashes in search queries", () => {
    expect(
      formatSearchCommandActionLabel({
        query: "src/main.rs",
        path: ".",
      }),
    ).toBe('Searched "src/main.rs"');
  });

  it("falls back to a meaningful path basename", () => {
    expect(
      formatSearchCommandActionLabel({
        query: null,
        path: "apps/desktop/src",
      }),
    ).toBe("Searched src");
  });

  it("omits unhelpful root-only paths", () => {
    expect(formatSearchCommandActionLabel({ query: null, path: "." })).toBe(
      "Searched",
    );
    expect(formatSearchCommandActionLabel({ query: null, path: "/" })).toBe(
      "Searched",
    );
  });
});

describe("unwrapCommandText", () => {
  it("keeps line breaks and indentation when unwrapping a plain sh -c script", () => {
    expect(unwrapCommandText('sh -c "pwd\n  pwd"')).toBe("pwd\n  pwd");
  });

  it.each(['sh -c "pwd" _', `bash -c 'echo "$1"' _ 'hello'`])(
    "keeps the script and its positional arguments in %j",
    (command) => {
      expect(unwrapCommandText(command)).toBe(command);
    },
  );

  it.each(["sh -C ./build.sh", "/bin/bash -C ./build.sh"])(
    "keeps the invocation for noclobber in %j",
    (command) => {
      expect(unwrapCommandText(command)).toBe(command);
    },
  );

  it("unwraps a script containing escaped double quotes", () => {
    const script = String.raw`printf \"ready\"`;
    expect(unwrapCommandText(`/bin/bash -c "${script}"`)).toBe(script);
  });

  it.each([
    [String.raw`bash -c 'printf %s '"\"a b\""`, 'printf %s "a b"'],
    [String.raw`sh -c 'printf '"\$value"'first'`, "printf $valuefirst"],
  ])("decodes outer escapes when joining the script fragments in %j", (command, script) => {
    expect(unwrapCommandText(command)).toBe(script);
  });

  it.each([
    String.raw`bash -c $'\n'`,
    "bash -c $\\\n'\\n'",
    String.raw`bash -c 'echo one'$'\n''echo two'`,
    'sh -c "pwd\n  pwd',
  ])("keeps the full invocation when the script cannot be decoded in %j", (command) => {
    expect(unwrapCommandText(command)).toBe(command);
  });
});

it("matches a joined script title that retains its outer double-quote escapes", () => {
  const command = String.raw`sh -c 'printf %s '"\"a b\""`;
  expect(commandTitleMatchesInvocation(String.raw`printf %s \"a b\"`, command)).toBe(true);
});
