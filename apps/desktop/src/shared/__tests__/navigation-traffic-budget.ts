import type { NavigationQueryRequest } from "@pwragent/shared";

/** Include diagnostic wire overhead without depending on process-lifetime counter
 * values (9 -> 10, or another fixture allocating a view). Charge every counter at
 * its maximum safe-integer width. Cause/trigger strings and all other fields stay
 * intact, so adding metadata still changes the checked-in traffic budget. */
export function navigationRequestByteBudget(request: NavigationQueryRequest): { requestBytes: number; diagnosticBytes: number } {
  const diagnostic = request.diagnostic ? { ...request.diagnostic,
    view: Number.MAX_SAFE_INTEGER, effect: Number.MAX_SAFE_INTEGER,
    logical: Number.MAX_SAFE_INTEGER, attempt: Number.MAX_SAFE_INTEGER, invalidations: Number.MAX_SAFE_INTEGER,
  } : undefined;
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const requestBytes = bytes({ ...request, diagnostic });
  return { requestBytes, diagnosticBytes: requestBytes - bytes({ ...request, diagnostic: undefined }) };
}
