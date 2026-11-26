const ELECTRON_IPC_ERROR_PREFIX = /^Error invoking remote method '[^']+': (?:Error: )?/;
const FEDERATION_RPC_ERROR_PREFIX = /^(?:handler_failed|capability_denied|target_unavailable|instance_shutting_down|method_not_found|deadline_expired|missing_target|relay_hop_limit|relay_not_authorized|relay_origin_mismatch|blob_handler_unavailable|blob_transfer_failed): /;

/**
 * Normalize an Electron IPC or Federation RPC error into the owner's
 * human-readable sentence without transport prefixes.
 */
export function researchErrorMessage(error: unknown, fallback = "Research operation failed"): string {
  const text = error instanceof Error ? error.message : fallback;
  const cleaned = text
    .replace(ELECTRON_IPC_ERROR_PREFIX, "")
    .replace(FEDERATION_RPC_ERROR_PREFIX, "")
    .trim();
  return cleaned || fallback;
}
