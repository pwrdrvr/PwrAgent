# Thread Image Fit Capture Recipe

This scenario preserves the pasted PNG from Codex thread
`019dd46b-1e50-7463-ab57-0a454b9c31a1` ("Fix Composer Auto Saves").

The source thread contains a user message with a wide pasted screenshot. The
regression checks that transcript image previews scale down to fit their
container while preserving the source aspect ratio, instead of filling a fixed
thumbnail frame and cropping the long edge.

The checked-in `thread-image.png` asset was extracted from the thread's
`input_image` payload in:

```text
~/.codex/sessions/2026/04/28/rollout-2026-04-28T10-08-03-019dd46b-1e50-7463-ab57-0a454b9c31a1.jsonl
```

The Electron spec builds a tight replay fixture dynamically from that asset so
the large data URL does not need to live inline in JSON.
