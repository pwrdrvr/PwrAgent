import type { DesktopSettingsSecretState } from "@pwragent/shared/contracts/settings";

/**
 * What a secret's row says and offers, derived from the stored state and the
 * row's own draft. One function so the status line, the placeholder, and the
 * buttons cannot disagree about whether a value is stored.
 */
export type SecretFieldTone = "set" | "unset" | "draft" | "override";

export type SecretFieldPresentation = {
  tone: SecretFieldTone;
  /** The line under the input. The only place the stored state is stated. */
  status: string;
  /** Never bullets: an empty box must not look like it holds a value. */
  placeholder: string;
  commitLabel: "Save" | "Replace";
  /** The commit button is the row's primary action only while a draft waits. */
  commitIsPrimary: boolean;
  canRemove: boolean;
};

export function describeSecretField(
  state: Pick<DesktopSettingsSecretState, "configured" | "source" | "overriddenByEnv">,
  /** `dirty`: a draft that could be saved, so not whitespace alone. */
  row: { dirty: boolean; saved: boolean },
): SecretFieldPresentation {
  const fromEnv = state.source === "env";
  // `saved` covers the gap between a write returning and the next snapshot.
  const stored = state.configured || row.saved;
  const replaces = stored && !fromEnv;
  const commitLabel = replaces ? "Replace" : "Save";
  const base = {
    placeholder: replaces ? "Paste a new value to replace it" : "Paste the value here",
    commitLabel,
    commitIsPrimary: row.dirty,
    canRemove: replaces,
  } as const;

  if (row.dirty) {
    return {
      ...base,
      tone: "draft",
      status: replaces
        ? "Not saved yet. Press Enter or Replace. The saved value stays until then."
        : "Not saved yet. Press Enter or Save.",
    };
  }
  if (fromEnv && !row.saved) {
    return {
      ...base,
      tone: "set",
      status: "Set by an environment variable. Unset it to manage the value here.",
    };
  }
  if (fromEnv || (stored && state.overriddenByEnv)) {
    return {
      ...base,
      tone: "override",
      status: row.saved
        ? "New value saved in keychain. An environment variable overrides it."
        : "Saved in keychain. An environment variable overrides it.",
    };
  }
  if (row.saved) {
    // Replacing a stored value must not read the same before and after.
    return { ...base, tone: "set", status: "New value saved in keychain" };
  }
  if (stored) {
    return { ...base, tone: "set", status: "Saved in keychain" };
  }
  return { ...base, tone: "unset", status: "Not set" };
}
