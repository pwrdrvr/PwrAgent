import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MAX_ACCOUNT_TOKEN_USAGE_BUCKETS,
  type AccountTokenUsageDailyBucket,
  type AccountTokenUsageObservation,
} from "@pwragent/shared/contracts/usage-activity";
import {
  addUtcDays,
  buildAccountTokenAccounts,
  buildAccountTokenTrendView,
  utcDateMs,
  utcDateString,
  type AccountTokenUsageSource,
} from "../usage-account-tokens";
import { summarizeUsageActivity, type OwnedUsageRow } from "../usage-activity-summary";
import { buildLimitAccounts } from "../usage-limits";
import { usageFixture } from "../usage-activity-fixture";

const BASE_DATE = "2026-10-01";
const DAY_MS = 86_400_000;

/**
 * Generate a sparse sorted set of UTC daily buckets (deliberately omitting
 * random calendar days so gaps are always exercised).
 */
const sparseBucketsArb = fc.uniqueArray(
  fc.record({
    dayOffset: fc.integer({ min: 0, max: 45 }),
    tokens: fc.integer({ min: 1, max: 5_000_000_000 }),
  }),
  { selector: (entry) => entry.dayOffset, minLength: 1, maxLength: 35, size: "max" },
).map((entries): AccountTokenUsageDailyBucket[] =>
  [...entries]
    .sort((a, b) => a.dayOffset - b.dayOffset)
    .map(({ dayOffset, tokens }) => ({ startDate: addUtcDays(BASE_DATE, dayOffset), tokens })),
);

