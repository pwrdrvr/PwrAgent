import {
  INITIAL_THREAD_DEPENDENCY_CONDITIONS,
  THREAD_DEPENDENCY_CI_RUN_MAX_ENVIRONMENTS,
  THREAD_DEPENDENCY_CI_RUN_OUTCOMES,
  THREAD_DEPENDENCY_DELIVERY_TARGETS,
  THREAD_DEPENDENCY_MAX_STEPS,
  THREAD_DEPENDENCY_STEP_MAX_LENGTH,
  THREAD_DEPENDENCY_SUBJECT_MAX_LENGTH,
} from "@pwragent/shared/contracts/thread-dependencies";

/**
 * Shared JSON Schema for `continueAfter` on `handoff_task`, `add_todo`
 * (`action.type = "start_thread"`), and `update_todo`.
 */
export function buildInitialContinueAfterInputSchema(description: string): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    description,
    required: ["conditions", "continuation"],
    properties: {
      conditions: {
        type: "array",
        minItems: 1,
        maxItems: 16,
        description:
          "Prerequisites to wait for. Omit both backend and threadId on a thread prerequisite to wait on this thread (for example, { when: \"pr_merged\", prUrl: \"...\" }).",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["when"],
          properties: {
            backend: {
              type: "string",
              description: "Prerequisite thread backend. Omit alongside threadId to wait on this thread.",
            },
            threadId: {
              type: "string",
              description:
                "Prerequisite thread id. Omit alongside backend to wait on this thread. Omit or pass \"\" for subject or ci_run.",
            },
            when: {
              type: "string",
              enum: [...INITIAL_THREAD_DEPENDENCY_CONDITIONS],
            },
            turnId: { type: "string" },
            prUrl: { type: "string" },
            headSha: { type: "string" },
            title: {
              type: "string",
              maxLength: 200,
              description: "Optional display title. PwrAgent fills it from the thread when omitted.",
            },
            subject: {
              type: "string",
              maxLength: THREAD_DEPENDENCY_SUBJECT_MAX_LENGTH,
              description: "For marked_done work that is not a thread: what has to finish.",
            },
            target: {
              type: "object",
              additionalProperties: false,
              required: ["scope", "instanceId"],
              description: "For marked_done on a thread owned by a connected peer.",
              properties: {
                scope: { type: "string", enum: ["remote"] },
                instanceId: { type: "string" },
              },
            },
            ciRun: {
              type: "object",
              additionalProperties: false,
              required: ["url"],
              description: "For when ci_run: the GitHub Actions run or GitLab pipeline and what wakes the wait.",
              properties: {
                url: { type: "string" },
                on: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", enum: [...THREAD_DEPENDENCY_CI_RUN_OUTCOMES] },
                },
                environments: {
                  type: "array",
                  maxItems: THREAD_DEPENDENCY_CI_RUN_MAX_ENVIRONMENTS,
                  items: { type: "string", maxLength: 100 },
                },
              },
            },
          },
        },
      },
      mode: { type: "string", enum: ["all", "any"] },
      onFailure: { type: "string", enum: ["notify", "wait"] },
      continuation: {
        type: "string",
        maxLength: 8000,
        description:
          "Required. Concrete standalone instructions for the child thread once the prerequisites are met (or the reminder for the operator when deliver is operator).",
      },
      deliver: {
        type: "string",
        enum: [...THREAD_DEPENDENCY_DELIVERY_TARGETS],
        description: "Who acts when the wait fires: agent (default) resumes the child thread; operator raises a reminder to-do card on it.",
      },
      handoff: {
        type: "boolean",
        description: "Only with deliver operator: offer Start thread on the reminder card.",
      },
      steps: {
        type: "array",
        maxItems: THREAD_DEPENDENCY_MAX_STEPS,
        items: { type: "string", maxLength: THREAD_DEPENDENCY_STEP_MAX_LENGTH },
        description: "Only with deliver operator: checklist steps on the reminder card.",
      },
      holdMerge: {
        type: "boolean",
        description: "Refuse merging the child thread's PRs until this wait is met or cancelled.",
      },
      wakeOn: {
        type: "string",
        enum: ["failure"],
        description: "Wake only on failure; a pass ends the wait quietly. Omit to wake on either outcome.",
      },
    },
  };
}
