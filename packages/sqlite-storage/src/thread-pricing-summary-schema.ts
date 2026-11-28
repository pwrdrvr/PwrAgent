import type Database from "better-sqlite3";

// A gap requires at least one cumulative component to exceed this row alone.
// Earlier nonnegative accounted tokens can only reduce it further. Keep the
// index predicate identical to the EXISTS probe on every schema version.
const POSSIBLE_PRICED_GAP = `(status != 'superseded' AND model IS NOT NULL AND scope != 'monitor'
  AND cumulative_output_tokens IS NOT NULL AND cumulative_cached_input_tokens IS NOT NULL
  AND (COALESCE(cumulative_uncached_input_tokens, cumulative_input_tokens - cumulative_cached_input_tokens) > uncached_input_tokens
    OR cumulative_cached_input_tokens > cached_input_tokens OR cumulative_output_tokens > output_tokens
    OR cumulative_reasoning_output_tokens > reasoning_output_tokens)) IS TRUE`;

// A negative charge can increase spend when replaced. Native children can
// also have charges summarized only under their parent. Exclude both cases
// when using the summary plus live costs to rule out an alert.
const NEGATIVE_CHARGE = "(status != 'superseded' AND price_status = 'priced' AND total_cost_micros < 0)";
const CHILD_CHARGE = "(status != 'superseded' AND parent_thread_id != thread_id)";
export const ROLLED_UP_SPEND_HISTORY = `(${POSSIBLE_PRICED_GAP} OR ${NEGATIVE_CHARGE}) IS TRUE`;
export const DIRECT_SPEND_HISTORY = `(${ROLLED_UP_SPEND_HISTORY} OR ${CHILD_CHARGE}) IS TRUE`;

// Accounted tokens never decrease. Total gap tokens in any one component
// cannot exceed the largest cumulative value at an anchor for that component.
// NULL sorts first in the lookup and forces exact reconciliation.
const CUMULATIVE_CEILING = `MAX(0,
  COALESCE(cumulative_uncached_input_tokens, cumulative_input_tokens - cumulative_cached_input_tokens, 0),
  COALESCE(cumulative_cached_input_tokens, 0), COALESCE(cumulative_output_tokens, 0),
  COALESCE(cumulative_reasoning_output_tokens, 0))`;
export const ROLLED_UP_GAP_CEILING = `CASE WHEN ${NEGATIVE_CHARGE} THEN NULL ELSE ${CUMULATIVE_CEILING} END`;
export const DIRECT_GAP_CEILING = `CASE WHEN ${NEGATIVE_CHARGE} OR ${CHILD_CHARGE} THEN NULL ELSE ${CUMULATIVE_CEILING} END`;

