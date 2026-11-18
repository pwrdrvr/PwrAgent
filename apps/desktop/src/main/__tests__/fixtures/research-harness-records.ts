/** Entirely contrived service records, shaped from the pinned public Rust interfaces. */
export function harnessRecords() {
  const swarm = "fixture-swarm";
  const events = [
    { event: "started", swarm, project: "fixture-project", session: "fixture-session", task: "Compare two queue hypotheses", dir: ".ultramath/fixture-swarm",
      members: ["m1", "m2"], model: "fixture-model", member_steps: 10, budget: 30, deadline_at_ms: 1_800_000 },
    { event: "member", swarm, member: "m1", state: "running" },
    { event: "direction", swarm, member: "m1", direction: "d1", state: "active", text: "Trace held-reply insertion order" },
    { event: "finding", swarm, member: "m1", direction: "d1", finding: "f1", label: "lemma", text: "The fixture preserves insertion order at admission.", paths: ["evidence/queue.txt"] },
    { event: "direction", swarm, member: "m2", direction: "d2", state: "active", text: "Test the owner-change hypothesis" },
    { event: "finding", swarm, member: "m2", direction: "d2", finding: "f2", label: "counterexample", text: "The invented reversal also happens under one owner.", paths: [] },
    { event: "submission", swarm, member: "m1", direction: "d1", report: "Release retained replies in insertion order.", paths: ["evidence/queue.txt"] },
    { event: "verdict", swarm, member: "m1", direction: "d1", accepted: true, reason: "Source coordinator accepted this informal candidate." },
    { event: "usage", swarm, calls: 12 },
    { event: "future_observation", swarm, detail: "An unfamiliar additive record remains inspectable." },
    { event: "ended", swarm, outcome: "solved", calls: 12, reserved_calls: 14, checks: 2 },
  ];
  return events.map((event, i) => ({ ...event, seq: i + 1, at_ms: 1000 + i }));
}
