import path from "node:path";
import { BaseSequencer } from "vitest/node";

// Balance configured projects independently and retain Vitest's hash ownership
// for the rest. Vitest still handles in-lane ordering, pools, and isolation.
export default class WeightedUnitSequencer extends BaseSequencer {
  async shard(specifications) {
    const selected = await super.shard(specifications);
    const { root, shard: { count, index } } = this.ctx.config;
    const result = selected.filter((spec) => !this.projectCosts.has(spec.project.name));
    for (const [project, measured] of this.projectCosts) {
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
