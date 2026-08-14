export type BoundedOutputMatcher = {
  inspect(chunk: string): void;
  matched(): boolean;
};

/**
 * Match one fixed marker in streamed process output without retaining a log.
 * The overlap is only large enough to recognize a marker split across chunks.
 */
export function createBoundedOutputMatcher(
  expected: string,
): BoundedOutputMatcher {
  if (expected.length === 0) {
    throw new Error("Expected output marker must not be empty");
  }

  let didMatch = false;
  let overlap = "";
  return {
    inspect: (chunk) => {
      if (didMatch) {
        return;
      }
      const combined = `${overlap}${chunk}`;
      didMatch = combined.includes(expected);
      overlap = didMatch
        ? ""
        : combined.slice(-(expected.length - 1));
    },
    matched: () => didMatch,
  };
}