// Update only initialized buckets. The store materializes new buckets so a
// native child's usage does not gain a separate visible summary. Match both
// identities on existing buckets, once when the thread is its own parent.
const THREAD_PRICING_SUMMARY_DELTAS = `
CREATE TRIGGER IF NOT EXISTS thread_pricing_summary_delta_insert
AFTER INSERT ON thread_usage_lines
WHEN NEW.status != 'superseded'
BEGIN
  UPDATE thread_pricing_summaries SET
    usage_line_count = usage_line_count + 1,
    priced_usage_line_count = priced_usage_line_count + (NEW.price_status = 'priced'),
    unpriced_usage_line_count = unpriced_usage_line_count + (NEW.price_status != 'priced'),
    input_tokens = input_tokens + NEW.input_tokens,
    cached_input_tokens = cached_input_tokens + NEW.cached_input_tokens,
    uncached_input_tokens = uncached_input_tokens + NEW.uncached_input_tokens,
    output_tokens = output_tokens + NEW.output_tokens,
    reasoning_output_tokens = reasoning_output_tokens + NEW.reasoning_output_tokens,
    total_tokens = total_tokens + NEW.total_tokens,
    total_cost_micros = total_cost_micros + CASE WHEN NEW.price_status = 'priced' THEN NEW.total_cost_micros ELSE 0 END,
    updated_at = NEW.updated_at
  WHERE ledger_delta_ready = 1
    AND provider = NEW.provider AND backend = NEW.backend AND currency = NEW.currency
    AND thread_id IN (NEW.thread_id, NEW.parent_thread_id);
END;

CREATE TRIGGER IF NOT EXISTS thread_pricing_summary_delta_update
AFTER UPDATE OF provider, backend, currency, thread_id, parent_thread_id, status, price_status,
  input_tokens, cached_input_tokens, uncached_input_tokens, output_tokens,
  reasoning_output_tokens, total_tokens, total_cost_micros, updated_at
ON thread_usage_lines
WHEN OLD.status != 'superseded' OR NEW.status != 'superseded'
BEGIN
  UPDATE thread_pricing_summaries SET
    (usage_line_count, priced_usage_line_count, unpriced_usage_line_count,
     input_tokens, cached_input_tokens, uncached_input_tokens, output_tokens,
     reasoning_output_tokens, total_tokens, total_cost_micros, updated_at) = (
      SELECT
        usage_line_count - removes + adds,
        priced_usage_line_count - removes * (OLD.price_status = 'priced') + adds * (NEW.price_status = 'priced'),
        unpriced_usage_line_count - removes * (OLD.price_status != 'priced') + adds * (NEW.price_status != 'priced'),
        input_tokens - removes * OLD.input_tokens + adds * NEW.input_tokens,
        cached_input_tokens - removes * OLD.cached_input_tokens + adds * NEW.cached_input_tokens,
        uncached_input_tokens - removes * OLD.uncached_input_tokens + adds * NEW.uncached_input_tokens,
        output_tokens - removes * OLD.output_tokens + adds * NEW.output_tokens,
        reasoning_output_tokens - removes * OLD.reasoning_output_tokens + adds * NEW.reasoning_output_tokens,
        total_tokens - removes * OLD.total_tokens + adds * NEW.total_tokens,
        total_cost_micros - removes * (OLD.price_status = 'priced') * OLD.total_cost_micros
          + adds * (NEW.price_status = 'priced') * NEW.total_cost_micros,
        NEW.updated_at
      FROM (
        SELECT
          (OLD.status != 'superseded' AND provider = OLD.provider AND backend = OLD.backend
            AND currency = OLD.currency AND (thread_id = OLD.thread_id OR thread_id IS OLD.parent_thread_id)) AS removes,
          (NEW.status != 'superseded' AND provider = NEW.provider AND backend = NEW.backend
            AND currency = NEW.currency AND (thread_id = NEW.thread_id OR thread_id IS NEW.parent_thread_id)) AS adds
      )
    )
  WHERE ledger_delta_ready = 1 AND (
    (OLD.status != 'superseded' AND provider = OLD.provider AND backend = OLD.backend
      AND currency = OLD.currency AND thread_id IN (OLD.thread_id, OLD.parent_thread_id))
    OR (NEW.status != 'superseded' AND provider = NEW.provider AND backend = NEW.backend
      AND currency = NEW.currency AND thread_id IN (NEW.thread_id, NEW.parent_thread_id))
  );

  DELETE FROM thread_pricing_summaries
  WHERE ledger_delta_ready = 1 AND usage_line_count = 0
    AND provider = OLD.provider AND backend = OLD.backend AND currency = OLD.currency
    AND thread_id IN (OLD.thread_id, OLD.parent_thread_id);
END;

CREATE TRIGGER IF NOT EXISTS thread_pricing_summary_delta_delete
AFTER DELETE ON thread_usage_lines
WHEN OLD.status != 'superseded'
BEGIN
  UPDATE thread_pricing_summaries SET
    usage_line_count = usage_line_count - 1,
    priced_usage_line_count = priced_usage_line_count - (OLD.price_status = 'priced'),
    unpriced_usage_line_count = unpriced_usage_line_count - (OLD.price_status != 'priced'),
    input_tokens = input_tokens - OLD.input_tokens,
    cached_input_tokens = cached_input_tokens - OLD.cached_input_tokens,
    uncached_input_tokens = uncached_input_tokens - OLD.uncached_input_tokens,
    output_tokens = output_tokens - OLD.output_tokens,
    reasoning_output_tokens = reasoning_output_tokens - OLD.reasoning_output_tokens,
    total_tokens = total_tokens - OLD.total_tokens,
    total_cost_micros = total_cost_micros - CASE WHEN OLD.price_status = 'priced' THEN OLD.total_cost_micros ELSE 0 END
  WHERE ledger_delta_ready = 1
    AND provider = OLD.provider AND backend = OLD.backend AND currency = OLD.currency
    AND thread_id IN (OLD.thread_id, OLD.parent_thread_id);

  DELETE FROM thread_pricing_summaries
  WHERE ledger_delta_ready = 1 AND usage_line_count = 0
    AND provider = OLD.provider AND backend = OLD.backend AND currency = OLD.currency
    AND thread_id IN (OLD.thread_id, OLD.parent_thread_id);
END;
`;

export function ensureThreadPricingSummaryDeltas(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(thread_pricing_summaries)").all() as Array<{ name: string }>;
  if (columns.length === 0) return;
  if (!columns.some(({ name }) => name === "ledger_delta_ready")) {
    db.exec("ALTER TABLE thread_pricing_summaries ADD COLUMN ledger_delta_ready INTEGER NOT NULL DEFAULT 0");
  }
  db.exec(THREAD_PRICING_SUMMARY_DELTAS);
}
