import { TokenMiserOutputCache } from "./token-miser-output-cache";
import { randomUUID } from "node:crypto";
import {
  TOKEN_MISER_CODE_MODE_MAX_RESPONSE_BYTES,
  TOKEN_MISER_DEFAULT_THRESHOLD_CHARACTERS,
  TOKEN_MISER_ESTIMATED_BYTES_PER_TOKEN,
  TOKEN_MISER_HELPER_INPUT_CAP_BYTES,
  TOKEN_MISER_MODEL_VISIBLE_CAP_BYTES,
  serializeToolResponse,
  takeUtf8Prefix,
  utf8ByteLength,
  type TokenMiserCodeModeOutputPayload,
  type TokenMiserCodeModeReductionOutput,
  type TokenMiserGroupMemberSummary,
  type TokenMiserHelperUsage,
  type TokenMiserHookOutput,
  type TokenMiserObjectMetadata,
  type TokenMiserPostToolUsePayload,
  type TokenMiserSummary,
} from "./token-miser-types.js";
import {
  TokenMiserStore,
  codexVisibleStringRanges,
  type TokenMiserGroupStoredOutput,
  type TokenMiserStagedObject,
} from "./token-miser-store.js";

const TOKEN_MISER_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["disposition", "summary", "usefulDetails"],
  properties: {
    disposition: {
      type: "string",
      enum: ["pass_through", "summarize"],
      description:
        "Whether the ordinary original result should reach the parent unchanged or be replaced by the factual summary.",
    },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: 3_000,
      description: "A concise factual summary of what the tool returned.",
    },
    usefulDetails: {
      type: "array",
      maxItems: 8,
      items: { type: "string", maxLength: 750 },
      description: "Specific filenames, errors, counts, identifiers, or findings worth retaining.",
    },
  },
} as const;

const TOKEN_MISER_GROUP_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["disposition", "summary", "usefulDetails"],
  properties: {
    disposition: TOKEN_MISER_SUMMARY_SCHEMA.properties.disposition,
    summary: TOKEN_MISER_SUMMARY_SCHEMA.properties.summary,
    usefulDetails: TOKEN_MISER_SUMMARY_SCHEMA.properties.usefulDetails,
    members: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["toolCallId", "summary"],
        properties: {
          toolCallId: { type: "string", minLength: 1, maxLength: 500 },
          summary: { type: "string", minLength: 1, maxLength: 1_500 },
        },
      },
    },
  },
} as const;

const TOKEN_MISER_SYSTEM_PROMPT = [
  "You are Token Miser, the first gate on completed coding-tool output before it enters a parent coding agent's context.",
  "Choose pass_through when the visible parent intent and tool/script input show a deliberate, well-targeted request for exact content and the result is coherent, relevant, and likely to be consumed substantially as-is.",
  "Examples that often deserve pass_through are a bounded read of a requested source or instruction file, a concise exact query result, or a focused diagnostic whose details are all material.",
  "Treat a sed range read as a strong pass_through candidate when its lines are distinct, coherent source code or prose from the requested file or range, even when the result is large.",
  "Choose summarize for a sed result that is primarily repetitive data, duplicated records, repeated error or log messages, or content that missed the requested file or range.",
  "Choose summarize for broad or exploratory searches, repetitive matches, verbose logs, test/build output, noisy failures, accidental directory-wide reads, or results that missed the stated intent.",
  "When intent is absent or the choice is uncertain, choose summarize.",
  "The host returns the original bytes itself for pass_through. Never copy or reconstruct the full output in your response.",
  "For pass_through, keep the audit summary under 50 words and omit usefulDetails unless one short fact explains the decision.",
  "Summarize only what is present. Preserve exact filenames, identifiers, errors, counts, and commands that materially describe the result.",
  "Do not recommend actions, searches, reads, refinements, or next steps.",
  "Do not repeat long passages or give general advice. Keep the complete response under 450 words.",
].join("\n");

const TOKEN_MISER_RETRIEVAL_TOOL_NAMES = [
  "search_token_miser_output",
  "read_token_miser_output",
  "read_all_token_miser_output",
  "read_token_miser_output_batch",
] as const;

const MAX_CAPTURED_GROUP_MEMBERS = 16;
const MAX_CAPTURED_GROUP_CHARACTERS = 1_000_000;
const CAPTURED_GROUP_TTL_MS = 2 * 60_000;

const CODE_MODE_ACTIONABLE_STATE_TAG = "codex_actionable_state";

type CapturedGroupMember = {
  toolCallId: string;
  toolName: string;
  toolInput: string;
  output: string;
};

type CapturedGroup = {
  members: Map<string, CapturedGroupMember>;
  characters: number;
  overflowed: boolean;
  timer: NodeJS.Timeout;
};

type TokenMiserDecision = {
  disposition: "pass_through" | "summarize";
  summary: TokenMiserSummary;
};

export type TokenMiserStructuredGenerationResult =
  | ({ status: "ok"; object: unknown } & TokenMiserHelperUsage)
  | { status: "unavailable" | "failed"; reason: string };

export type TokenMiserPreparedCodeModeReduction = {
  response: Extract<
    TokenMiserCodeModeReductionOutput,
    { response_id: string }
  >;
  staged: TokenMiserStagedObject;
};

export type TokenMiserPreparedPostToolUseReduction = {
  hookOutput: TokenMiserHookOutput;
  responseId: string;
  staged: TokenMiserStagedObject;
};

export type TokenMiserServiceOptions = {
  store: TokenMiserStore;
  isEnabled: () => boolean;
  isEnabledByDefault?: () => boolean;
  /**
   * Per-thread override. `undefined` inherits `isEnabledByDefault`; neither
   * value can bypass the outer experiment gate in `isEnabled`.
   */
  isEnabledForThread?: (threadId: string) => Promise<boolean | undefined>;
  generateSummary: (params: {
    model: string;
    reasoningEffort: "medium";
    system: string;
    prompt: string;
    schema: Record<string, unknown>;
    timeoutMs: number;
  }) => Promise<TokenMiserStructuredGenerationResult>;
  onInterceptionStored?: (
    metadata: TokenMiserObjectMetadata,
  ) => void | Promise<void>;
  getParentCumulativeInputTokens?: (threadId: string) => number | undefined;
  /**
   * The model whose context the gate is protecting. Resolved at creation and
   * stamped on the gate, because the usage line pricing would otherwise lean on
   * can be absent — a native review runs on the parent thread with no line of
   * its own, and mid-turn the parent's line may not be priced yet.
   */
  resolveParentModel?: (
    threadId: string,
  ) => Promise<{ model?: string; serviceTier?: string } | undefined>;
  thresholdCharacters?: number;
  summaryTimeoutMs?: number;
  codeModeGroupingVersion?: () => number | undefined;
  postToolUseExactOutputVersion?: () => number | undefined;
};

