export const mainSha = "a".repeat(40);
export const currentSha = "b".repeat(40);
export const source = { sha: currentSha, id: 20, number: 6, attempt: 1, conclusion: "success" };
export const runUrl = (id) => `https://github.com/example/repo/actions/runs/${id}`;
const metric = (bytes) => ({
  firstBytes: bytes, firstCalls: 1, nextBytes: bytes + 10, nextCalls: 1,
  firstPrimaryBytes: bytes, firstInputBytes: 20, firstInstructionBytes: 30, firstToolBytes: 40,
  nextPrimaryBytes: bytes + 10, nextInputBytes: 25, nextInstructionBytes: 30, nextToolBytes: 40,
});
export const result = (codex, claude, antigravity = 150) => ({
  version: 1,
  results: [
    { provider: "codex", observed: metric(codex), ceilings: metric(300) },
    { provider: "claude", observed: metric(claude), ceilings: metric(340) },
    { provider: "acp:antigravity", observed: metric(antigravity), ceilings: metric(380) },
  ],
});
