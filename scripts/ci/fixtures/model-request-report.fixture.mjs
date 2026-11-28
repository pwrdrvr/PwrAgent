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
  version: 2,
  baseSha: null,
  results: [
    { provider: "codex", observed: metric(codex), ceilings: metric(300) },
    { provider: "claude", observed: metric(claude), ceilings: metric(340) },
    { provider: "acp:antigravity", observed: metric(antigravity), ceilings: metric(380) },
  ],
});

const catalogRow = ({ provider, observed }) => ({
  provider,
  first: { bytes: observed.firstBytes, calls: 1, primaryBytes: observed.firstBytes, inputBytes: 20, instructionBytes: 30, toolBytes: 40 },
  next: { bytes: observed.nextBytes, calls: 1, primaryBytes: observed.nextBytes, inputBytes: 20, instructionBytes: 30, toolBytes: 40 },
  ceilings: { firstBytes: 300, firstCalls: 1, firstToolBytes: 40, nextBytes: 310, nextCalls: 1, nextToolBytes: 40 },
  fullSchemasAdvertised: [false, false],
});
const toolUseRow = ({ provider }) => ({
  provider,
  observed: { bytes: 529, primaryBytes: 200, toolBytes: 40, continuationBytes: 325, calls: 3, roundTripCalls: 2 },
  ceilings: { bytes: 600, primaryBytes: 250, toolBytes: 45, continuationBytes: 400, calls: 3, roundTripCalls: 2 },
});
export const legacyMcpResult = (codex, claude, antigravity) => ({
  version: 1, results: result(codex, claude, antigravity).results.map(catalogRow),
});
export const mcpResult = (codex, claude, antigravity) => {
  const { results } = legacyMcpResult(codex, claude, antigravity);
  const thirdParty = { ...catalogRow(result(120, 200).results[0]), provider: "codex:kimi-k3" };
  return { version: 2, results, thirdParty, toolUse: [...results, thirdParty].map(toolUseRow) };
};
