import type { AppServerSkillSummary } from "@pwragent/shared/contracts/normalized-app-server";

type State = { next: Map<string, number>; suffix: number; name?: string };
type Matcher = { states: State[]; breadthFirst: number[] };

const matchers = new WeakMap<readonly AppServerSkillSummary[], Matcher>();

// Give a '$' that can open a mention its own symbol, distinct from every
// single code unit. Apply the same rule inside names containing a literal '$'.
function symbolAt(text: string, i: number): string {
  const char = text.charAt(i);
  return char === "$" && (i === 0 || /\s/.test(text.charAt(i - 1))) ? " $" : char;
}

function advance(states: State[], state: number, symbol: string, work?: { transitions: number }): number {
  for (;;) {
    if (work) work.transitions += 1;
    const next = states[state]!.next.get(symbol);
    if (next !== undefined) return next;
    if (state === 0) return 0;
    state = states[state]!.suffix;
  }
}

function matcherFor(skills: readonly AppServerSkillSummary[]): Matcher {
  const cached = matchers.get(skills);
  if (cached) return cached;

  const states: State[] = [{ next: new Map(), suffix: 0 }];
  for (const { name } of skills) {
    const token = `$${name}`;
    let state = 0;
    for (let i = 0; i < token.length; i += 1) {
      const symbol = symbolAt(token, i);
      const edges = states[state]!.next;
      let next = edges.get(symbol);
      if (next === undefined) {
        next = states.length;
        edges.set(symbol, next);
        states.push({ next: new Map(), suffix: 0 });
      }
      state = next;
    }
    states[state]!.name = name;
  }

  // Aho-Corasick failure links retain the longest suffix that is still a
  // catalog prefix. A later start inside a skill name shares the same scan.
  const breadthFirst = [...states[0]!.next.values()];
  for (let i = 0; i < breadthFirst.length; i += 1) {
    const parent = states[breadthFirst[i]!]!;
    for (const [symbol, child] of parent.next) {
      states[child]!.suffix = advance(states, parent.suffix, symbol);
      breadthFirst.push(child);
    }
  }
  const matcher = { states, breadthFirst };
  matchers.set(skills, matcher);
  return matcher;
}

export function* bareMentionedSkills(
  text: string,
  skills: readonly AppServerSkillSummary[],
  work?: { transitions: number },
): Generator<AppServerSkillSummary> {
  if (!skills.length || !/(?:^|\s)\$/.test(text)) return;
  const { states, breadthFirst } = matcherFor(skills);
  const seen = new Set<number>();
  let state = 0;
  for (let i = 0; i < text.length; i += 1) {
    state = advance(states, state, symbolAt(text, i), work);
    if (state !== 0 && (i + 1 === text.length || /[\s.,!?;:]/.test(text.charAt(i + 1)))) {
      seen.add(state);
    }
  }

  // Only membership matters. Propagate each observed ending to its suffixes
  // once, even if the same set of overlapping names matched at many offsets.
  const found = new Set<string>();
  for (let i = breadthFirst.length - 1; i >= 0; i -= 1) {
    const id = breadthFirst[i]!;
    if (!seen.has(id)) continue;
    const { name, suffix } = states[id]!;
    if (name !== undefined) found.add(name);
    seen.add(suffix);
  }
  for (const skill of skills) {
    if (found.has(skill.name)) yield skill;
  }
}
