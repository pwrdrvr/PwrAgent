import type { ResourceCheckoutActionRequest, ResourceDefinitionDraft } from "@pwragent/shared/contracts/resource-checkouts";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("An object is required.");
  return value as Record<string, unknown>;
}

export function text(value: unknown, label: string, max = 160): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(`Invalid ${label}.`);
  }
  return value.trim();
}

export function positiveInt(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

export function externalKey(value: unknown): string {
  const key = text(value, "canonical key");
  if (!/^external:[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)+$/.test(key)) {
    throw new Error("Use an external:<provider>:<namespace>:<immutable-id> canonical key.");
  }
  return key;
}

function parseDraft(value: unknown): ResourceDefinitionDraft {
  const draft = object(value);
  const sharing = object(draft.sharing);
  const allocationScope = draft.allocationScope;
  if (allocationScope !== "federation" && allocationScope !== "instance" && allocationScope !== "machine") {
    throw new Error("Invalid allocation scope.");
  }
  if (sharing.mode !== "exclusive" && sharing.mode !== "counted") throw new Error("Invalid sharing mode.");
  return {
    canonicalKey: externalKey(draft.canonicalKey), displayName: text(draft.displayName, "display name"),
    kindLabel: text(draft.kindLabel, "kind"), allocationScope,
    sharing: sharing.mode === "exclusive" ? { mode: "exclusive" } : {
      mode: "counted", capacity: positiveInt(sharing.capacity, "capacity", 1_000), inUse: 0,
      unitLabel: text(sharing.unitLabel, "unit label"),
    },
    ...(draft.instructionsSource === undefined ? {} : { instructionsSource: text(draft.instructionsSource, "instructions", 4_000) }),
  };
}

export function parseCheckoutAction(value: unknown): ResourceCheckoutActionRequest {
  const action = object(value);
  const idempotencyKey = text(action.idempotencyKey, "idempotency key");
  if (action.kind === "register_definition") {
    return { kind: action.kind, idempotencyKey, draft: parseDraft(action.draft) };
  }
  const base = { idempotencyKey, resourceId: text(action.resourceId, "resource ID") };
  switch (action.kind) {
    case "request":
      return {
        ...base, kind: action.kind, purpose: text(action.purpose, "purpose", 1_000),
        expectedDurationMs: positiveInt(action.expectedDurationMs, "duration"),
        ...(action.units === undefined ? {} : { units: positiveInt(action.units, "units", 1_000) }),
      };
    case "cancel_request":
      return { ...base, kind: action.kind, queueEntryId: text(action.queueEntryId, "queue entry ID") };
    case "resolve_ownership":
      return { ...base, kind: action.kind, canonicalCandidateId: text(action.canonicalCandidateId, "candidate ID") };
    case "administrative_release":
    case "release":
    case "extend":
    case "fence":
    case "verify_cleanup": {
      const grant = { ...base, allocationId: text(action.allocationId, "allocation ID"), generation: positiveInt(action.generation, "generation") };
      return action.kind === "administrative_release"
        ? { ...grant, kind: action.kind, auditNote: text(action.auditNote, "audit note", 1_000) }
        : { ...grant, kind: action.kind };
    }
    default:
      throw new Error("Unknown resource checkout action.");
  }
}
