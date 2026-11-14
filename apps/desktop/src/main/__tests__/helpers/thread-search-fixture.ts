import type { StateDb } from "../../state/state-db";

export function seedSearchUsage(db: StateDb, count: number): void {
  const insert = searchUsageInsert(db);
  const owner = db.raw.prepare(`INSERT INTO automations
    (automation_id, backend, thread_id, name, status, backlog_policy, created_at, updated_at, payload)
    VALUES (?, 'codex', ?, 'Fixture', 'active', 'skip', 1, 1, '{}')`);
  const run = db.raw.prepare(`INSERT INTO automation_runs
    (run_id, automation_id, backend, thread_id, status, trigger, created_at, updated_at, payload)
    VALUES (?, ?, 'codex', ?, 'completed', 'manual', 1, 1, ?)`);
  db.raw.transaction(() => {
    for (let i = 0; i < count; i++) {
      insert.run({ id: `usage-${i}`, provider: i % 2 ? "anthropic" : "openai", backend: "codex",
        thread: `execution-${i}`, status: i % 2 ? "superseded" : "finalized" });
      owner.run(`automation-${i}`, `owner-${i}`);
      run.run(`run-${i}`, `automation-${i}`, `owner-${i}`, JSON.stringify({ backendThreadId: `execution-${i}` }));
    }
  })();
}

export function searchUsageInsert(db: StateDb) {
  return db.raw.prepare(`INSERT INTO thread_usage_lines (
    usage_line_id, provider, backend, thread_id, source, scope, status,
    created_at, updated_at, input_tokens, cached_input_tokens, uncached_input_tokens,
    output_tokens, reasoning_output_tokens, total_tokens, price_status, currency,
    uncached_input_cost_micros, cached_input_cost_micros, output_cost_micros, total_cost_micros
  ) VALUES (@id, @provider, @backend, @thread, 'fixture', 'thread', @status,
    1, 1, 0, 0, 0, 0, 0, 0, 'unpriced', 'USD', 0, 0, 0, 0)`);
}
