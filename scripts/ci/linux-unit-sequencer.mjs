import fs from "node:fs";
import path from "node:path";
import { BaseSequencer } from "vitest/node";

const costs = JSON.parse(fs.readFileSync(new URL("./linux-unit-costs.json", import.meta.url), "utf8"));

// Linux's two full-workspace lanes used to receive equal file counts, but the
// path hash put all three longest desktop-main files in lane 1. Balance this
// sequential project independently; keep Vitest's sort, pools and isolation.
// Other projects retain their existing hash ownership.
export default class LinuxUnitSequencer extends BaseSequencer {
  async shard(specifications) {
    const selected = await super.shard(specifications);
    const { root, shard: { count, index } } = this.ctx.config;
    const main = specifications.filter((spec) => spec.project.name === "desktop-main").map((spec) => {
      const file = path.relative(root, spec.moduleId).split(path.sep).join("/");
      return { spec, file, weight: costs.files[file] ?? costs.fallbackMs };
    });
    main.sort((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    const lanes = Array.from({ length: count }, () => ({ weight: 0, specifications: [] }));
    for (const entry of main) {
      const lane = lanes.reduce((least, candidate) => candidate.weight < least.weight ? candidate : least);
      lane.weight += entry.weight;
      lane.specifications.push(entry.spec);
    }
    return [...selected.filter((spec) => spec.project.name !== "desktop-main"), ...lanes[index - 1].specifications];
  }
}
