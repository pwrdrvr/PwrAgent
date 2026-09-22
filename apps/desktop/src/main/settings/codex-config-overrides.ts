// These keys are owned by PwrAgent's launch/execution plumbing. Reject both
// descendants and parent-table assignments so an inline table cannot replace
// the shell identity that keeps subprocesses in the selected Codex home.
const MANAGED_KEYS = [
  "approval_policy",
  "sandbox_mode",
  "shell_environment_policy.set.PATH",
  "shell_environment_policy.set.CODEX_HOME",
] as const;

/**
 * Process-local Codex CLI overrides, stored in the PwrAgent profile. Values
 * deliberately retain Codex's TOML (and unquoted-string fallback) semantics;
 * PwrAgent validates the envelope, not a second copy of Codex's config schema.
 */
export function validateCodexConfigOverrides(value: unknown): string[] {
  const setting = "models.codex.config_overrides";
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error(`${setting} must be an array of at most 128 key=value strings.`);
  }
  let totalLength = 0;
  return value.map((entry: unknown, index) => {
    // Never include an operator's value in diagnostics: provider overrides
    // can contain URLs, headers, and other sensitive configuration.
    const label = `${setting}[${index}]`;
    if (typeof entry !== "string" || /[\0\r\n]/.test(entry)) {
      throw new Error(`${label} must be a single-line key=value string.`);
    }
    const separator = entry.indexOf("=");
    const key = entry.slice(0, separator).trim();
    const rawValue = entry.slice(separator + 1).trim();
    if (
      separator < 0
      || !/^[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/.test(key)
      || !rawValue
    ) {
      throw new Error(`${label} must use a bare dotted key and a nonempty value.`);
    }
    if (MANAGED_KEYS.some((managed) =>
      key === managed || key.startsWith(`${managed}.`) || managed.startsWith(`${key}.`),
    )) {
      throw new Error(`${label} conflicts with a PwrAgent-managed Codex setting.`);
    }
    const normalized = `${key}=${rawValue}`;
    totalLength += normalized.length;
    if (totalLength > 16_384) {
      throw new Error(`${setting} must contain at most 16384 characters in total.`);
    }
    return normalized;
  });
}
