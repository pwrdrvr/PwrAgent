# Transcript Temporal Order Fixture

This fixture is a minimized replay derived from the May 2, 2026 failure shape for thread `019de585-735e-7aa0-82d7-469a6a32eb80`.

It intentionally checks the chronology that failed in the live app:

1. assistant message
2. tool activity
3. assistant message
4. tool activity
5. assistant message

The live notifications establish precise observed order. The completion step then forces a `thread/read` hydration response where all same-turn entries share one coarse timestamp, matching the class of persisted data that previously allowed tool groups to move above earlier assistant text.