export class TokenMiserService {
  private readonly thresholdCharacters: number;
  private readonly summaryTimeoutMs: number;
  private readonly capturedGroups = new Map<string, Omit<CapturedGroup, "members">>();
  private readonly capturedOutputs = new TokenMiserOutputCache();

  constructor(private readonly options: TokenMiserServiceOptions) {
    this.thresholdCharacters =
      options.thresholdCharacters ?? TOKEN_MISER_DEFAULT_THRESHOLD_CHARACTERS;
    this.summaryTimeoutMs = options.summaryTimeoutMs ?? 45_000;
  }

  async captureNestedPostToolUse(
    payload: TokenMiserPostToolUsePayload,
  ): Promise<void> {
    if (
      payload.is_code_mode_nested !== true
      || payload.token_miser_grouping_version !== 1
      || this.options.codeModeGroupingVersion?.() !== 1
      || !this.supportsExactPostToolUseOutput(payload)
      || !payload.code_mode_cell_id
      || !payload.code_mode_tool_call_id
      || !await this.isEnabledForThread(payload.session_id)
      || isDirectTokenMiserRetrievalInvocation(payload)
    ) {
      return;
    }
    const output = serializeToolResponse(
      payload.token_miser_exact_tool_response,
    );
    const toolInput = serializeToolResponse(payload.tool_input);
    const key = capturedGroupKey(
      payload.session_id,
      payload.turn_id,
      payload.code_mode_cell_id,
    );
    let group = this.capturedGroups.get(key);
    if (!group) {
      const timer = setTimeout(() => {
        this.capturedGroups.delete(key);
        this.capturedOutputs.remove(key);
      }, CAPTURED_GROUP_TTL_MS);
      timer.unref?.();
      group = { characters: 0, overflowed: false, timer };
      this.capturedGroups.set(key, group);
    }
    const stored = this.capturedOutputs.get(key);
    if (!stored && group.characters > 0) {
      group.overflowed = true;
      return;
    }
    const members = new Map<string, CapturedGroupMember>(stored ? JSON.parse(stored) : []);
    const previous = members.get(payload.code_mode_tool_call_id);
    const nextCharacters = group.characters
      - ((previous?.output.length ?? 0) + (previous?.toolInput.length ?? 0))
      + output.length
      + toolInput.length;
    if (
      (!previous && members.size >= MAX_CAPTURED_GROUP_MEMBERS)
      || nextCharacters > MAX_CAPTURED_GROUP_CHARACTERS
    ) {
      group.overflowed = true;
      return;
    }
    members.set(payload.code_mode_tool_call_id, {
      toolCallId: payload.code_mode_tool_call_id,
      toolName: payload.tool_name,
      toolInput,
      output,
    });
    group.overflowed ||= !this.capturedOutputs.put(key, JSON.stringify([...members]));
    group.characters = nextCharacters;
  }