describe("account-wide daily token trend properties and oracles", () => {
  it("deduplicates one account across multiple federated owners/Outposts without summing and independently of arrival order", () => {
    fc.assert(fc.property(
      fc.uniqueArray(
        fc.record({
          accountKey: fc.stringMatching(/^acct-[a-z0-9]{4,8}$/),
          planType: fc.constantFrom("plus", "pro", "business"),
          baseBuckets: sparseBucketsArb,
          ownerCount: fc.integer({ min: 1, max: 5 }),
          newerDeltaTokens: fc.integer({ min: 0, max: 500_000 }),
        }),
        { selector: (entry) => entry.accountKey, minLength: 1, maxLength: 4 },
      ),
      fc.integer({ min: 0, max: 1_000_000 }),
      (oracleAccounts, shuffleSeed) => {
        const sources: AccountTokenUsageSource[] = [];
        const oracleByAccountKey = new Map<string, Map<string, number>>();
        let instanceSeq = 0;

        for (const acct of oracleAccounts) {
          const expectedDays = new Map<string, number>();
          for (let ownerIdx = 0; ownerIdx < acct.ownerCount; ownerIdx += 1) {
            const observedAt = 1_760_000_000_000 + ownerIdx * 60_000;
            // Later owners may see a slightly fresher count on the latest day.
            const buckets = acct.baseBuckets.map((bucket, idx) =>
              idx === acct.baseBuckets.length - 1 && ownerIdx === acct.ownerCount - 1
                ? { ...bucket, tokens: bucket.tokens + acct.newerDeltaTokens }
                : bucket,
            );
            for (const bucket of buckets) {
              expectedDays.set(bucket.startDate, bucket.tokens);
            }
            const target = instanceSeq === 0
              ? { scope: "local" as const }
              : { scope: "remote" as const, instanceId: `outpost-${instanceSeq}` };
            instanceSeq += 1;
            sources.push({
              owner: `Owner ${instanceSeq}`,
              target,
              observations: [{
                provider: "openai",
                accountKey: acct.accountKey,
                planType: acct.planType,
                observedAt,
                status: "available",
                dailyUsageBuckets: buckets,
              }],
            });
          }
          oracleByAccountKey.set(acct.accountKey, expectedDays);
        }

        // Deterministic permutation of source arrival order.
        const permuted = [...sources].sort((a, b) => {
          const score = (item: AccountTokenUsageSource) =>
            (item.owner.charCodeAt(item.owner.length - 1) * 31 + shuffleSeed) % 97;
          return score(a) - score(b);
        });

        const forward = buildAccountTokenAccounts(sources);
        const reordered = buildAccountTokenAccounts(permuted);

        // Order-independent across federation responses.
        expect(reordered).toEqual(forward);
        // Exactly one deduplicated account per oracle accountKey.
        expect(forward).toHaveLength(oracleAccounts.length);

        for (const account of forward) {
          const oracleDays = oracleByAccountKey.get(account.accountKey!)!;
          // Exact 1-to-1 match with oracle (never summed across owners, never zero-filled).
          expect(account.dailyUsageBuckets.map((b) => [b.startDate, b.tokens]))
            .toEqual([...oracleDays.entries()].sort((a, b) => a[0].localeCompare(b[0])));
        }
      },
    ));
  });

  it("never double-counts overlapping PwrAgent measured ledger rows into provider-reported account totals", () => {
    fc.assert(fc.property(
      sparseBucketsArb,
      fc.array(
        fc.record({
          dayOffset: fc.integer({ min: 0, max: 45 }),
          tokens: fc.integer({ min: 100, max: 500_000 }),
          accountKey: fc.constantFrom("acct-primary", "acct-other", undefined),
          provider: fc.constantFrom("openai", "anthropic"),
          relayedBySecondOwner: fc.boolean(),
        }),
        { minLength: 1, maxLength: 30, size: "max" },
      ),
      fc.constantFrom("14d" as const, "30d" as const, "90d" as const, "all" as const),
      (buckets, rawTurns, range) => {
        const accountKey = "acct-primary";
        const [account] = buildAccountTokenAccounts([
          {
            owner: "Studio",
            target: { scope: "local" },
            observations: [{
              provider: "openai",
              accountKey,
              observedAt: utcDateMs("2026-11-20") + 1_000,
              status: "available",
              dailyUsageBuckets: buckets,
            }],
          },
          {
            // Second federated owner (e.g. Outpost) reporting the exact same account.
            owner: "Outpost",
            target: { scope: "remote", instanceId: "outpost-1" },
            observations: [{
              provider: "openai",
              accountKey,
              observedAt: utcDateMs("2026-11-20") + 1_000,
              status: "available",
              dailyUsageBuckets: buckets,
            }],
          },
        ]);

        const windowFrom = utcDateMs(BASE_DATE);
        const windowTo = utcDateMs(addUtcDays(BASE_DATE, 50));
        const rows: OwnedUsageRow[] = [];
        const oracleMeasuredByDay = new Map<string, number>();

        rawTurns.forEach((turn, index) => {
          const day = addUtcDays(BASE_DATE, turn.dayOffset);
          const completedAt = utcDateMs(day) + 3_600_000 + index * 1_000;
          const base = usageFixture({
            usageLineId: `line-${index}`,
            threadId: `thread-${index}`,
            turnId: `turn-${index}`,
            provider: turn.provider,
            createdAt: completedAt - 10_000,
            startedAt: completedAt - 10_000,
            completedAt,
            totalTokens: turn.tokens,
            uncachedInputTokens: turn.tokens,
            cachedInputTokens: 0,
            outputTokens: 0,
          });
          rows.push({ ...base, accountKey: turn.accountKey, owner: "Studio", target: { scope: "local" } });
          if (turn.relayedBySecondOwner) {
            // Same durable turn relayed by a second instance: must deduplicate in ledger too.
            rows.push({
              ...base,
              accountKey: turn.accountKey,
              owner: "Outpost",
              target: { scope: "remote", instanceId: "outpost-1" },
            });
          }
          if (turn.provider === "openai" && turn.accountKey === accountKey) {
            oracleMeasuredByDay.set(day, (oracleMeasuredByDay.get(day) ?? 0) + turn.tokens);
          }
        });

        const summary = summarizeUsageActivity(rows, windowFrom, windowTo);
        const contained = summary.groups.flatMap((group) => group.rows);
        const now = utcDateMs(addUtcDays(buckets.at(-1)!.startDate, 1)) + 12 * 3_600_000;

        const withLedger = buildAccountTokenTrendView({ account, range, now, measuredRows: contained });
        const withoutLedger = buildAccountTokenTrendView({ account, range, now, measuredRows: [] });

        // Provider-reported account total MUST be completely invariant to ledger rows (zero double-counting!).
        expect(withLedger.rangeTotalTokens).toBe(withoutLedger.rangeTotalTokens);
        expect(withLedger.rangePeakTokens).toBe(withoutLedger.rangePeakTokens);
        expect(withLedger.days.map((d) => [d.date, d.accountTokens]))
          .toEqual(withoutLedger.days.map((d) => [d.date, d.accountTokens]));

        // Oracle check on the visible span: reported sum, omitted gaps, and separate measured subset.
        const bucketMap = new Map(buckets.map((b) => [b.startDate, b.tokens]));
        let oracleAccountSum = 0;
        let oracleMeasuredSum = 0;
        let oracleOmitted = 0;
        for (const day of withLedger.days) {
          const expectedAccount = bucketMap.get(day.date);
          expect(day.accountTokens).toBe(expectedAccount);
          if (expectedAccount === undefined) {
            oracleOmitted += 1;
          } else {
            oracleAccountSum += expectedAccount;
          }
          const expectedMeasured = oracleMeasuredByDay.get(day.date);
          expect(day.measuredTokens).toBe(expectedMeasured);
          oracleMeasuredSum += expectedMeasured ?? 0;
        }
        expect(withLedger.rangeTotalTokens).toBe(oracleAccountSum);
        expect(withLedger.rangeMeasuredTokens).toBe(oracleMeasuredSum);
        expect(withLedger.omittedDays).toBe(oracleOmitted);
        expect(withLedger.reportedDays + withLedger.omittedDays).toBe(withLedger.days.length);
        // Latest bucket is yesterday UTC -> includesToday must be false.
        expect(withLedger.includesToday).toBe(false);
        expect(withLedger.todayUtc).toBe(utcDateString(now));
      },
    ));
  });

  it("isolates keyless owners, preserves mixed-version peers, and never leaks account tokens into quota limits", () => {
    fc.assert(fc.property(
      fc.stringMatching(/^Host[A-Z]{0,5}$/),
      sparseBucketsArb,
      sparseBucketsArb,
      fc.constantFrom("unsupported" as const, "auth_required" as const, "unavailable" as const),
      (sharedLabel, localBuckets, remoteBuckets, failureStatus) => {
        const sources: AccountTokenUsageSource[] = [
          // Two keyless owners with identical display names MUST stay separate.
          {
            owner: sharedLabel,
            target: { scope: "local" },
            observations: [{
              provider: "openai",
              observedAt: 1000,
              status: "available",
              dailyUsageBuckets: localBuckets,
            }],
          },
          {
            owner: sharedLabel,
            target: { scope: "remote", instanceId: "remote-keyless" },
            observations: [{
              provider: "openai",
              observedAt: 2000,
              status: "available",
              dailyUsageBuckets: remoteBuckets,
            }],
          },
          // One keyed account where one owner succeeds and another peer fails/is unsupported.
          {
            owner: "New Desktop",
            target: { scope: "remote", instanceId: "desktop-new" },
            observations: [{
              provider: "openai",
              accountKey: "shared-key",
              observedAt: 1500,
              status: "available",
              dailyUsageBuckets: localBuckets,
            }],
          },
          {
            owner: "Outpost Older Codex",
            target: { scope: "remote", instanceId: "outpost-old-codex" },
            observations: [{
              provider: "openai",
              accountKey: "shared-key",
              observedAt: 3000,
              status: failureStatus,
            }],
          },
          // Separate keyed account that is auth_required / unsupported stays visible on its own.
          {
            owner: "API Key Outpost",
            target: { scope: "remote", instanceId: "outpost-apikey" },
            observations: [{
              provider: "openai",
              accountKey: "apikey-acct",
              observedAt: 2500,
              status: failureStatus,
            }],
          },
          // Mixed-version legacy peer (omits accountTokenUsage) and new Outpost with OpenAI disabled ([]).
          {
            owner: "Legacy Peer",
            target: { scope: "remote", instanceId: "legacy-peer" },
            observations: undefined,
          },
          {
            owner: "Proxy-Only Outpost",
            target: { scope: "remote", instanceId: "proxy-outpost" },
            observations: [],
          },
          // Malformed observation from an untrusted/corrupt peer is ignored cleanly.
          {
            owner: "Corrupt Peer",
            target: { scope: "remote", instanceId: "corrupt-peer" },
            observations: [{ status: "available", observedAt: Number.NaN } as unknown as AccountTokenUsageObservation],
          },
        ];

        const accounts = buildAccountTokenAccounts(sources);
        expect(accounts.map((a) => a.key).sort()).toEqual([
          "account:apikey-acct",
          "account:shared-key",
          "owner:local",
          "owner:remote:remote-keyless",
        ]);

        // Available observation wins over unavailable on the same accountKey.
        const shared = accounts.find((a) => a.key === "account:shared-key")!;
        expect(shared.status).toBe("available");
        expect(shared.dailyUsageBuckets).toEqual(localBuckets);
        expect(shared.owners).toEqual(["New Desktop", "Outpost Older Codex"]);

        // Keyless owners never blend even though their labels match.
        expect(accounts.find((a) => a.key === "owner:local")!.dailyUsageBuckets).toEqual(localBuckets);
        expect(accounts.find((a) => a.key === "owner:remote:remote-keyless")!.dailyUsageBuckets).toEqual(remoteBuckets);

        // Separate unavailable account stays distinct with its status.
        expect(accounts.find((a) => a.key === "account:apikey-acct")!.status).toBe(failureStatus);

        // Quota limits are built solely from UsageLimitObservation, never from account token buckets.
        expect(buildLimitAccounts([{ owner: sharedLabel, target: { scope: "local" } }])).toEqual([]);
      },
    ));
  });

  it("reports includesToday accurately when today's UTC bucket is absent vs present", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 30 }),
      fc.integer({ min: 0, max: 23 }),
      (dayOffset, hourUtc) => {
        const latestDate = addUtcDays(BASE_DATE, dayOffset);
        const [account] = buildAccountTokenAccounts([{
          owner: "Local",
          target: { scope: "local" },
          observations: [{
            provider: "openai",
            accountKey: "acct-today",
            observedAt: utcDateMs(latestDate) + hourUtc * 3_600_000,
            status: "available",
            dailyUsageBuckets: [{ startDate: latestDate, tokens: 123_456 }],
          }],
        }]);
        const sameDayView = buildAccountTokenTrendView({
          account,
          range: "14d",
          now: utcDateMs(latestDate) + hourUtc * 3_600_000,
        });
        const nextDayView = buildAccountTokenTrendView({
          account,
          range: "14d",
          now: utcDateMs(latestDate) + DAY_MS + hourUtc * 3_600_000,
        });
        expect(sameDayView.includesToday).toBe(true);
        expect(nextDayView.includesToday).toBe(false);
        expect(nextDayView.days).toHaveLength(1);
        expect(nextDayView.days[0].date).toBe(latestDate);
      },
    ));
  });
});

describe("buildAccountTokenTrendView calendar span bound", () => {
  it("never charts more calendar days than the bucket cap, however old the first bucket", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000, max: 9_999 }).map((year) => `${year}-01-01`),
        fc.constantFrom("14d" as const, "30d" as const, "90d" as const, "all" as const),
        (firstDate, range) => {
          fc.pre(firstDate < "2026-11-23");
          const [account] = buildAccountTokenAccounts([{
            owner: "Local",
            target: { scope: "local" },
            observations: [{
              provider: "openai",
              accountKey: "acct",
              observedAt: 1,
              status: "available",
              dailyUsageBuckets: [
                { startDate: firstDate, tokens: 1 },
                { startDate: "2026-11-23", tokens: 2 },
              ],
            }],
          }]);
          const view = buildAccountTokenTrendView({ account, range, now: Date.UTC(2026, 10, 24) });
          expect(view.days.length).toBeLessThanOrEqual(MAX_ACCOUNT_TOKEN_USAGE_BUCKETS);
          expect(view.latestDate).toBe("2026-11-23");
        },
      ),
      { numRuns: 25 },
    );
  });
});
