import { expect, it } from "vitest";
import { buildModelVerificationNotice } from "../model-verification-notice";

const base = {
  backend: "codex" as const,
  threadId: "thread-1",
  turnId: "turn-1",
  threadLabel: "Fixture thread",
};

it("names the verification Codex asked for and keeps it until dismissed", () => {
  const notice = buildModelVerificationNotice({
    ...base,
    verifications: ["trustedAccessForCyber", "trustedAccessForCyber"],
  });
  expect(notice).toMatchObject({
    autoDismiss: false,
    tone: "warning",
    title: "Verification requested: Trusted Access for Cyber",
    message: expect.stringContaining("https://chatgpt.com/cyber"),
    threadLink: { backend: "codex", threadId: "thread-1" },
  });
});

it("keeps one notice per turn and machine", () => {
  const local = buildModelVerificationNotice({ ...base, verifications: ["trustedAccessForCyber"] });
  const again = buildModelVerificationNotice({ ...base, verifications: ["aFutureCheck"] });
  const otherTurn = buildModelVerificationNotice({ ...base, turnId: "turn-2", verifications: ["trustedAccessForCyber"] });
  const peer = buildModelVerificationNotice({ ...base, instanceId: "peer-1", verifications: ["trustedAccessForCyber"] });
  expect(again?.id).toBe(local?.id);
  expect(new Set([local?.id, otherTurn?.id, peer?.id]).size).toBe(3);
  expect(again?.title).toBe("Verification requested: a future check");
});

it("shows nothing for an empty request", () => {
  expect(buildModelVerificationNotice({ ...base, verifications: [] })).toBeUndefined();
});
