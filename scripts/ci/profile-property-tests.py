from pathlib import Path
import sys

candidate = sys.argv[1] == "candidate"
root = Path("apps/desktop/src")

def load(glob):
    global path, src
    path, = root.rglob(glob)
    src = path.read_text() + """
const phaseMs: Record<string, number> = {};
function timed<T>(phase: string, run: () => T): T {
  const start = performance.now();
  try { return run(); }
  finally { phaseMs[phase] = (phaseMs[phase] ?? 0) + performance.now() - start; }
}
function logPhases(label: string): void {
  console.log("PROPERTY_PHASES", JSON.stringify({ label, ...phaseMs }));
  for (const phase of Object.keys(phaseMs)) delete phaseMs[phase];
}
"""

def line(old, new):
    global src
    old = old.replace("§", "$").replace("¤", chr(96))
    new = new.replace("§", "$").replace("¤", chr(96))
    assert src.count(old) == 1, (old, src.count(old))
    src = src.replace(old, new)

def measure(start, expression, phase, end=";"):
    line(start + expression + end, start + f'timed("{phase}", () => {expression})' + end)

load("single-visible-tooltip.property.test.tsx")
line('import { afterEach, expect, it }', 'import { afterAll, afterEach, expect, it }')
src += '\nafterAll(() => logPhases("tooltip"));\n'
measure('      const view = ', 'render(<Window />)', "mount")
if candidate:
    line('      const dataTarget = trigger("Changes tab");', '''      const dataTarget = timed("lookup", () => view.getByText("Changes tab"));
      const targets = timed("lookup", () => ({
        a: view.getByText("Trigger a"), b: view.getByText("Trigger b"), card: view.getByText("Trigger card"),
      }));''')
    line('trigger(¤Trigger §{step.id}¤)', 'targets[step.id]')
    line('tooltips.card!.show(trigger("Trigger card"),', 'tooltips.card!.show(targets.card,')
else:
    measure('      const dataTarget = ', 'trigger("Changes tab")', "lookup")
    measure('tooltips[step.id]!.show(', 'trigger(¤Trigger §{step.id}¤)', "lookupInAct", ",")
    measure('tooltips.card!.show(', 'trigger("Trigger card")', "lookupInAct", ",")
line('          act(() => {', '          timed("act", () => act(() => {')
line('          });\n          expect(plainTooltipsShown())', '          }));\n          expect(plainTooltipsShown())')
measure('          ', 'expect(plainTooltipsShown()).toEqual(active ? [active] : [])', "assertions")
measure('          ', 'expect(cardShown()).toBe(card)', "assertions")
measure('        ', 'view.unmount()', "unmount")
line('{ numRuns: 150 }', '{ numRuns: 150, seed: Number(process.env.PROPERTY_PROFILE_SEED) }')
path.write_text(src)

load("LinkedProjectsPanel.property.test.tsx")
src += '\nafterAll(() => logPhases("linked-projects"));\n'
measure('  style.textContent = ', 'cssWithOnlyProperties(css, ["display", "visibility"])', "cssFilter")
measure('  ', 'document.head.append(style)', "cssInstall")
measure('        const panel = ', 'render(view(0))', "mount")
measure('            ', 'panel.rerender(view(sibling))', "rerender")
measure('            ', 'expect(panel.queryByText(expected)).toBeVisible()', "visibility")
measure('            ', 'expect(panel.queryByText(checkouts[1 - sibling]!)).not.toBeInTheDocument()', "absence")
measure('            ', 'fireEvent.mouseEnter(panel.getByLabelText(¤Path for §{project}¤))', "tooltip")
first = '            fireEvent.click(panel.getByRole("button", { name: ¤Copy path for §{project}¤ }));'
second = '            fireEvent.click(panel.getByRole("button", { name: ¤Copy path for §{directories[sibling]!.kind} §{project}¤ }));'
if candidate:
    line(first, '''            const headingLabel = ¤Copy path for §{project}¤;
            const rowLabel = ¤Copy path for §{directories[sibling]!.kind} §{project}¤;
            const buttons = timed("copyQuery", () => panel.getAllByRole("button", {
              name: (name) => name === headingLabel || name === rowLabel,
            }));
            const heading = panel.getByLabelText(headingLabel, { selector: "button" });
            const row = panel.getByLabelText(rowLabel, { selector: "button" });
            expect(buttons).toEqual(expect.arrayContaining([heading, row]));
            expect(buttons).toHaveLength(2);
            timed("copyClick", () => fireEvent.click(heading));''')
    line(second, '            timed("copyClick", () => fireEvent.click(row));')
else:
    for old, var in [(first, "heading"), (second, "row")]:
        query = old.strip().removeprefix("fireEvent.click(").removesuffix(");")
        line(old, f'            const {var} = timed("copyQuery", () => {query});\n'
                  f'            timed("copyClick", () => fireEvent.click({var}));')
line('        } finally {\n          panel.unmount();\n        }\n      },\n    ), { numRuns: 25 });\n  });\n\n  it("offers',
     '        } finally {\n          timed("unmount", () => panel.unmount());\n        }\n      },\n    ), { numRuns: 25, seed: Number(process.env.PROPERTY_PROFILE_SEED) });\n  });\n\n  it("offers')
path.write_text(src)

load("thread-search-ranked.property.test.ts")
line('  const db = openInMemoryStateDb();\n  try {\n    const store = new ThreadSearchStore(db);\n    const threads',
     '  const db = timed("open", () => openInMemoryStateDb());\n  try {\n    const store = new ThreadSearchStore(db);\n    const threads')
line('    store.upsertThreads(threads);\n    let matchOpens', '''    const prepareFixture = db.raw.prepare.bind(db.raw);
    const statements = new Map<string, ReturnType<typeof prepareFixture>>();
    const fixtureSpy = vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
      const cached = statements.get(sql);
      if (cached) return cached;
      const statement = prepareFixture(sql);
      statements.set(sql, statement);
      return statement;
    });
    try { timed("seed", () => store.upsertThreads(threads)); }
    finally { fixtureSpy.mockRestore(); }
    let matchOpens''' if candidate else '    timed("seed", () => store.upsertThreads(threads));\n    let matchOpens')
line('  } finally { db.close(); }\n});\n\nit("matches',
     '    phaseMs.search = ms;\n  } finally {\n    timed("close", () => db.close());\n    logPhases("ranked-" + n);\n  }\n});\n\nit("matches')
line('}), { numRuns: 30 });', '}), { numRuns: 30, seed: Number(process.env.PROPERTY_PROFILE_SEED) });')
path.write_text(src)
