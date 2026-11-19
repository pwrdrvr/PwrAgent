import { expect, it } from "vitest";
import fc from "fast-check";
import { approvalBodyWithResponse, questionnaireAnswerValue } from "../messaging/core/messaging-pending-request-helpers";

it("retains approval context and appends the response while removing stale reply instructions", () => {
  fc.assert(fc.property(fc.array(fc.stringMatching(/^[A-Z]{1,12}$/), { minLength: 1, maxLength: 5 }), fc.stringMatching(/^[A-Z]{1,12}$/),
    (context, response) => {
      const body = ["Approval requested", ...context, "Reply with Allow or Deny"].join("\n\n");
      expect(approvalBodyWithResponse(body, response)).toBe([...context, "Response Received: " + response].join("\n\n"));
    }));
});

it("encodes one full nonblank answer and omits blank or absent answers", () => {
  fc.assert(fc.property(fc.stringMatching(/^[A-Z]{1,12}$/), fc.constantFrom(" ", "\t", "\r\n", "\n"), (answer, whitespace) => {
    expect(questionnaireAnswerValue({ kind: "custom", value: whitespace + answer + whitespace })).toEqual([answer]);
    expect(questionnaireAnswerValue({ kind: "option", optionId: "fixture-option", value: whitespace + answer + whitespace })).toEqual([answer]);
    expect(questionnaireAnswerValue({ kind: "custom", value: whitespace })).toEqual([]);
    expect(questionnaireAnswerValue(undefined)).toEqual([]);
    expect(questionnaireAnswerValue(null)).toEqual([]);
  }));
});
