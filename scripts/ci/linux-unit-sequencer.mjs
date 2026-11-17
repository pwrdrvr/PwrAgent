import fs from "node:fs";
import path from "node:path";
import { BaseSequencer } from "vitest/node";

const costs = JSON.parse(fs.readFileSync(new URL("./linux-unit-costs.json", import.meta.url), "utf8"));
const rendererCosts = JSON.parse(fs.readFileSync(new URL("./linux-renderer-unit-costs.json", import.meta.url), "utf8"));
const projectCosts = new Map([["desktop-main", costs], ["desktop-renderer", rendererCosts]]);

// Linux's two full-workspace lanes used to receive equal file counts, but the
// path hash concentrated long main-process and renderer files in one lane.
// Balance each project independently; keep Vitest's sort, pools and isolation.
// Other projects retain their existing hash ownership.
export default class LinuxUnitSequencer extends BaseSequencer {
  async shard(specifications) {
    const selected = await super.shard(specifications);
    const { root, shard: { count, index } } = this.ctx.config;
    const result = selected.filter((spec) => !projectCosts.has(spec.project.name));
    for (const [project, measured] of projectCosts) {
      const files = specifications.filter((spec) => spec.project.name === project).map((spec) => {
        const file = path.relative(root, spec.moduleId).split(path.sep).join("/");
        return { spec, file, weight: measured.files[file] ?? measured.fallbackMs };
      });
      files.sort((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
      const lanes = Array.from({ length: count }, () => ({ weight: 0, specifications: [] }));
      for (const entry of files) {
        const lane = lanes.reduce((least, candidate) => candidate.weight < least.weight ? candidate : least);
        lane.weight += entry.weight;
        lane.specifications.push(entry.spec);
      }
      result.push(...lanes[index - 1].specifications);
    }
    return result;
  }
}
