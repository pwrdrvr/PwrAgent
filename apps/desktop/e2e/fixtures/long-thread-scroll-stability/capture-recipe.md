# Long Thread Scroll Stability

This scenario proves the regression we saw on very long Codex transcripts:

1. Opening the thread should land at the bottom immediately.
2. The transcript must not animate downward after render settles.
3. After saving a middle viewport on one thread and an exact `scrollTop` of zero
   on another, switching between them should restore both viewports without
   drift or an extra replay `thread/read`.

The current `replay.fixture.json` is a contract fixture with a synthetic long
transcript. If we ever need to refresh it from a live capture, use a Codex
thread with hundreds of transcript entries plus a second scrollable thread.
Open the first thread, verify it lands at the bottom, save a middle viewport,
switch to the second thread, save its top viewport, then reselect each thread
and stop once both independent viewports are restored.
