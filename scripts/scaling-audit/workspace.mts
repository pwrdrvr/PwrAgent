// The launcher stages this beside the measured revision's Vitest workspace.
import workspace from "./vitest.workspace.mts";

const selected = JSON.parse(process.env.AUDIT_FILES!);
const projects = workspace.test.projects.filter(({ test }) => selected[test.name]);
for (const project of projects) {
  project.test.include = selected[project.test.name];
  if (process.env.AUDIT_LIVE_INDEX === "1" && process.env.AUDIT_COUNT_PROJECTION === "1") {
    // Observe the two #4590 sites in memory. A moved counter must be ported before comparing budgets.
    project.plugins = [...(project.plugins ?? []), {
      name: "live-navigation-work",
      enforce: "pre",
      transform(code, id) {
        if (!id.endsWith("/packages/owner-core/src/navigation-query-projection.ts")) return;
        const sites = [
          ["if (!replacements.size) return source;\n  const result = source.slice();",
            "if (globalThis.auditCosts) globalThis.auditCosts.slotCopies += source.length;"],
          ["const threads = ordinaryThreads\n      .filter((thread) => {\n        if (query.lens",
            "if (globalThis.auditCosts) globalThis.auditCosts.lensTests++;"],
        ];
        for (const [site, counter] of sites) {
          if (code.split(site).length !== 2) throw new Error("Navigation counter site changed: " + site);
          const split = site.lastIndexOf("\n") + 1;
          code = code.replace(site, site.slice(0, split) + counter + "\n" + site.slice(split));
        }
        return code;
      },
    }];
  }
}
export default { ...workspace, test: { ...workspace.test, projects } };
