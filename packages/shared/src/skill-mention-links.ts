export type SkillMentionLink = { start: number; end: number; name: string; target: string };

/**
 * Scan left to right for [$name](target), optionally accepting @ as well.
 * Any nested start in a name shares its closing bracket or line break.
 * Likewise, starts inside an unterminated target cannot close on that line.
 */
export function* scanSkillMentionLinks(
  text: string,
  prefixes: "$" | "$@",
  work?: { chars: number },
): Generator<SkillMentionLink> {
  let state: "text" | "prefix" | "name" | "afterName" | "target" = "text";
  let start = 0;
  let close = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (work) work.chars += 1;
    switch (state) {
      case "prefix":
        if (char === "$" || (prefixes === "$@" && char === "@")) {
          start = index - 1;
          state = "name";
          continue;
        }
        break;
      case "name":
        if (char === "]") {
          close = index;
          state = close > start + 2 ? "afterName" : "text";
          continue;
        }
        if (char !== "\r" && char !== "\n") continue;
        break;
      case "afterName":
        if (char === "(") {
          state = "target";
          continue;
        }
        break;
      case "target":
        if (char === ")") {
          if (index > close + 2) {
            yield { start, end: index + 1, name: text.slice(start + 2, close), target: text.slice(close + 2, index) };
          }
        } else if (char !== "\r" && char !== "\n") {
          continue;
        }
        break;
    }
    // A '[' immediately following a failed prefix or closing ']' can start the next link.
    state = char === "[" ? "prefix" : "text";
  }
}
