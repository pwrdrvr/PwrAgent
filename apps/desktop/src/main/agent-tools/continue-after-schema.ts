import {
  INITIAL_THREAD_DEPENDENCY_CONDITIONS,
  THREAD_DEPENDENCY_DELIVERY_TARGETS,
} from "@pwragent/shared/contracts/thread-dependencies";

/**
 * Shared JSON Schema for `continueAfter` on `handoff_task`, `add_todo`
 * (`action.type = "start_thread"`), and `update_todo`.
 *
 * Kept compact so eager Antigravity tool declarations stay within their 16 KiB
 * bootstrap budget and `tool_search` stays within its 8,000-char ranked budget.
 * Exact nested shapes, bounds, and unknown-key checks are enforced at runtime
 * by `parseInitialThreadContinueAfter`.
 */
export function buildInitialContinueAfterInputSchema(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    required: ["conditions", "continuation"],
    properties: {
      conditions: {
        type: "array",
        description: "Omit backend and threadId to wait on this thread.",
        items: {
          type: "object",
          required: ["when"],
          properties: {
            backend: { type: "string" },
            threadId: { type: "string" },
            when: { type: "string", enum: [...INITIAL_THREAD_DEPENDENCY_CONDITIONS] },
            turnId: { type: "string" },
            prUrl: { type: "string" },
            headSha: { type: "string" },
            title: { type: "string" },
            subject: { type: "string" },
            target: { type: "object" },
            ciRun: { type: "object" },
          },
        },
      },
      mode: { type: "string", enum: ["all", "any"] },
      onFailure: { type: "string", enum: ["notify", "wait"] },
      continuation: {
        type: "string",
        description: "Instructions when prerequisites are met.",
      },
      deliver: { type: "string", enum: [...THREAD_DEPENDENCY_DELIVERY_TARGETS] },
      handoff: { type: "boolean" },
      steps: { type: "array", items: { type: "string" } },
      holdMerge: { type: "boolean" },
      wakeOn: { type: "string", enum: ["failure"] },
    },
  };
}