  /** Prepare a direct-hook replacement; only the bridge's ack may commit it. */
  async preparePostToolUse(
    payload: TokenMiserPostToolUsePayload,
    options: { signal?: AbortSignal } = {},
  ): Promise<TokenMiserPreparedPostToolUseReduction | undefined> {
    // This explicit false is the fork's protocol opt-in. A true marker is a
    // nested result consumed by Code Mode, while a missing marker comes from
    // an unsupported stock Codex whose handling of this replacement is not
    // trustworthy enough to publish savings for it.
    if (
      payload.is_code_mode_nested !== false
      || payload.token_miser_acceptance_version !== 1
      || !this.supportsExactPostToolUseOutput(payload)
    ) {
      return undefined;
    }
    // A thread can opt out of the helper round trip when latency matters more
    // than context. The global experimental flag remains the outer gate.
    if (!await this.isEnabledForThread(payload.session_id)) {
      return undefined;
    }
    if (isDirectTokenMiserRetrievalInvocation(payload)) {
      await this.options.store.confirmModelVisibleRetrievals({
        maxVisibleBytes: TOKEN_MISER_MODEL_VISIBLE_CAP_BYTES,
        output: serializeToolResponse(
          payload.token_miser_exact_tool_response,
        ),
        threadId: payload.session_id,
      });
      return undefined;
    }
    const output = serializeToolResponse(
      payload.token_miser_exact_tool_response,
    );
    if (output.length <= this.thresholdCharacters) {
      return undefined;
    }
    const deterministicPassThrough = classifyDeterministicPassThrough({
      parentIntent: payload.parent_intent,
      request: serializeToolResponse(payload.tool_input),
      outputCharacters: output.length,
    });
    if (deterministicPassThrough) {
      await this.recordPassThroughDecision({
        threadId: payload.session_id,
        turnId: payload.turn_id,
        toolUseId: payload.tool_use_id,
        toolName: payload.tool_name,
        output,
        signal: options.signal,
        summary: deterministicPassThrough,
      });
      return undefined;
    }

    const prepared = await this.summarizeAndStage({
      threadId: payload.session_id,
      turnId: payload.turn_id,
      toolUseId: payload.tool_use_id,
      toolName: payload.tool_name,
      output,
      prompt: buildSummaryPrompt(payload, output),
      signal: options.signal,
    });
    if (!prepared) {
      return undefined;
    }
    if (prepared.disposition === "passed_through") {
      return undefined;
    }

    return {
      hookOutput: {
        continue: false,
        stopReason: prepared.replacement,
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          response_id: prepared.staged.metadata.objectId,
        },
      },
      responseId: prepared.staged.metadata.objectId,
      staged: prepared.staged,
    };
  }

  /** Prepare a code-mode replacement; only the bridge's v2 ack may commit it. */
  async prepareCodeModeOutput(
    payload: TokenMiserCodeModeOutputPayload,
    options: { signal?: AbortSignal } = {},
  ): Promise<TokenMiserPreparedCodeModeReduction | undefined> {
    const capturedGroup = this.takeCapturedGroup(payload);
    if (!await this.isEnabledForThread(payload.thread_id)) {
      return undefined;
    }
    const originalOutput = payload.content_items.map((item) => item.text).join("");
    // Exempt only authenticated delivery bytes. A cell can retrieve source
    // and emit unrelated commands, regardless of what its script calls look like.
    const parts = await this.options.store.partitionRetrievalOutput({
      output: originalOutput,
      threadId: payload.thread_id,
    });
    const hasRetrieval = parts.some((part) => part.retrieval);
    const output = parts.filter((part) => !part.retrieval)
      .map((part) => part.text).join("");
    const retrieval = hasRetrieval && output.trim().length === 0;
    const maxVisibleBytes =
      payload.max_output_tokens * TOKEN_MISER_ESTIMATED_BYTES_PER_TOKEN;
    const replaceNewParts = (replacement: string) => {
      let replaced = false;
      return parts.map((part) => {
        if (part.retrieval) return part;
        const text = replaced ? "" : replacement;
        replaced = true;
        return { text, retrieval: false };
      });
    };
    const replaceNewOutput = (replacement: string) =>
      replaceNewParts(replacement).map((part) => part.text).join("");
    const visibleNewBytes = (visibleParts: typeof parts) => {
      const text = visibleParts.map((part) => part.text).join("");
      const visibleRanges = codexVisibleStringRanges(text, maxVisibleBytes);
      let offset = 0;
      let bytes = 0;
      for (const part of visibleParts) {
        if (!part.retrieval) {
          for (const range of visibleRanges) {
            const start = Math.max(offset, range.start);
            const end = Math.min(offset + part.text.length, range.end);
            if (end > start) bytes += utf8ByteLength(text.slice(start, end));
          }
        }
        offset += part.text.length;
      }
      return bytes;
    };
    const baselineBytes = visibleNewBytes(parts);
    const baselineParentTokenCap = hasRetrieval
      ? Math.max(1, Math.ceil(baselineBytes / TOKEN_MISER_ESTIMATED_BYTES_PER_TOKEN))
      : payload.max_output_tokens;
    const confirmRetrievals = (text: string) => this.options.store.confirmModelVisibleRetrievals({
      maxVisibleBytes,
      output: text,
      threadId: payload.thread_id,
    });
    const nestedKinds = [...(capturedGroup?.members.values() ?? [])].map(
      classifyCapturedGroupMember,
    );
    const recordObservation = async (passedThrough = true) => {
      if (passedThrough) await confirmRetrievals(originalOutput);
      return this.options.store.recordCodeModeObservation({
        threadId: payload.thread_id,
        turnId: payload.turn_id,
        callId: payload.call_id,
        cellId: payload.cell_id,
        outputCharacters: originalOutput.length,
        outputPreview: originalOutput.slice(0, 5_000),
        outputPreviewTruncated: originalOutput.length > 5_000,
        maxOutputTokens: payload.max_output_tokens,
        scriptStatus: payload.script_status,
        ...(payload.script ? { script: payload.script } : {}),
        retrieval,
        capturedNestedInvocationCount: capturedGroup?.members.size || null,
        capturedCommandInvocationCount: capturedGroup ? nestedKinds.filter(
          (kind) => kind === "command",
        ).length : undefined,
        capturedPollingInvocationCount: capturedGroup ? nestedKinds.filter(
          (kind) => kind === "polling",
        ).length : undefined,
        capturedPatchInvocationCount: capturedGroup ? nestedKinds.filter(
          (kind) => kind === "patch",
        ).length : undefined,
        capturedOtherInvocationCount: capturedGroup ? nestedKinds.filter(
          (kind) => kind === "other",
        ).length : undefined,
      });
    };
    if (retrieval || (hasRetrieval && baselineBytes === 0)) {
      await recordObservation();
      return undefined;
    }
    if (output.length <= this.thresholdCharacters) {
      await recordObservation();
      return undefined;
    }
    const actionableNonterminalMember = [...(
      capturedGroup?.members.values() ?? []
    )].find(hasActionableNonterminalState);
    if (actionableNonterminalMember) {
      await this.recordPassThroughDecision({
        threadId: payload.thread_id,
        turnId: payload.turn_id,
        toolUseId: payload.call_id,
        toolName: "Code Mode",
        output,
        signal: options.signal,
        baselineParentTokenCap,
        summary: {
          summary:
            "Passed through because the result contains a live process or session handle needed for a follow-up operation.",
          usefulDetails: [
            `Protected actionable state from ${actionableNonterminalMember.toolName} (${actionableNonterminalMember.toolCallId}).`,
          ],
        },
      });
      await recordObservation();
      return undefined;
    }
    const deterministicPassThrough = classifyDeterministicPassThrough({
      parentIntent: payload.parent_intent,
      request: payload.script ?? "",
      outputCharacters: output.length,
    });
    if (deterministicPassThrough) {
      await this.recordPassThroughDecision({
        threadId: payload.thread_id,
        turnId: payload.turn_id,
        toolUseId: payload.call_id,
        toolName: "Code Mode",
        output,
        signal: options.signal,
        baselineParentTokenCap,
        summary: deterministicPassThrough,
      });
      await recordObservation();
      return undefined;
    }

    if (!hasRetrieval && capturedGroup?.members.size && !capturedGroup.overflowed) {
      const grouped = await this.prepareGroupedCodeModeOutput(
        payload,
        output,
        capturedGroup,
        options,
      );
      if (grouped === "passed_through") {
        await recordObservation();
        return undefined;
      }
      if (grouped) {
        await recordObservation();
        return grouped;
      }
    }

    const prepared = await this.summarizeAndStage({
      threadId: payload.thread_id,
      turnId: payload.turn_id,
      toolUseId: payload.call_id,
      toolName: "Code Mode",
      output,
      prompt: buildCodeModeSummaryPrompt(payload, output),
      signal: options.signal,
      baselineParentTokenCap,
      maxReplacementBytes:
        payload.max_output_tokens
        * TOKEN_MISER_ESTIMATED_BYTES_PER_TOKEN,
      replacementCharacters: (text) =>
        visibleNewBytes(replaceNewParts(text))
        + payload.model_visible_overhead_characters
        + this.codeModeActionableStateCharacters(payload),
    });
    if (!prepared) {
      await recordObservation();
      return undefined;
    }
    if (prepared.disposition === "passed_through") {
      await recordObservation();
      return undefined;
    }
    const response = {
      replacement: [{
        type: "input_text" as const,
        text: replaceNewOutput(prepared.replacement),
      }],
      response_id: prepared.staged.metadata.objectId,
      ...(payload.actionable_state
        ? { actionable_state: payload.actionable_state }
        : {}),
    };
    if (
      Buffer.byteLength(`${JSON.stringify(response)}\n`)
      > TOKEN_MISER_CODE_MODE_MAX_RESPONSE_BYTES
    ) {
      await prepared.staged.discard();
      await recordObservation();
      return undefined;
    }
    await recordObservation(false);
    let committed = false;
    return {
      response,
      staged: {
        ...prepared.staged,
        commit: async () => {
          await prepared.staged.commit();
          if (!committed) {
            committed = true;
            await confirmRetrievals(response.replacement[0].text);
          }
        },
      },
    };
  }

  private takeCapturedGroup(
    payload: TokenMiserCodeModeOutputPayload,
  ): CapturedGroup | undefined {
    const key = capturedGroupKey(
      payload.thread_id,
      payload.turn_id,
      payload.cell_id,
    );
    const group = this.capturedGroups.get(key);
    if (group) {
      clearTimeout(group.timer);
      this.capturedGroups.delete(key);
    }
    if (!group) return undefined;
    const stored = this.capturedOutputs.get(key);
    this.capturedOutputs.remove(key);
    return { ...group, overflowed: group.overflowed || !stored, members: new Map(stored ? JSON.parse(stored) : []) };
  }

  private codeModeActionableStateCharacters(
    payload: TokenMiserCodeModeOutputPayload,
  ): number {
    if (!payload.actionable_state) {
      return 0;
    }
    return utf8ByteLength(
      `<${CODE_MODE_ACTIONABLE_STATE_TAG}>`
      + JSON.stringify(payload.actionable_state)
      + `</${CODE_MODE_ACTIONABLE_STATE_TAG}>`,
    );
  }

  private async prepareGroupedCodeModeOutput(
    payload: TokenMiserCodeModeOutputPayload,
    outerOutput: string,
    group: CapturedGroup,
    options: { signal?: AbortSignal },
  ): Promise<
    TokenMiserPreparedCodeModeReduction | "passed_through" | undefined
  > {
    const members = [...group.members.values()];
    const generated = await this.options.generateSummary({
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      system: TOKEN_MISER_SYSTEM_PROMPT,
      prompt: buildGroupedCodeModeSummaryPrompt(payload, members),
      schema: TOKEN_MISER_GROUP_SUMMARY_SCHEMA,
      timeoutMs: this.summaryTimeoutMs,
    });
    if (options.signal?.aborted || generated.status !== "ok") {
      return undefined;
    }
    const parsed = parseGroupSummary(generated.object, members);
    if (!parsed) {
      return undefined;
    }
    if (parsed.disposition === "pass_through") {
      await this.recordPassThroughDecision({
        threadId: payload.thread_id,
        turnId: payload.turn_id,
        toolUseId: payload.call_id,
        toolName: "Code Mode",
        output: outerOutput,
        signal: options.signal,
        baselineParentTokenCap: payload.max_output_tokens,
        summary: parsed.summary,
        generated,
      });
      return "passed_through";
    }
    const groupMembers: TokenMiserGroupMemberSummary[] = members.map((member) => ({
      objectId: randomUUID(),
      toolCallId: member.toolCallId,
      toolName: member.toolName,
      summary: parsed.members.get(member.toolCallId) ?? "Completed tool result.",
    }));
    const replacement = buildCappedGroupReplacement({
      groupId: payload.cell_id,
      groupMembers,
      maxBytes:
        payload.max_output_tokens * TOKEN_MISER_ESTIMATED_BYTES_PER_TOKEN,
      summary: parsed.summary.summary,
    });
    if (!replacement) {
      return undefined;
    }
    const storedOutput: TokenMiserGroupStoredOutput = {
      version: 1,
      groupId: payload.cell_id,
      members: members.map((member, index) => ({
        objectId: groupMembers[index]!.objectId,
        toolCallId: member.toolCallId,
        toolName: member.toolName,
        output: member.output,
      })),
    };
    const parentModel = await this.options.resolveParentModel?.(
      payload.thread_id,
    ).catch(() => undefined);
    if (options.signal?.aborted) {
      return undefined;
    }
    const staged = await this.options.store.stage({
      threadId: payload.thread_id,
      turnId: payload.turn_id,
      toolUseId: payload.call_id,
      toolName: "Code Mode",
      output: JSON.stringify(storedOutput),
      baselineCharacters: utf8ByteLength(outerOutput),
      baselineParentTokenCap: payload.max_output_tokens,
      replacementCharacters:
        utf8ByteLength(replacement) + payload.model_visible_overhead_characters
        + this.codeModeActionableStateCharacters(payload),
      summary: parsed.summary,
      disposition: "summarized",
      groupId: payload.cell_id,
      groupMembers,
      helperUsage: {
        helperThreadId: generated.helperThreadId,
        helperTurnId: generated.helperTurnId,
        model: generated.model,
        reasoningEffort: generated.reasoningEffort,
        serviceTier: generated.serviceTier,
        tokenUsage: generated.tokenUsage,
      },
      parentCumulativeInputTokens:
        this.options.getParentCumulativeInputTokens?.(payload.thread_id),
      ...(parentModel?.model ? { parentModel: parentModel.model } : {}),
      ...(parentModel?.serviceTier
        ? { parentServiceTier: parentModel.serviceTier }
        : {}),
    });
    const serviceStaged = this.withStoredNotification(staged);
    const response = {
      replacement: [{ type: "input_text" as const, text: replacement }],
      response_id: staged.metadata.objectId,
      ...(payload.actionable_state
        ? { actionable_state: payload.actionable_state }
        : {}),
    };
    if (
      Buffer.byteLength(`${JSON.stringify(response)}\n`)
      > TOKEN_MISER_CODE_MODE_MAX_RESPONSE_BYTES
    ) {
      await staged.discard();
      return undefined;
    }
    return { response, staged: serviceStaged };
  }

  private withStoredNotification(
    staged: TokenMiserStagedObject,
  ): TokenMiserStagedObject {
    let notification: Promise<void> | undefined;
    return {
      metadata: staged.metadata,
      persist: () => staged.persist(),
      discard: () => staged.discard(),
      commit: async () => {
        await staged.commit();
        notification ??= Promise.resolve(
          this.options.onInterceptionStored?.(staged.metadata),
        );
        await notification;
      },
    };
  }

  private supportsExactPostToolUseOutput(
    payload: TokenMiserPostToolUsePayload,
  ): boolean {
    return (
      payload.token_miser_exact_tool_response_version === 1
      && Object.prototype.hasOwnProperty.call(
        payload,
        "token_miser_exact_tool_response",
      )
      && (
        !this.options.postToolUseExactOutputVersion
        || this.options.postToolUseExactOutputVersion() === 1
      )
    );
  }

  private async isEnabledForThread(threadId: string): Promise<boolean> {
    if (!this.options.isEnabled()) {
      return false;
    }
    const threadOverride = await this.options.isEnabledForThread
      ?.(threadId)
      .catch(() => undefined);
    return threadOverride ?? this.options.isEnabledByDefault?.() ?? true;
  }

  private async summarizeAndStage(params: {
    threadId: string;
    turnId: string;
    toolUseId: string;
    toolName: string;
    output: string;
    prompt: string;
    signal?: AbortSignal;
    baselineParentTokenCap?: number;
    maxReplacementBytes?: number;
    replacementCharacters?: (replacement: string) => number;
  }): Promise<{
    disposition: "summarized";
    replacement: string;
    staged: TokenMiserStagedObject;
  } | {
    disposition: "passed_through";
  } | undefined> {
    if (params.signal?.aborted) {
      return undefined;
    }
    const generated = await this.options.generateSummary({
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      system: TOKEN_MISER_SYSTEM_PROMPT,
      prompt: params.prompt,
      schema: TOKEN_MISER_SUMMARY_SCHEMA,
      timeoutMs: this.summaryTimeoutMs,
    });
    // Codex owns a stricter round-trip timeout than the helper. If it has
    // already disconnected, a late Luna answer must not create a phantom gate
    // or claim savings for content Codex never received.
    if (params.signal?.aborted) {
      return undefined;
    }
    if (generated.status !== "ok") {
      return undefined;
    }
    const decision = parseDecision(generated.object);
    if (!decision) {
      return undefined;
    }

    if (decision.disposition === "pass_through") {
      await this.recordPassThroughDecision({
        ...params,
        generated,
        summary: decision.summary,
      });
      return { disposition: "passed_through" };
    }

    const objectId = randomUUID();
    const replacement = buildCappedReplacement({
      maxBytes:
        params.maxReplacementBytes ?? TOKEN_MISER_MODEL_VISIBLE_CAP_BYTES,
      objectId,
      summary: decision.summary,
    });
    if (!replacement) {
      return undefined;
    }
    const parentModel = await this.options.resolveParentModel?.(
      params.threadId,
    ).catch(() => undefined);
    if (params.signal?.aborted) {
      return undefined;
    }
    const staged = await this.options.store.stage({
      objectId,
      threadId: params.threadId,
      turnId: params.turnId,
      toolUseId: params.toolUseId,
      toolName: params.toolName,
      output: params.output,
      replacementCharacters:
        params.replacementCharacters?.(replacement) ?? utf8ByteLength(replacement),
      summary: decision.summary,
      disposition: "summarized",
      helperUsage: {
        helperThreadId: generated.helperThreadId,
        helperTurnId: generated.helperTurnId,
        model: generated.model,
        reasoningEffort: generated.reasoningEffort,
        serviceTier: generated.serviceTier,
        tokenUsage: generated.tokenUsage,
      },
      parentCumulativeInputTokens:
        this.options.getParentCumulativeInputTokens?.(params.threadId),
      ...(params.baselineParentTokenCap !== undefined
        ? { baselineParentTokenCap: params.baselineParentTokenCap }
        : {}),
      ...(parentModel?.model ? { parentModel: parentModel.model } : {}),
      ...(parentModel?.serviceTier
        ? { parentServiceTier: parentModel.serviceTier }
        : {}),
    });
    if (params.signal?.aborted) {
      await staged.discard();
      return undefined;
    }
    const serviceStaged = this.withStoredNotification(staged);
    return { disposition: "summarized", replacement, staged: serviceStaged };
  }

  private async recordPassThroughDecision(params: {
    threadId: string;
    turnId: string;
    toolUseId: string;
    toolName: string;
    output: string;
    signal?: AbortSignal;
    baselineParentTokenCap?: number;
    summary: TokenMiserSummary;
    generated?: Extract<TokenMiserStructuredGenerationResult, { status: "ok" }>;
  }): Promise<void> {
    const parentModel = await this.options.resolveParentModel?.(
      params.threadId,
    ).catch(() => undefined);
    const visibleCharacters = Math.min(
      utf8ByteLength(params.output),
      (params.baselineParentTokenCap ?? 10_000)
      * TOKEN_MISER_ESTIMATED_BYTES_PER_TOKEN,
    );
    const staged = await this.options.store.stage({
      threadId: params.threadId,
      turnId: params.turnId,
      toolUseId: params.toolUseId,
      toolName: params.toolName,
      // A pass-through has no preserved object. Keep an empty private payload
      // beside its accounting record so retrieval can never expose a second
      // copy of content the parent already received.
      output: "",
      baselineCharacters: utf8ByteLength(params.output),
      ...(params.baselineParentTokenCap !== undefined
        ? { baselineParentTokenCap: params.baselineParentTokenCap }
        : {}),
      replacementCharacters: visibleCharacters,
      summary: params.summary,
      disposition: "passed_through",
      ...(params.generated
        ? {
            helperUsage: {
              helperThreadId: params.generated.helperThreadId,
              helperTurnId: params.generated.helperTurnId,
              model: params.generated.model,
              reasoningEffort: params.generated.reasoningEffort,
              serviceTier: params.generated.serviceTier,
              tokenUsage: params.generated.tokenUsage,
            },
          }
        : {}),
      parentCumulativeInputTokens:
        this.options.getParentCumulativeInputTokens?.(params.threadId),
      ...(parentModel?.model ? { parentModel: parentModel.model } : {}),
      ...(parentModel?.serviceTier
        ? { parentServiceTier: parentModel.serviceTier }
        : {}),
    });
    await this.withStoredNotification(staged).commit();
  }
}

