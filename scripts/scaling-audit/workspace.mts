// The launcher stages this beside the measured revision's Vitest workspace.
import workspace from "./vitest.workspace.mts";

const selected = JSON.parse(process.env.AUDIT_FILES!);
const projects = workspace.test.projects.filter(({ test }) => selected[test.name]);
for (const project of projects) {
  project.test.include = selected[project.test.name];
  if (project.test.name === "desktop-renderer" && process.env.AUDIT_LIVE_THREADS === "1") {
    project.plugins = [...(project.plugins ?? []), {
      name: "live-session-retention-work",
      enforce: "pre",
      transform(code, id) {
        const sites = process.env.AUDIT_KEYED_SESSIONS === "1" ? [
          ["/lib/thread-session-cache.ts", "const previous = this.sessions.get(key);", "retentionVisits"],
          ["/lib/thread-session-cache.ts", "for (const [key, session] of this.sessions) {", "retentionVisits"],
          ["/lib/thread-session-cache.ts", "const previous = this.summary;", "indicatorVisits"],
        ] : [
          ["/lib/useThreadSessionState.ts", "for (const entry of Object.entries(sessions)) {", "retentionVisits"],
          ["/lib/session-indicator-keys.ts", "const included = includes(sessions[key]!);", "indicatorVisits"],
        ];
        for (const [file, site, counter] of sites) {
          if (!id.endsWith(file)) continue;
          if (code.split(site).length !== 2) throw new Error("Inspect the live-thread counter site in " + file);
          code = code.replace(site, site + "\nif (globalThis.liveThreadWork) globalThis.liveThreadWork." + counter + "++;");
        }
        return code;
      },
    }];
  }
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
