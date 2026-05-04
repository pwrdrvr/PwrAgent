# Transcript Command Output Capture Recipe

This scenario is derived from captured Codex thread
`019ddaa3-60c1-7160-95f3-14744bdfabb7`, where the live protocol and rollout
both contained rich `npm view dive` command output but PwrAgent only rendered a
single command line.

## Stop Point

Stop after the final assistant answer appears and the completed work group is
collapsed. The replay assertion should then expand the work group and command
activity to verify that the captured command output is inspectable.

## Evidence

- `raw.protocol.jsonl`: curated protocol slice with command start,
  `item/commandExecution/outputDelta`, command completion, final answer, and
  the post-turn `thread/read` omission shape.
- `raw.rollout.jsonl`: curated rollout slice with the matching `function_call`
  and `function_call_output` records.
- `replay.fixture.json`: deterministic Electron replay for the visible
  transcript parity assertion.
