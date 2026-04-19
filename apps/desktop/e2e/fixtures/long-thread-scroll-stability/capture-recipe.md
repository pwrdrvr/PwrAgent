# Long Thread Scroll Stability

This scenario proves the regression we saw on very long Codex transcripts:

1. Opening the thread should land at the bottom immediately.
2. The transcript must not animate downward after render settles.
3. After scrolling up, switching away, and returning, the saved viewport should
   reopen without drift.

The current `replay.fixture.json` is a contract fixture with a synthetic long
transcript. If we ever need to refresh it from a live capture, use a Codex
thread with hundreds of transcript entries, open it, verify it lands at the
bottom, scroll upward, switch to a second thread, switch back, and stop once
the original viewport is restored.
