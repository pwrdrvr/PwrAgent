# Thread Scroll Restore

This scenario proves two renderer behaviors that Codex Desktop already has:

1. Switching away from a loaded thread and back should reuse the cached
   transcript instead of issuing another `thread/read`.
2. The transcript viewport should reopen at the last known scroll position
   rather than animating from the top down to the bottom.

The current `replay.fixture.json` is a contract fixture. If we need to refresh
it from a live capture later, record a session with two visible threads, scroll
up in the first transcript, switch to the second thread, then switch back and
stop once the first transcript is restored.