function hasActionableNonterminalState(member: CapturedGroupMember): boolean {
  const output = member.output;
  const hasSessionOrProcessHandle = /(?:session|process)[_\s-]*id\b/i.test(output);
  const hasChunkHandle = /chunk[_\s-]*id\b/i.test(output);
  const hasRunningState = /\b(?:in[_\s-]*progress|running|still running|yielded)\b/i
    .test(output);
  const hasTerminalState = /(?:exit[_\s-]*code\s*[":=]+\s*-?\d+|script completed|\bcompleted\b)/i
    .test(output);
  return (
    hasSessionOrProcessHandle
    && !hasTerminalState
  ) || (
    hasChunkHandle
    && hasRunningState
    && !hasTerminalState
  );
}

const INSTRUCTION_FILE_PATTERN = /(?:^|[/\\])(?:AGENTS|CLAUDE|SKILL)\.md\b|(?:^|[/\\])UI-THEME\.md\b|(?:^|[/\\])[^\s"']*style-guide\.md\b/i;
const SOURCE_FILE_PATTERN = /(?:^|[\s"'=:])[^\s"']+\.(?:c|cc|cpp|css|go|h|hpp|html|java|js|jsx|json|md|mjs|py|rb|rs|swift|toml|ts|tsx|yaml|yml)\b/i;
const EXACT_READ_PATTERN = /\b(?:cat|head|tail|sed|readFile|read_text_file|read_file)\b/i;
const BROAD_DISCOVERY_PATTERN = /\b(?:find|grep|rg|search)\b/i;
const READ_INTENT_PATTERN = /\b(?:read|inspect|review|load|follow)\b[\s\S]{0,120}\b(?:instruction|guidance|guide|AGENTS|CLAUDE|SKILL|theme)\b|\b(?:instruction|guidance|guide|AGENTS|CLAUDE|SKILL|theme)\b[\s\S]{0,120}\b(?:read|inspect|review|load|follow)\b/i;
const EXACT_SOURCE_INTENT_PATTERN = /\b(?:read|inspect|review|open|examine|look at)\b[\s\S]{0,160}\b(?:exact|source|file|range|implementation|code)\b|\b(?:exact|source|file|range|implementation|code)\b[\s\S]{0,160}\b(?:read|inspect|review|open|examine|look at)\b/i;
const TARGETED_SOURCE_PASS_THROUGH_MAX_CHARACTERS = 20_000;

function classifyDeterministicPassThrough(params: {
  parentIntent?: string;
  request: string;
  outputCharacters: number;
}): TokenMiserSummary | undefined {
  if (
    !EXACT_READ_PATTERN.test(params.request)
    || BROAD_DISCOVERY_PATTERN.test(params.request)
  ) {
    return undefined;
  }
  if (
    INSTRUCTION_FILE_PATTERN.test(params.request)
    && (!params.parentIntent || READ_INTENT_PATTERN.test(params.parentIntent))
  ) {
    return {
      summary: "A deliberate exact instruction-file read passed through unchanged by policy.",
      usefulDetails: [],
    };
  }
  if (
    params.parentIntent
    && params.outputCharacters <= TARGETED_SOURCE_PASS_THROUGH_MAX_CHARACTERS
    && EXACT_SOURCE_INTENT_PATTERN.test(params.parentIntent)
    && SOURCE_FILE_PATTERN.test(params.request)
  ) {
    return {
      summary: "A bounded exact source read passed through unchanged by policy.",
      usefulDetails: [],
    };
  }
  return undefined;
}

function buildSummaryPrompt(
  payload: TokenMiserPostToolUsePayload,
  output: string,
): string {
  const metadata = [
    `Tool: ${payload.tool_name}`,
    `Visible parent intent before the call: ${payload.parent_intent ?? "Not available"}`,
    `Tool input: ${serializeToolResponse(payload.tool_input)}`,
    "Ordinary model-visible output cap: 10000 estimated tokens",
    `Output characters: ${output.length}`,
  ].join("\n");
  return buildHelperPromptWithReservedOutput({
    metadata,
    output,
    outputLabel: "Tool output:",
  });
}

function buildCodeModeSummaryPrompt(
  payload: TokenMiserCodeModeOutputPayload,
  output: string,
): string {
  const metadata = [
    "Tool: Code Mode",
    `Call ID: ${payload.call_id}`,
    `Cell ID: ${payload.cell_id}`,
    `Visible parent intent before the cell: ${payload.parent_intent ?? "Not available"}`,
    `Script status: ${payload.script_status}`,
    `Script: ${payload.script ?? "Not available"}`,
    `Model-visible output budget: ${payload.max_output_tokens} tokens`,
    `Output characters: ${output.length}`,
  ].join("\n");
  return buildHelperPromptWithReservedOutput({
    metadata,
    output,
    outputLabel: "Script output:",
  });
}

function buildGroupedCodeModeSummaryPrompt(
  payload: TokenMiserCodeModeOutputPayload,
  members: CapturedGroupMember[],
): string {
  const header = [
    "Summarize this completed parallel Code Mode cell as one group.",
    `Group ID: ${payload.cell_id}`,
    `Script status: ${payload.script_status}`,
    `Model-visible output budget: ${payload.max_output_tokens} tokens`,
    "Return one factual group summary and one factual summary for every toolCallId.",
    "Broad parallel probes are expected. Do not recommend serial follow-up operations.",
    `Member IDs: ${members.map((member) => member.toolCallId).join(", ")}`,
  ].join("\n");
  const contextMetadata = [
    `Visible parent intent before the cell: ${payload.parent_intent ?? "Not available"}`,
    `Script: ${payload.script ?? "Not available"}`,
    ...members.map((member) => [
      `toolCallId: ${member.toolCallId}`,
      `toolInput: ${member.toolInput}`,
    ].join("\n")),
  ].join("\n");
  const memberHeaders = members.map((member, index) => [
    `Member ${index + 1}`,
    `toolCallId: ${member.toolCallId}`,
    `toolName: ${member.toolName}`,
    `outputCharacters: ${member.output.length}`,
    "output:",
  ].join("\n"));
  const assemblePrompt = (metadata: string, outputs: readonly string[]) => [
    header,
    "",
    "Context metadata:",
    metadata,
    ...memberHeaders.flatMap((memberHeader, index) => [
      "",
      memberHeader,
      outputs[index] ?? "",
    ]),
  ].join("\n");
  const promptBudget = helperPromptBudget();
  const emptyPrompt = assemblePrompt("", members.map(() => ""));
  const reservedOutputBytes = Math.min(
    TOKEN_MISER_MODEL_VISIBLE_CAP_BYTES,
    members.reduce(
      (total, member) => total + utf8ByteLength(member.output),
      0,
    ),
  );
  const metadataBudget = Math.max(
    0,
    promptBudget
    - reservedOutputBytes
    - utf8ByteLength(emptyPrompt),
  );
  const boundedMetadata = capTextToUtf8Bytes(
    contextMetadata,
    metadataBudget,
    "\n… context metadata truncated",
  );
  const fixedPrompt = assemblePrompt(boundedMetadata, members.map(() => ""));
  const outputBudget = Math.max(
    0,
    promptBudget - utf8ByteLength(fixedPrompt),
  );
  const memberBudgets = distributeFairByteBudget(
    members.map((member) => utf8ByteLength(member.output)),
    outputBudget,
  );
  const boundedOutputs = members.map(
    (member, index) => capTextToUtf8Bytes(
      member.output,
      memberBudgets[index]!,
      "\n… member output truncated",
    ),
  );
  return assemblePrompt(boundedMetadata, boundedOutputs);
}

function buildHelperPromptWithReservedOutput(params: {
  metadata: string;
  output: string;
  outputLabel: string;
}): string {
  const separator = `\n\n${params.outputLabel}\n`;
  const promptBudget = helperPromptBudget();
  const reservedOutputBytes = Math.min(
    TOKEN_MISER_MODEL_VISIBLE_CAP_BYTES,
    utf8ByteLength(params.output),
  );
  const metadataBudget = Math.max(
    0,
    promptBudget
    - reservedOutputBytes
    - utf8ByteLength(separator),
  );
  const metadata = capTextToUtf8Bytes(
    params.metadata,
    metadataBudget,
    "\n… metadata truncated",
  );
  const outputBudget = Math.max(
    0,
    promptBudget - utf8ByteLength(metadata) - utf8ByteLength(separator),
  );
  const output = capTextToUtf8Bytes(
    params.output,
    outputBudget,
    "\n… source truncated at the projected 20k-token Luna input cap",
  );
  return `${metadata}${separator}${output}`;
}

function helperPromptBudget(): number {
  return Math.max(
    0,
    TOKEN_MISER_HELPER_INPUT_CAP_BYTES
    - utf8ByteLength(TOKEN_MISER_SYSTEM_PROMPT),
  );
}

function distributeFairByteBudget(
  lengths: readonly number[],
  totalBudget: number,
): number[] {
  const budgets = lengths.map(() => 0);
  let remainingBudget = totalBudget;
  let remaining = lengths.map((_, index) => index);
  while (remaining.length > 0 && remainingBudget > 0) {
    const share = Math.floor(remainingBudget / remaining.length);
    const completed = remaining.filter((index) => lengths[index]! <= share);
    if (completed.length > 0) {
      for (const index of completed) {
        budgets[index] = lengths[index]!;
        remainingBudget -= lengths[index]!;
      }
      const completedSet = new Set(completed);
      remaining = remaining.filter((index) => !completedSet.has(index));
      continue;
    }
    for (const index of remaining) {
      budgets[index] = share;
      remainingBudget -= share;
    }
    for (const index of remaining) {
      if (remainingBudget <= 0) break;
      budgets[index] = budgets[index]! + 1;
      remainingBudget -= 1;
    }
    break;
  }
  return budgets;
}

function capTextToUtf8Bytes(
  text: string,
  maxBytes: number,
  marker: string,
): string {
  if (utf8ByteLength(text) <= maxBytes) {
    return text;
  }
  const markerBytes = utf8ByteLength(marker);
  if (maxBytes <= markerBytes) {
    return takeUtf8Prefix(text, maxBytes);
  }
  return `${takeUtf8Prefix(text, maxBytes - markerBytes)}${marker}`;
}

function buildCappedReplacement(params: {
  maxBytes: number;
  objectId: string;
  summary: TokenMiserSummary;
}): string | undefined {
  const full = buildReplacement(params);
  if (utf8ByteLength(full) <= params.maxBytes) {
    return full;
  }
  const reference = `Output reference: ${params.objectId} (temporary, expires within 5m)`;
  if (utf8ByteLength(reference) > params.maxBytes) {
    return undefined;
  }
  const separator = "\n\n";
  const bodyBudget = Math.max(
    0,
    params.maxBytes - utf8ByteLength(reference) - utf8ByteLength(separator),
  );
  const body = capTextToUtf8Bytes(
    buildReplacementBody(params.summary),
    bodyBudget,
    "… summary truncated",
  );
  return body ? `${body}${separator}${reference}` : reference;
}

function buildReplacement(params: {
  objectId: string;
  summary: TokenMiserSummary;
}): string {
  return [
    buildReplacementBody(params.summary),
    "",
    `Output reference: ${params.objectId}`,
    "Original output is temporary (up to five minutes); expiry, eviction or restart makes it unavailable.",
  ].join("\n");
}

function buildReplacementBody(summary: TokenMiserSummary): string {
  const details = summary.usefulDetails.length > 0
    ? summary.usefulDetails.map((detail) => `- ${detail}`).join("\n")
    : "- No additional facts were retained.";
  return [
    `Summary: ${summary.summary}`,
    "",
    "Facts:",
    details,
  ].join("\n");
}

function buildCappedGroupReplacement(params: {
  groupId: string;
  groupMembers: TokenMiserGroupMemberSummary[];
  maxBytes: number;
  summary: string;
}): string | undefined {
  const full = JSON.stringify({
    kind: "tool_output_group_summary",
    groupId: params.groupId,
    summary: params.summary,
    members: params.groupMembers.map((member) => ({
      objectId: member.objectId,
      toolName: member.toolName,
      summary: member.summary,
    })),
    sourceMaterial: "Temporary: expires within five minutes; unavailable after eviction or restart.",
  }, null, 2);
  if (utf8ByteLength(full) <= params.maxBytes) {
    return full;
  }
  const compact = JSON.stringify({
    kind: "tool_output_group_summary",
    groupId: params.groupId,
    summary: "Summary truncated to retain recovery references.",
    members: params.groupMembers.map((member) => ({
      objectId: member.objectId,
      toolName: member.toolName,
    })),
    sourceMaterial: "Temporary group/member retrieval; expires within five minutes or earlier.",
  });
  if (utf8ByteLength(compact) <= params.maxBytes) {
    return compact;
  }
  const referencesOnly = JSON.stringify({
    kind: "tool_output_group_reference",
    groupId: params.groupId,
    members: params.groupMembers.map((member) => member.objectId),
  });
  return utf8ByteLength(referencesOnly) <= params.maxBytes
    ? referencesOnly
    : undefined;
}

function parseSummary(value: unknown): TokenMiserSummary | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.summary !== "string"
    || !record.summary.trim()
    || !Array.isArray(record.usefulDetails)
    || !record.usefulDetails.every((entry) => typeof entry === "string")
    || (
      record.suggestedNextStep !== undefined
      && typeof record.suggestedNextStep !== "string"
    )
  ) {
    return undefined;
  }
  return {
    summary: record.summary.trim(),
    usefulDetails: record.usefulDetails
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 8),
    ...(typeof record.suggestedNextStep === "string"
      && record.suggestedNextStep.trim()
      ? { suggestedNextStep: record.suggestedNextStep.trim() }
      : {}),
  };
}

function parseDecision(value: unknown): TokenMiserDecision | undefined {
  const summary = parseSummary(value);
  if (!summary || !value || typeof value !== "object") {
    return undefined;
  }
  const disposition = (value as Record<string, unknown>).disposition;
  if (disposition !== "pass_through" && disposition !== "summarize") {
    return undefined;
  }
  return { disposition, summary };
}

function parseGroupSummary(
  value: unknown,
  capturedMembers: CapturedGroupMember[],
): {
  disposition: TokenMiserDecision["disposition"];
  summary: TokenMiserSummary;
  members: Map<string, string>;
} | undefined {
  const decision = parseDecision(value);
  if (!decision || !value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (decision.disposition === "pass_through") {
    return {
      disposition: decision.disposition,
      summary: decision.summary,
      members: new Map(),
    };
  }
  if (!Array.isArray(record.members)) {
    return undefined;
  }
  const allowedIds = new Set(capturedMembers.map((member) => member.toolCallId));
  const members = new Map<string, string>();
  for (const entry of record.members) {
    if (!entry || typeof entry !== "object") {
      return undefined;
    }
    const member = entry as Record<string, unknown>;
    if (
      typeof member.toolCallId !== "string"
      || !allowedIds.has(member.toolCallId)
      || typeof member.summary !== "string"
      || !member.summary.trim()
    ) {
      return undefined;
    }
    members.set(member.toolCallId, member.summary.trim());
  }
  if (members.size !== capturedMembers.length) {
    return undefined;
  }
  return { disposition: decision.disposition, summary: decision.summary, members };
}

function capturedGroupKey(
  threadId: string,
  turnId: string,
  cellId: string,
): string {
  return JSON.stringify([threadId, turnId, cellId]);
}

function classifyCapturedGroupMember(
  member: CapturedGroupMember,
): "command" | "other" | "patch" | "polling" {
  const name = member.toolName.toLowerCase();
  const input = member.toolInput.toLowerCase();
  if (
    name.includes("write_stdin")
    || name.includes("wait")
    || name.includes("poll")
    || (
      (input.includes('"session_id"') || input.includes('"cell_id"'))
      && !input.includes('"cmd"')
    )
  ) {
    return "polling";
  }
  if (
    name.includes("apply_patch")
    || name.includes("patch")
  ) {
    return "patch";
  }
  if (
    name.includes("bash")
    || name.includes("command")
    || name.includes("exec")
    || name.includes("read")
    || name.includes("search")
    || name.includes("shell")
  ) {
    return "command";
  }
  return "other";
}

function isDirectTokenMiserRetrievalInvocation(
  payload: TokenMiserPostToolUsePayload,
): boolean {
  if (isTokenMiserRetrievalToolName(payload.tool_name)) {
    return true;
  }
  if (!payload.tool_input || typeof payload.tool_input !== "object") {
    return false;
  }
  const input = payload.tool_input as Record<string, unknown>;
  return [input.tool, input.name, input.operation].some((value) =>
    typeof value === "string" && isTokenMiserRetrievalToolName(value)
  );
}

function isTokenMiserRetrievalToolName(value: string): boolean {
  return TOKEN_MISER_RETRIEVAL_TOOL_NAMES.some((name) =>
    value === name
    || value.endsWith(`.${name}`)
    || value.endsWith(`__${name}`)
    || value.endsWith(`/${name}`)
  );
}
