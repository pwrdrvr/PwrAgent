export type FocusedDiffDisposition = "show" | "hide";

export type FocusedDiffReasonCode =
  | "comment_only"
  | "formatting_only"
  | "import_reorder"
  | "keep"
  | "mechanical_small_change"
  | "repetitive_small_change"
  | "uncertain";

export type FocusedDiffHunkSummary = {
  index: number;
  header: string;
  addedLines: string[];
  removedLines: string[];
  contextBefore: string[];
  contextAfter: string[];
  changedLineCount: number;
  contextLineCount: number;
};

export type FocusedDiffAnalysisRequest = {
  filePath?: string;
  diff: string;
  hunks: FocusedDiffHunkSummary[];
};

export type FocusedDiffHunkDecision = {
  index: number;
  disposition: FocusedDiffDisposition;
  reasonCode: FocusedDiffReasonCode;
  reason: string;
  confidence: number;
};

export type FocusedDiffAnalysisMode = "fallback" | "focused" | "full";

export type FocusedDiffAnalysisSource =
  | "cache"
  | "grok"
  | "heuristic"
  | "ineligible"
  /** The diff condensation experimental setting is off. */
  | "condensation-disabled";

export type FocusedDiffAnalysisResponse = {
  mode: FocusedDiffAnalysisMode;
  source: FocusedDiffAnalysisSource;
  hiddenHunkIndices: number[];
  hiddenHunkCount: number;
  decisions: FocusedDiffHunkDecision[];
  cachedTokens?: number;
  reason?: string;
};
