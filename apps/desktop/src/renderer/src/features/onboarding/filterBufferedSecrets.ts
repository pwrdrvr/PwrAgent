/**
 * Trim + filter wizard-buffered secrets before they hit the
 * `writeSecretsToProfile` IPC. Operates as a pure function so it
 * can be unit-tested without mounting the whole wizard.
 *
 * The wizard buffers secret values typed by the operator in renderer
 * state. At Finish, those values graduate to the chosen profile's
 * keychain. Two filters apply here:
 *
 *   1. Trim. Clipboard-pasted API keys on macOS routinely carry a
 *      trailing newline. A pure-whitespace value (typo, half-typed
 *      input) is treated as no value.
 *   2. Drop empties. The `writeSecretsToProfile` IPC's empty-string
 *      path is for explicit clears (Replay-mode "wipe this stored
 *      secret"). Wizard sessions don't explicit-clear; an empty
 *      value here just means "operator skipped this optional field"
 *      and we want the keychain quiet rather than emit a delete.
 *
 * Returns a new object; the input is never mutated.
 */
export function filterBufferedSecrets(
  secrets: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(secrets)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      out[name] = trimmed;
    }
  }
  return out;
}
