---
title: Questionnaire Option Answer Display - Plan
type: fix
date: 2026-07-17
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Questionnaire Option Answer Display - Plan

## Goal Capsule

- **Objective:** Show the selected button label in questionnaire answer summaries even when the question allows secret free-form input, while continuing to redact typed secret answers.
- **Authority:** The user request and the security boundary in the existing questionnaire formatter override implementation convenience.
- **Execution profile:** Add regression coverage first, make the smallest channel-neutral formatter change, and validate the messaging package boundaries.
- **Stop condition:** Stop if option answers cannot be distinguished from free-form answers without changing the app-server response contract.
- **Tail ownership:** Commit the scoped change, push a feature branch, open a PR, and watch its checks to a decided state.

## Product Contract

### Summary

Questionnaire summaries will display harmless selected option labels while preserving redaction for custom answers entered into secret questions. The behavior applies to every messaging provider through the shared interface formatter.

### Problem Frame

The questionnaire answer model already distinguishes an option click from a custom response, and the controller records the selected option's label as the answer value. The provider-visible formatter currently checks only the question-level secret flag, so it replaces both answer kinds with `Secret answer provided`. This hides non-secret button choices such as a precedence selection even though the label is already available.

### Requirements

- R1. A selected option on a secret question displays its option label in answering, review, and submitted questionnaire text.
- R2. A custom answer on a secret question remains redacted in every provider-visible questionnaire state and its value never appears in formatted text.
- R3. The fix remains channel-neutral so Telegram and every other provider using the shared formatter receive identical semantics without provider-specific branches.

### Scope Boundaries

- In scope: answer-display semantics and regression tests in the messaging interface package.
- Out of scope: changing the app-server questionnaire schema, callback payloads, answer submission values, provider keyboard rendering, or the meaning of `isSecret` for free-form input.

## Planning Contract

### Key Technical Decisions

- KTD1. Redact only custom answers when the question is secret; option answers display their recorded label. (session-settled: user-directed — chosen over redacting every answer on a secret question: button labels are deliberate visible choices and are not secret input.)
- KTD2. Keep the distinction in `messagingQuestionnaireAnswerDisplay`, where answer kind and secret context already meet, so all provider formatters inherit the correction.
- KTD3. Preserve the existing discriminated answer union and controller recording path because they already retain both the option ID and display value.

### Assumptions

- Option labels supplied by the requesting tool are intended to be visible; only user-entered custom values require question-level secret redaction.
- Existing persisted option answers use `kind: "option"`, so no compatibility migration is needed.

## Implementation Units

### U1. Distinguish option labels from secret custom answers

- **Goal:** Correct questionnaire answer display without weakening custom-answer redaction.
- **Requirements:** R1, R2, R3; implements KTD1 and KTD2.
- **Dependencies:** None.
- **Files:** Modify `packages/messaging/interface/src/index.ts` and `packages/messaging/interface/src/__tests__/messaging-interface.test.ts`.
- **Approach:** Extend the existing display contract so the secret marker applies to custom answers, while option answers continue through the normal value-display path. Keep formatting consumers unchanged.
- **Execution note:** Start with failing tests that reproduce current-answer, review-answer, and submitted-answer output from an option click on a secret question, then make the formatter change and retain the existing custom-secret regression.
- **Patterns to follow:** Use the existing `MessagingQuestionnaireAnswer` discriminant and the provider-visible security assertions beside `masks secret questionnaire answers in provider-visible text`.
- **Test scenarios:**
  - A secret question with an option answer displays the option label as the current answer while the questionnaire is active.
  - The same option answer displays its label under both `Review answers` and `Submitted answers` and does not emit `Secret answer provided`.
  - A secret question with a custom answer continues to emit `Secret answer provided` and never includes the custom value.
  - A non-secret custom answer continues to render with the existing `Custom:` prefix.
- **Verification:** The focused messaging-interface tests pass, the package typecheck passes, and repository lint/boundary checks report no new errors.

## Verification Contract

| Gate | Command | Proves |
|---|---|---|
| Regression | `pnpm test packages/messaging/interface/src/__tests__/messaging-interface.test.ts` | Option labels are visible and custom secret values remain masked. |
| Package types | `pnpm --filter @pwragent/messaging-interface typecheck` | The formatter change preserves the shared contract. |
| Correctness lint | `pnpm lint:eslint` | The edited TypeScript satisfies repository correctness rules. |
| Architecture | `pnpm lint:boundaries` | The shared messaging layer still respects dependency boundaries. |

## Definition of Done

- U1's option-answer tests fail on the pre-fix behavior and pass after the implementation.
- Secret custom-answer coverage remains green and asserts that raw secret text is absent.
- No provider-specific workaround or questionnaire schema change is introduced.
- Focused tests, typecheck, ESLint, and boundary validation pass.
- Dead-end or experimental code is absent from the final diff.
- The signed commits are pushed on a named branch and a conventional-title PR is open with CI checked.
