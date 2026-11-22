import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_RESOURCE_KEY_EXAMPLE,
  canonicalResourceKeyProblem,
} from "@pwragent/shared/contracts/resource-checkouts";
import { parseCheckoutAction } from "../resource-checkouts/checkout-input";

/**
 * Rule: the Register dialog and the authority agree on what a canonical key
 * is. A key the dialog lets the operator save is one the authority parses,
 * and a key the dialog flags is one the authority refuses, so the dialog
 * never offers Save for a draft that can only fail. Keys valid under the
 * earlier `external:` rule stay valid, so configured bindings keep loading.
 */

function register(canonicalKey: string): unknown {
  return {
    kind: "register_definition",
    idempotencyKey: "key-rule",
    draft: {
      canonicalKey, displayName: "Bench scope", kindLabel: "Device", allocationScope: "machine",
      sharing: { mode: "exclusive" },
    },
  };
}

function authorityAccepts(canonicalKey: string): boolean {
  try {
    parseCheckoutAction(register(canonicalKey));
    return true;
  } catch {
    return false;
  }
}

/** What the dialog sends, or `undefined` when it keeps Save disabled. */
function dialogSends(typed: string): string | undefined {
  const key = typed.trim();
  return key !== "" && canonicalResourceKeyProblem(key) === undefined ? key : undefined;
}

const segment = fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,8}$/);
const keyLike = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.tuple(fc.stringMatching(/^[a-zA-Z0-9._ -]{0,10}$/), fc.constantFrom(":", "::", ""), fc.stringMatching(/^[A-Za-z0-9._/: <>-]{0,20}$/))
    .map(([scheme, colon, rest]) => `${scheme}${colon}${rest}`),
  fc.stringMatching(/^machine:[a-z0-9-]{1,20}(:cpu)?$/),
  fc.string({ minLength: 150, maxLength: 170 }).map((tail) => `device:${tail.replace(/[^A-Za-z0-9]/g, "a")}`),
);

describe("canonical resource keys", () => {
  it("accepts the dialog's example", () => {
    expect(canonicalResourceKeyProblem(CANONICAL_RESOURCE_KEY_EXAMPLE)).toBeUndefined();
    expect(authorityAccepts(CANONICAL_RESOURCE_KEY_EXAMPLE)).toBe(true);
  });

  it("lets the dialog send exactly the keys the authority accepts", () => {
    fc.assert(fc.property(keyLike, (typed) => {
      const sent = dialogSends(typed);
      if (sent !== undefined) expect(authorityAccepts(sent)).toBe(true);
      else if (typed.trim() !== "") expect(authorityAccepts(typed.trim())).toBe(false);
    }), { numRuns: 500 });
  });

  it("reserves machine keys for this machine's capacity", () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z0-9:-]{1,30}$/), (rest) => {
      expect(dialogSends(`machine:${rest}`)).toBeUndefined();
      expect(authorityAccepts(`machine:${rest}`)).toBe(false);
    }));
  });

  it("keeps every key the earlier external rule accepted", () => {
    fc.assert(fc.property(segment, segment, fc.array(segment, { minLength: 1, maxLength: 3 }), (provider, namespace, ids) => {
      const key = `external:${provider}:${namespace}:${ids.join(":")}`;
      fc.pre(key.length <= 160);
      expect(dialogSends(key)).toBe(key);
      expect(authorityAccepts(key)).toBe(true);
    }));
  });
});
