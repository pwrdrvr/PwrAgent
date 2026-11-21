import type { DesktopSettingsSecretState } from "@pwragent/shared/contracts/settings";

/**
 * What a secret's row says and offers, derived from the stored state and the
 * row's own draft. One module so the status line, the placeholder, and the
 * buttons cannot disagree about whether a value is stored, and so every
 * secret input in the renderer uses the same words for it.
 */
export type SecretFieldTone = "set" | "unset" | "draft" | "override";

/** The status line's tone and words; see `SecretStatusLine`. */
export type SecretStatusView = {
  tone: SecretFieldTone;
  /** The line under the input. The only place the stored state is stated. */
  status: string;
};

export type SecretFieldPresentation = SecretStatusView & {
  /** Never bullets: an empty box must not look like it holds a value. */
  placeholder: string;
  commitLabel: "Save" | "Replace";
  /** The commit button is the row's primary action only while a draft waits. */
  commitIsPrimary: boolean;
  canRemove: boolean;
};

export const SECRET_SAVED = "Saved in keychain";
export const SECRET_UNSET = "Not set";
export const SECRET_PLACEHOLDER = "Paste the value here";
export const SECRET_REPLACE_PLACEHOLDER = "Paste a new value to replace it";
/**
 * Asked before a stored value is deleted. The value is never shown again,
 * so a stray click on Remove meant fetching the token from its provider a
 * second time.
 */
export const SECRET_CONFIRM_REMOVE = "Remove the saved value? You would have to paste it again.";

type SecretStoreState = Pick<DesktopSettingsSecretState, "configured" | "source" | "overriddenByEnv">;

/** A stored-or-not flag as the store state the shared rule reads. */
export function secretStoreState(stored: boolean): SecretStoreState {
  return { configured: stored, source: stored ? "keychain" : "unset" };
}

/**
 * The words for a row with nothing typed in it, shared by the row that
 * writes on its own and the forms that write on Save.
 */
function restingStatus(state: SecretStoreState, savedByRow: boolean): SecretStatusView {
  const fromEnv = state.source === "env";
  const stored = state.configured || savedByRow;
  if (fromEnv && !savedByRow) {
    return {
      tone: "set",
      status: "Set by an environment variable. Unset it to manage the value here.",
    };
  }
  if (fromEnv || (stored && state.overriddenByEnv)) {
    return {
      tone: "override",
      status: savedByRow
        ? "New value saved in keychain. An environment variable overrides it."
        : `${SECRET_SAVED}. An environment variable overrides it.`,
    };
  }
  // Replacing a stored value must not read the same before and after.
  if (savedByRow) return { tone: "set", status: "New value saved in keychain" };
  if (stored) return { tone: "set", status: SECRET_SAVED };
  return { tone: "unset", status: SECRET_UNSET };
}

/** The row that writes on Enter or blur: `SecretField` and onboarding. */
export function describeSecretField(
  state: SecretStoreState,
  row: {
    /** A draft that could be saved, so not whitespace alone. */
    dirty: boolean;
    /** Covers the gap between a write returning and the next snapshot. */
    saved: boolean;
    /** Remove was pressed once and waits for its confirmation. */
    confirmingRemove?: boolean;
    /**
     * Onboarding only: the value was taken but is written to the keychain
     * when setup finishes, because the profile it belongs to may not exist.
     */
    held?: boolean;
  },
): SecretFieldPresentation {
  const fromEnv = state.source === "env";
  const stored = state.configured || row.saved || Boolean(row.held);
  const replaces = stored && !fromEnv;
  const commitLabel = replaces ? "Replace" : "Save";
  const base = {
    placeholder: replaces ? SECRET_REPLACE_PLACEHOLDER : SECRET_PLACEHOLDER,
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
  if (row.confirmingRemove && replaces) {
    return { ...base, tone: "draft", status: SECRET_CONFIRM_REMOVE };
  }
  if (row.held && !row.saved && !state.configured) {
    return { ...base, tone: "set", status: "Saved in keychain when you finish setup" };
  }
  return { ...base, ...restingStatus(state, row.saved) };
}

/**
 * A secret inside a form that writes everything on its own Save button
 * (Federation's edge policy, a model provider, an MCP connection). Typing
 * and Remove only change the form's draft, so the words say when they land.
 */
export function describeFormSecret(
  /**
   * Undefined when the window is not told whether a value is stored (an MCP
   * connection's session bearer token). The words then claim neither, and
   * Remove stays offered because nothing says there is nothing to remove.
   */
  state: SecretStoreState | undefined,
  row: {
    dirty: boolean;
    /** Remove was pressed; the value is deleted when the form saves. */
    removing?: boolean;
  },
  /** Completes "when you …": what the form's own button does. */
  commit = "save",
): SecretStatusView & { placeholder: string; canRemove: boolean } {
  const fromEnv = state?.source === "env";
  const replaces = Boolean(state?.configured) && !fromEnv && !row.removing;
  const base = {
    placeholder: replaces ? SECRET_REPLACE_PLACEHOLDER : SECRET_PLACEHOLDER,
    canRemove: (replaces || (!state && !row.removing)) && !row.dirty,
  };
  if (row.removing) {
    return { ...base, tone: "draft", status: `Not removed yet. Removed when you ${commit}.` };
  }
  if (row.dirty) {
    return {
      ...base,
      tone: "draft",
      status: !state
        ? `Not saved yet. Replaces any saved value when you ${commit}.`
        : replaces
          ? `Not saved yet. Replaces the saved value when you ${commit}.`
          : `Not saved yet. Saved in keychain when you ${commit}.`,
    };
  }
  if (!state) {
    return { ...base, tone: "unset", status: "A saved value is never shown. Leave this blank to keep one." };
  }
  return { ...base, ...restingStatus(state, false) };
}
