/** Contrived values using the pinned discovery v6 status/problems/tree wire shapes. */
export function discoveryRecords(count = 3) {
  const nodes = Array.from({ length: count }, (_, id) => ({ id, parent: id === 0 ? null : Math.floor((id - 1) / 2), round: id === 0 ? 0 : Math.floor(Math.log2(id + 1)),
    score: id / Math.max(1, count), verified: id === count - 1 ? true : null, check: null, worker: id === 0 ? null : {
      task: `fixture-worker-${id % 10}`, process: id + 10, model_calls: 1, input_tokens: 10, output_tokens: 20,
    }, excerpt: `Invented candidate ${id}`, ms_since_start: id * 10 }));
  return {
    status: { run: "fixture-run", state: "done", problems: 1, finished: 1, solved: 1, active: [], tokens_in: 100, tokens_out: 200,
      task: { policy: null, concurrency: 2, limits: {} }, failed_continuations: 0, started_at_ms: 1000, future_field: "retained without interpretation" },
    problems: { run: "fixture-run", problems: [{ problem: "fixture_problem", state: "done", best: 1, rounds: 2, nodes: Math.max(0, count - 1), tokens_in: 100, tokens_out: 200, stop: "solved", solved: true }] },
    tree: { run: "fixture-run", problem: "fixture_problem", state: "done", nodes, rounds: [], policy: { kind: "builtin", program: null }, truncated: false },
  };
}
