import path from "node:path";
export default {
  test: {
    include: ["scripts/archive-retention-lab/startup.probe.ts"],
    pool: "forks",
    env: { PWRAGENT_HOME: path.resolve(".local/archive-retention/test-home") },
  },
  resolve: { alias: { "@pwragent/shared": path.resolve("packages/shared/src/index.ts") } },
};
