/**
 * A stylesheet cut down to the declarations of a few properties, for a jsdom
 * test that reads them back through getComputedStyle.
 *
 * jsdom parses every declaration of a stylesheet it is given, and walks every
 * rule on each getComputedStyle call. app.css holds over 6,000 rules: parsing
 * it took 1.6 to 2 s on an 8-vCPU Sandboxer VM, and every role query after
 * that (Testing Library reads computed visibility up the tree) took 40 to
 * 300 ms. A test that asserts one property pays that for rules that cannot
 * change its answer.
 *
 * Dropping a declaration of another property cannot change which declaration
 * of a kept property wins: every kept declaration keeps its selector, its
 * conditional at-rules, its `!important` and its source order. `all` is always
 * kept, since it resets the kept properties too, and so is every custom
 * property a kept value reads through `var()`, transitively. Rules left with
 * nothing to declare are dropped. So are `@import`, `@font-face`, `@keyframes`
 * and other at-rules that declare no element's style.
 */

type CssNode = { prelude: string; body: CssNode[] | null };

/** `@`-rules whose block holds ordinary rules under a condition or layer. */
const GROUPING_AT_RULES = new Set(["media", "supports", "container", "layer", "scope", "document"]);

export function cssWithOnlyProperties(css: string, properties: readonly string[]): string {
  const nodes = parseCss(css);
  const kept = keptPropertyNames(nodes, properties);
  return serialize(nodes, kept, false).join("\n");
}

function parseCss(css: string): CssNode[] {
  let i = 0;
  const block = (): CssNode[] => {
    const nodes: CssNode[] = [];
    // The text since the last delimiter is css.slice(from, i), after `text`:
    // the part before a comment, which is cut out.
    let text = "";
    let from = i;
    let parens = 0;
    const take = () => {
      const taken = (text + css.slice(from, i)).trim();
      text = "";
      return taken;
    };
    while (i < css.length) {
      const ch = css[i]!;
      if (ch === "/" && css[i + 1] === "*") {
        text += css.slice(from, i);
        const end = css.indexOf("*/", i + 2);
        i = from = end < 0 ? css.length : end + 2;
        continue;
      }
      if (ch === "\"" || ch === "'") {
        i++;
        while (i < css.length && css[i] !== ch) i += css[i] === "\\" ? 2 : 1;
        i++;
        continue;
      }
      if (ch === "(") parens++;
      else if (ch === ")") parens = Math.max(0, parens - 1);
      // A data: URL carries semicolons inside its parentheses.
      if (parens > 0 || (ch !== ";" && ch !== "{" && ch !== "}")) {
        i++;
        continue;
      }
      const prelude = take();
      i++;
      if (ch === "{") {
        nodes.push({ prelude, body: block() });
      } else {
        if (prelude) nodes.push({ prelude, body: null });
        if (ch === "}") return nodes;
      }
      from = i;
    }
    const rest = take();
    if (rest) nodes.push({ prelude: rest, body: null });
    return nodes;
  };
  return block();
}

function declaration(prelude: string): { name: string; value: string } | null {
  const colon = prelude.indexOf(":");
  if (colon < 0) return null;
  const name = prelude.slice(0, colon).trim();
  // Custom property names are case-sensitive; standard ones are not.
  return { name: name.startsWith("--") ? name : name.toLowerCase(), value: prelude.slice(colon + 1) };
}

function* declarations(nodes: CssNode[], inStyleRule: boolean): Generator<{ name: string; value: string }> {
  for (const node of nodes) {
    if (node.body) {
      yield* declarations(node.body, inStyleRule || !node.prelude.startsWith("@"));
    } else if (inStyleRule) {
      const parsed = declaration(node.prelude);
      if (parsed) yield parsed;
    }
  }
}

/** The requested properties, `all`, and every custom property they read. */
function keptPropertyNames(nodes: CssNode[], properties: readonly string[]): Set<string> {
  const values = new Map<string, string[]>();
  for (const { name, value } of declarations(nodes, false)) {
    const list = values.get(name);
    if (list) list.push(value);
    else values.set(name, [value]);
  }
  const kept = new Set(["all", ...properties.map((name) => name.toLowerCase())]);
  const pending = [...kept];
  while (pending.length > 0) {
    for (const value of values.get(pending.pop()!) ?? []) {
      for (const match of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (!kept.has(match[1]!)) {
          kept.add(match[1]!);
          pending.push(match[1]!);
        }
      }
    }
  }
  return kept;
}

function serialize(nodes: CssNode[], kept: Set<string>, inStyleRule: boolean): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (!node.body) {
      const parsed = inStyleRule ? declaration(node.prelude) : null;
      if (parsed && kept.has(parsed.name)) out.push(`${node.prelude};`);
      // `@layer a, b;` fixes layer order even with nothing declared.
      else if (!inStyleRule && /^@layer\b/i.test(node.prelude)) out.push(`${node.prelude};`);
      continue;
    }
    const atRule = /^@([\w-]+)/.exec(node.prelude)?.[1]?.toLowerCase();
    if (atRule !== undefined && !GROUPING_AT_RULES.has(atRule)) continue;
    const inner = serialize(node.body, kept, inStyleRule || atRule === undefined);
    // An empty `@layer` block still claims its place in the layer order.
    if (inner.length > 0 || atRule === "layer") {
      out.push(`${node.prelude} {\n${inner.join("\n")}\n}`);
    }
  }
  return out;
}
