/**
 * Keyboard shortcuts: the action registry, the chord grammar, and the rules
 * that decide whether a chord can be bound. Main and the renderer both import
 * this module, so the menu, the renderer's key listeners and Settings →
 * Keyboard read one definition.
 *
 * Chords use Electron's accelerator grammar ("CmdOrCtrl+Shift+P", "F2",
 * "Alt+Left"). The menu takes them as they are, the renderer matches them
 * against keydown events through {@link matchesChord}, and the operator's
 * overrides store them in `~/.pwragent/keybindings.toml`. Only overrides are
 * stored, so a new default reaches everyone who never changed that action.
 *
 * `CmdOrCtrl` resolves per platform: ⌘ on macOS, Ctrl elsewhere. When the
 * platform is unknown (a unit test without the desktop bridge) it matches
 * either key, as the renderer's older `isPrimaryAccel` did.
 */

export type KeybindingGroupId = "threads" | "navigation" | "layout";

export type KeybindingActionId =
  | "threads.new"
  | "threads.rename"
  | "threads.archive"
  | "threads.toggle_pin"
  | "threads.toggle_keep_at_top"
  | "threads.toggle_unread"
  | "threads.lock"
  | "threads.copy_link"
  | "threads.move_up"
  | "threads.move_down"
  | "navigation.jump_to_thread"
  | "navigation.search_threads"
  | "navigation.find"
  | "navigation.back"
  | "navigation.forward"
  | "layout.toggle_sidebar"
  | "layout.toggle_context_rail";

/**
 * Where an action's chord is listened for.
 *
 * - `global`: anywhere in the main window.
 * - `thread`: acts on the focused or selected sidebar rows, else the open
 *   thread.
 * - `row`: only while a sidebar row has keyboard focus. Move Up and Move Down
 *   use chords that extend a text selection, so they never fire in a field.
 * - `menu`: the application menu's accelerator owns the key (New Thread), so
 *   the renderer never listens for it.
 */
export type KeybindingScope = "global" | "thread" | "row" | "menu";

export type KeybindingActionDefinition = {
  id: KeybindingActionId;
  group: KeybindingGroupId;
  label: string;
  /** One line under the label in Settings, when the scope needs saying. */
  scopeLabel?: string;
  scope: KeybindingScope;
  /**
   * Whether the chord fires while focus is in a text field (the composer, a
   * search box). A chord that is also a text-editing key still never fires
   * there; see {@link isTextEditingChord}.
   */
  firesInTextFields: boolean;
  defaults: {
    mac: readonly string[];
    other: readonly string[];
  };
};

export const KEYBINDING_GROUPS: readonly { id: KeybindingGroupId; label: string }[] = [
  { id: "threads", label: "Threads" },
  { id: "navigation", label: "Navigation" },
  { id: "layout", label: "Layout" },
];

export const KEYBINDING_ACTIONS: readonly KeybindingActionDefinition[] = [
  {
    id: "threads.new",
    group: "threads",
    label: "New Thread",
    scope: "menu",
    firesInTextFields: true,
    defaults: { mac: ["CmdOrCtrl+N"], other: ["CmdOrCtrl+N"] },
  },
  {
    id: "threads.rename",
    group: "threads",
    label: "Rename Thread",
    scope: "thread",
    firesInTextFields: true,
    // ⌘R is Reload Window. F2 is the Windows and Linux rename key; Mac
    // keyboards often put it behind fn, so macOS gets a second chord.
    defaults: { mac: ["CmdOrCtrl+Alt+R", "F2"], other: ["F2"] },
  },
  {
    id: "threads.archive",
    group: "threads",
    label: "Archive Thread",
    scope: "thread",
    firesInTextFields: true,
    // ⌘⌫ and Ctrl+Backspace delete text; Shift lifts the chord out of editing.
    defaults: {
      mac: ["CmdOrCtrl+Shift+Backspace"],
      other: ["CmdOrCtrl+Shift+Backspace"],
    },
  },
  {
    id: "threads.toggle_pin",
    group: "threads",
    label: "Pin / Unpin",
    scope: "thread",
    firesInTextFields: true,
    defaults: { mac: ["CmdOrCtrl+Shift+P"], other: ["CmdOrCtrl+Shift+P"] },
  },
  {
    id: "threads.toggle_keep_at_top",
    group: "threads",
    label: "Keep at Top",
    scope: "thread",
    firesInTextFields: true,
    defaults: { mac: [], other: [] },
  },
  {
    id: "threads.toggle_unread",
    group: "threads",
    label: "Mark Unread / Read",
    scope: "thread",
    firesInTextFields: true,
    // Mail uses ⇧⌘U. On Linux, Ctrl+Shift+U starts IBus Unicode entry.
    defaults: { mac: ["CmdOrCtrl+Shift+U"], other: [] },
  },
  {
    id: "threads.lock",
    group: "threads",
    label: "Lock / Unlock Thread",
    scope: "thread",
    firesInTextFields: true,
    defaults: { mac: [], other: [] },
  },
  {
    id: "threads.copy_link",
    group: "threads",
    label: "Copy Thread Link",
    scope: "thread",
    firesInTextFields: true,
    defaults: { mac: [], other: [] },
  },
  {
    id: "threads.move_up",
    group: "threads",
    label: "Move Pinned Up",
    scopeLabel: "Focused sidebar row",
    scope: "row",
    firesInTextFields: false,
    defaults: { mac: ["CmdOrCtrl+Shift+Up"], other: ["CmdOrCtrl+Shift+Up"] },
  },
  {
    id: "threads.move_down",
    group: "threads",
    label: "Move Pinned Down",
    scopeLabel: "Focused sidebar row",
    scope: "row",
    firesInTextFields: false,
    defaults: { mac: ["CmdOrCtrl+Shift+Down"], other: ["CmdOrCtrl+Shift+Down"] },
  },
  {
    id: "navigation.jump_to_thread",
    group: "navigation",
    label: "Jump to Thread",
    scope: "global",
    firesInTextFields: true,
    defaults: { mac: ["CmdOrCtrl+K"], other: ["CmdOrCtrl+K"] },
  },
  {
    id: "navigation.search_threads",
    group: "navigation",
    label: "Search Threads",
    scope: "global",
    firesInTextFields: true,
    defaults: { mac: ["CmdOrCtrl+Shift+F"], other: ["CmdOrCtrl+Shift+F"] },
  },
  {
    id: "navigation.find",
    group: "navigation",
    label: "Find",
    scopeLabel: "In the open thread, or the thread list when it has focus",
    scope: "global",
    firesInTextFields: true,
    defaults: { mac: ["CmdOrCtrl+F"], other: ["CmdOrCtrl+F"] },
  },
  {
    id: "navigation.back",
    group: "navigation",
    label: "Back",
    scope: "global",
    firesInTextFields: true,
    defaults: { mac: ["CmdOrCtrl+[", "Alt+Left"], other: ["CmdOrCtrl+[", "Alt+Left"] },
  },
  {
    id: "navigation.forward",
    group: "navigation",
    label: "Forward",
    scope: "global",
    firesInTextFields: true,
    defaults: { mac: ["CmdOrCtrl+]", "Alt+Right"], other: ["CmdOrCtrl+]", "Alt+Right"] },
  },
  {
    id: "layout.toggle_sidebar",
    group: "layout",
    label: "Toggle Sidebar",
    scope: "global",
    firesInTextFields: false,
    defaults: { mac: ["CmdOrCtrl+B"], other: ["CmdOrCtrl+B"] },
  },
  {
    id: "layout.toggle_context_rail",
    group: "layout",
    label: "Toggle Context Rail",
    scope: "global",
    firesInTextFields: false,
    defaults: { mac: ["CmdOrCtrl+Alt+B"], other: ["CmdOrCtrl+Alt+B"] },
  },
];

const ACTIONS_BY_ID = new Map<string, KeybindingActionDefinition>(
  KEYBINDING_ACTIONS.map((action) => [action.id, action]),
);

export function getKeybindingAction(
  id: string,
): KeybindingActionDefinition | undefined {
  return ACTIONS_BY_ID.get(id);
}

export function isKeybindingActionId(id: string): id is KeybindingActionId {
  return ACTIONS_BY_ID.has(id);
}

/**
 * Chords the application menu owns and the operator cannot rebind. Settings
 * lists them so a new chord cannot quietly shadow one.
 */
export const FIXED_KEYBINDINGS: readonly { label: string; chords: readonly string[] }[] = [
  { label: "Settings", chords: ["CmdOrCtrl+,"] },
  { label: "Close Window", chords: ["CmdOrCtrl+W"] },
  { label: "Quit", chords: ["CmdOrCtrl+Q"] },
  { label: "Switch Profile 1–9", chords: ["CmdOrCtrl+1"] },
];

// ---------------------------------------------------------------------------
// Chord grammar
// ---------------------------------------------------------------------------

export type KeybindingPlatform = string | undefined;

export function isMacPlatform(platform: KeybindingPlatform): boolean {
  return platform === "darwin";
}

/** A chord as written, before `CmdOrCtrl` is resolved for a platform. */
export type ParsedChord = {
  /** `CmdOrCtrl`: ⌘ on macOS, Ctrl elsewhere. */
  primary: boolean;
  /** Explicit Command / Super / Meta. */
  meta: boolean;
  /** Explicit Control. */
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Canonical key name: "A", "1", "F2", "Up", "Backspace", "[" … */
  key: string;
};

const MODIFIER_TOKENS: Record<string, keyof Omit<ParsedChord, "key">> = {
  cmdorctrl: "primary",
  commandorcontrol: "primary",
  cmd: "meta",
  command: "meta",
  super: "meta",
  meta: "meta",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
};

const NAMED_KEYS: Record<string, string> = {
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  return: "Enter",
  enter: "Enter",
  escape: "Escape",
  esc: "Escape",
  tab: "Tab",
  space: "Space",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  plus: "Plus",
};

const PUNCTUATION_KEYS = new Set(["[", "]", ",", ".", "/", ";", "'", "\\", "`", "-", "="]);

function canonicalKeyName(token: string): string | null {
  if (token.length === 1) {
    const upper = token.toUpperCase();
    if (/^[A-Z0-9]$/.test(upper)) return upper;
    if (PUNCTUATION_KEYS.has(token)) return token;
    if (token === "+") return "Plus";
    return null;
  }
  const lower = token.toLowerCase();
  if (NAMED_KEYS[lower] !== undefined) return NAMED_KEYS[lower];
  const fKey = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower);
  if (fKey) return `F${fKey[1]}`;
  return null;
}

/** Parse an accelerator string, or `null` when it is not a usable chord. */
export function parseChord(accelerator: string): ParsedChord | null {
  const trimmed = accelerator.trim();
  if (trimmed.length === 0) return null;
  // "CmdOrCtrl++" names the plus key; split on "+" that is not the last char.
  const tokens: string[] = [];
  let current = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === "+" && current.length > 0) {
      tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.length > 0) tokens.push(current);

  const chord: ParsedChord = {
    primary: false,
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
    key: "",
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].trim();
    const isLast = index === tokens.length - 1;
    const modifier = MODIFIER_TOKENS[token.toLowerCase()];
    if (!isLast) {
      if (modifier === undefined) return null;
      chord[modifier] = true;
      continue;
    }
    const key = canonicalKeyName(token);
    if (key === null) return null;
    chord.key = key;
  }
  return chord.key.length > 0 ? chord : null;
}

/**
 * The canonical accelerator string for a chord: modifiers in a fixed order,
 * so two spellings of one chord compare equal and the file stays tidy.
 */
export function formatAccelerator(chord: ParsedChord): string {
  const parts: string[] = [];
  if (chord.primary) parts.push("CmdOrCtrl");
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  if (chord.meta) parts.push("Super");
  parts.push(chord.key);
  return parts.join("+");
}

export function normalizeAccelerator(accelerator: string): string | null {
  const chord = parseChord(accelerator);
  return chord === null ? null : formatAccelerator(chord);
}

/** Physical modifier state for a chord on one platform. */
type ResolvedModifiers = { meta: boolean; ctrl: boolean; alt: boolean; shift: boolean };

function resolveModifiers(chord: ParsedChord, platform: string): ResolvedModifiers {
  const mac = isMacPlatform(platform);
  return {
    meta: chord.meta || (chord.primary && mac),
    ctrl: chord.ctrl || (chord.primary && !mac),
    alt: chord.alt,
    shift: chord.shift,
  };
}

/**
 * A platform-resolved identity for comparing chords, so "CmdOrCtrl+X" and
 * "Command+X" collide on macOS and "CmdOrCtrl+X" and "Ctrl+X" collide
 * elsewhere.
 */
export function chordIdentity(accelerator: string, platform: KeybindingPlatform): string | null {
  const chord = parseChord(accelerator);
  if (chord === null) return null;
  if (platform === undefined) return formatAccelerator(chord);
  const mods = resolveModifiers(chord, platform);
  return `${mods.ctrl ? "C" : ""}${mods.alt ? "A" : ""}${mods.shift ? "S" : ""}${mods.meta ? "M" : ""}:${chord.key}`;
}

// ---------------------------------------------------------------------------
// Keyboard events
// ---------------------------------------------------------------------------

export type KeyEventLike = {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

const CODE_KEYS: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  Space: "Space",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Backslash: "\\",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
};

const KEY_VALUES: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Enter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  " ": "Space",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

const MODIFIER_KEY_VALUES = new Set(["Meta", "Control", "Alt", "Shift", "AltGraph", "CapsLock", "OS", "Fn"]);

/**
 * The canonical key an event pressed, or `null` for a lone modifier.
 *
 * `code` comes first: holding Option on macOS rewrites `key` into the
 * character it composes (⌥R → "®"), so a chord with Alt can only be matched
 * on the physical key. `key` is the fallback for environments without `code`.
 */
export function eventKeyName(event: KeyEventLike): string | null {
  if (MODIFIER_KEY_VALUES.has(event.key)) return null;
  const code = event.code ?? "";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (CODE_KEYS[code] !== undefined) return CODE_KEYS[code];
  if (KEY_VALUES[event.key] !== undefined) return KEY_VALUES[event.key];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.key)) return event.key;
  if (event.key.length === 1) return canonicalKeyName(event.key);
  return null;
}

/** The chord an event pressed, written the way this platform would store it. */
export function chordFromEvent(
  event: KeyEventLike,
  platform: KeybindingPlatform,
): string | null {
  const key = eventKeyName(event);
  if (key === null) return null;
  const mac = isMacPlatform(platform);
  const chord: ParsedChord = {
    primary: mac ? event.metaKey : event.ctrlKey,
    meta: mac ? false : event.metaKey,
    ctrl: mac ? event.ctrlKey : false,
    alt: event.altKey,
    shift: event.shiftKey,
    key,
  };
  return formatAccelerator(chord);
}

/** Whether a keydown event presses this chord on this platform. */
export function matchesChord(
  event: KeyEventLike,
  accelerator: string,
  platform: KeybindingPlatform,
): boolean {
  const chord = parseChord(accelerator);
  if (chord === null) return false;
  const key = eventKeyName(event);
  if (key === null || key !== chord.key) return false;
  if (event.altKey !== chord.alt || event.shiftKey !== chord.shift) return false;
  if (platform === undefined) {
    // Unknown platform: CmdOrCtrl accepts exactly one of ⌘ or Ctrl.
    if (chord.primary) {
      if (chord.meta || chord.ctrl) {
        return event.metaKey && event.ctrlKey;
      }
      return event.metaKey !== event.ctrlKey;
    }
    return event.metaKey === chord.meta && event.ctrlKey === chord.ctrl;
  }
  const mods = resolveModifiers(chord, platform);
  return event.metaKey === mods.meta && event.ctrlKey === mods.ctrl;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Stored overrides: action id → chords. An empty list unbinds the action. */
export type KeybindingOverrides = Readonly<Record<string, readonly string[]>>;

export type ResolvedKeybindings = ReadonlyMap<KeybindingActionId, readonly string[]>;

export function defaultChordsFor(
  action: KeybindingActionDefinition,
  platform: KeybindingPlatform,
): readonly string[] {
  return isMacPlatform(platform) ? action.defaults.mac : action.defaults.other;
}

export function resolveKeybindings(
  overrides: KeybindingOverrides,
  platform: KeybindingPlatform,
): ResolvedKeybindings {
  const resolved = new Map<KeybindingActionId, readonly string[]>();
  for (const action of KEYBINDING_ACTIONS) {
    const override = overrides[action.id];
    resolved.set(
      action.id,
      override === undefined ? defaultChordsFor(action, platform) : override,
    );
  }
  return resolved;
}

export function isActionChanged(
  action: KeybindingActionDefinition,
  overrides: KeybindingOverrides,
  platform: KeybindingPlatform,
): boolean {
  const override = overrides[action.id];
  if (override === undefined) return false;
  const defaults = defaultChordsFor(action, platform);
  return (
    override.length !== defaults.length
    || override.some((chord, index) =>
      chordIdentity(chord, platform) !== chordIdentity(defaults[index], platform))
  );
}

/**
 * The action, if any, whose current chords include `accelerator`. Settings
 * uses it to name the clash before a chord moves.
 */
export function findActionUsingChord(
  bindings: ResolvedKeybindings,
  accelerator: string,
  platform: KeybindingPlatform,
  except?: KeybindingActionId,
): KeybindingActionId | null {
  const identity = chordIdentity(accelerator, platform);
  if (identity === null) return null;
  for (const [actionId, chords] of bindings) {
    if (actionId === except) continue;
    if (chords.some((chord) => chordIdentity(chord, platform) === identity)) {
      return actionId;
    }
  }
  return null;
}

/**
 * Whether the event presses one of the action's chords and the chord may fire
 * where focus is. `inTextField` is whether the event target is editable.
 */
export function eventMatchesAction(
  event: KeyEventLike,
  actionId: KeybindingActionId,
  bindings: ResolvedKeybindings,
  platform: KeybindingPlatform,
  inTextField: boolean,
): boolean {
  const action = ACTIONS_BY_ID.get(actionId);
  if (action === undefined) return false;
  if (inTextField && !action.firesInTextFields) return false;
  const chords = bindings.get(actionId) ?? [];
  return chords.some((chord) =>
    matchesChord(event, chord, platform)
    && !(inTextField && isTextEditingChord(chord, platform)));
}

// ---------------------------------------------------------------------------
// Rules for recording a chord
// ---------------------------------------------------------------------------

const EDITING_ARROWS = new Set(["Up", "Down", "Left", "Right"]);
const EDITING_NAV = new Set(["Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown"]);
const MAC_EMACS_KEYS = new Set(["A", "B", "D", "E", "F", "H", "K", "L", "N", "O", "P", "T", "V", "Y"]);
const CLIPBOARD_KEYS = new Set(["A", "C", "V", "X", "Z"]);

/**
 * Whether a chord edits text or moves the caret in a field on this platform.
 * Such a chord stays bound, but never fires while a field has focus, so a
 * shortcut cannot take a key the composer needs.
 */
export function isTextEditingChord(accelerator: string, platform: KeybindingPlatform): boolean {
  const chord = parseChord(accelerator);
  if (chord === null) return false;
  const mac = platform === undefined || isMacPlatform(platform);
  const mods = resolveModifiers(chord, mac ? "darwin" : "linux");
  if (!mods.meta && !mods.ctrl && !mods.alt && mods.shift && EDITING_NAV.has(chord.key)) {
    return true;
  }
  if (mods.alt && !mods.meta && !mods.ctrl && (EDITING_ARROWS.has(chord.key)
    || (!mods.shift && (chord.key === "Backspace" || chord.key === "Delete")))) {
    return true;
  }
  if (mac) {
    if (mods.meta && !mods.ctrl && !mods.alt) {
      if (EDITING_ARROWS.has(chord.key)) return true;
      if (!mods.shift && (chord.key === "Backspace" || chord.key === "Delete")) return true;
      if (CLIPBOARD_KEYS.has(chord.key)) return !mods.shift || chord.key === "Z";
    }
    if (mods.ctrl && !mods.meta && !mods.alt && !mods.shift && MAC_EMACS_KEYS.has(chord.key)) {
      return true;
    }
    return false;
  }
  if (mods.ctrl && !mods.meta && !mods.alt) {
    if (EDITING_NAV.has(chord.key)) return true;
    if (!mods.shift && (chord.key === "Backspace" || chord.key === "Delete")) return true;
    if (CLIPBOARD_KEYS.has(chord.key) || chord.key === "Y") {
      return !mods.shift || chord.key === "Z";
    }
  }
  return false;
}

export type ChordRefusal =
  | { kind: "invalid" }
  | { kind: "needs_modifier" }
  | { kind: "reserved"; reason: string };

/** Fixed chords the app menu or the system keeps, with the reason shown. */
function reservedReason(chord: ParsedChord, platform: KeybindingPlatform): string | null {
  const mac = platform === undefined || isMacPlatform(platform);
  const mods = resolveModifiers(chord, mac ? "darwin" : "linux");
  const primary = mac ? mods.meta && !mods.ctrl : mods.ctrl && !mods.meta;
  const onlyPrimary = primary && !mods.alt && !mods.shift;
  if (onlyPrimary && chord.key === ",") return "Settings uses it.";
  if (onlyPrimary && chord.key === "W") return "Close Window uses it.";
  if (onlyPrimary && chord.key === "Q") return "Quit uses it.";
  if (onlyPrimary && /^[1-9]$/.test(chord.key)) {
    return mac ? "Profiles use ⌘1 to ⌘9." : "Profiles use Ctrl+1 to Ctrl+9.";
  }
  if (onlyPrimary && chord.key === "R") return "Reload Window uses it.";
  if (primary && !mods.alt && (chord.key === "=" || chord.key === "Plus" || chord.key === "-" || chord.key === "0")) {
    return "Zoom uses it.";
  }
  if (primary && !mods.alt && CLIPBOARD_KEYS.has(chord.key)) return "The Edit menu uses it.";
  if (mac) {
    if (mods.meta && !mods.ctrl && !mods.shift && !mods.alt && (chord.key === "H" || chord.key === "M")) {
      return chord.key === "H" ? "macOS uses ⌘H to hide the app." : "macOS uses ⌘M to minimize the window.";
    }
    if (mods.meta && mods.alt && !mods.ctrl && !mods.shift && chord.key === "H") {
      return "macOS uses ⌥⌘H to hide other apps.";
    }
    if (mods.meta && (chord.key === "Tab" || chord.key === "Space" || chord.key === "`")) {
      return "macOS uses it to switch apps and windows.";
    }
    if (mods.meta && mods.shift && !mods.ctrl && /^[3-5]$/.test(chord.key)) {
      return "macOS uses it for screenshots.";
    }
    if (mods.meta && mods.ctrl && !mods.alt && !mods.shift && (chord.key === "F" || chord.key === "Q")) {
      return chord.key === "F" ? "Full Screen uses it." : "macOS uses ⌃⌘Q to lock the screen.";
    }
    if (mods.ctrl && !mods.meta && (chord.key === "Space" || EDITING_ARROWS.has(chord.key)) && !mods.alt && !mods.shift) {
      return "macOS uses it for input sources and Spaces.";
    }
    return null;
  }
  if (mods.alt && !mods.ctrl && !mods.meta && (chord.key === "F4" || chord.key === "Tab")) {
    return "The system uses it to close or switch windows.";
  }
  if (mods.meta) return "The system keeps the Windows/Super key.";
  if (mods.ctrl && mods.alt && chord.key === "Delete") return "The system keeps it.";
  if (chord.key === "F11" && !mods.ctrl && !mods.alt && !mods.shift) return "Full Screen uses it.";
  return null;
}

/**
 * Why a recorded chord cannot be bound, or `null` when it can. A clash with
 * another action is not a refusal; Settings offers to move the chord.
 */
export function refuseChord(
  accelerator: string,
  platform: KeybindingPlatform,
): ChordRefusal | null {
  const chord = parseChord(accelerator);
  if (chord === null) return { kind: "invalid" };
  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(chord.key);
  if (!chord.primary && !chord.meta && !chord.ctrl && !chord.alt && !isFunctionKey) {
    return { kind: "needs_modifier" };
  }
  const reason = reservedReason(chord, platform);
  return reason === null ? null : { kind: "reserved", reason };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const MAC_KEY_GLYPHS: Record<string, string> = {
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  Backspace: "⌫",
  Delete: "⌦",
  Enter: "↩",
  Escape: "⎋",
  Tab: "⇥",
  Space: "Space",
  PageUp: "⇞",
  PageDown: "⇟",
  Home: "↖",
  End: "↘",
  Plus: "+",
};

const OTHER_KEY_NAMES: Record<string, string> = {
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  Escape: "Esc",
  PageUp: "Page Up",
  PageDown: "Page Down",
  Plus: "Plus",
};

/**
 * The label for a chord in this platform's notation: macOS glyphs in Apple's
 * modifier order (⌃⌥⇧⌘), as the native menu draws them, and "Ctrl+Shift+P"
 * elsewhere. An unknown platform renders the Windows/Linux form.
 */
export function formatChordLabel(accelerator: string, platform: KeybindingPlatform): string {
  const chord = parseChord(accelerator);
  if (chord === null) return accelerator;
  if (isMacPlatform(platform)) {
    const mods = resolveModifiers(chord, "darwin");
    return `${mods.ctrl ? "⌃" : ""}${mods.alt ? "⌥" : ""}${mods.shift ? "⇧" : ""}${mods.meta ? "⌘" : ""}${MAC_KEY_GLYPHS[chord.key] ?? chord.key}`;
  }
  const mods = resolveModifiers(chord, "linux");
  const parts: string[] = [];
  if (mods.ctrl) parts.push("Ctrl");
  if (mods.alt) parts.push("Alt");
  if (mods.shift) parts.push("Shift");
  if (mods.meta) parts.push(platform === "win32" ? "Win" : "Super");
  parts.push(OTHER_KEY_NAMES[chord.key] ?? chord.key);
  return parts.join("+");
}

const ARIA_KEY_NAMES: Record<string, string> = {
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Space: "Space",
  Plus: "+",
};

/** The chord as an `aria-keyshortcuts` token ("Meta+Shift+ArrowUp"). */
export function formatAriaKeyShortcut(accelerator: string, platform: KeybindingPlatform): string | null {
  const chord = parseChord(accelerator);
  if (chord === null) return null;
  const mods = resolveModifiers(chord, isMacPlatform(platform) ? "darwin" : "linux");
  // The primary modifier leads, as the attribute's existing values in the
  // app have always written it ("Meta+Shift+ArrowUp").
  const parts: string[] = [];
  if (mods.meta) parts.push("Meta");
  if (mods.ctrl) parts.push("Control");
  if (mods.alt) parts.push("Alt");
  if (mods.shift) parts.push("Shift");
  parts.push(ARIA_KEY_NAMES[chord.key] ?? chord.key);
  return parts.join("+");
}

// ---------------------------------------------------------------------------
// The keybindings file
// ---------------------------------------------------------------------------

export const KEYBINDINGS_FILE_NAME = "keybindings.toml";

/** `threads.rename` lives in the `[threads]` table under the key `rename`. */
export function keybindingTomlPath(actionId: KeybindingActionId): [string, string] {
  const dot = actionId.indexOf(".");
  return [actionId.slice(0, dot), actionId.slice(dot + 1)];
}

export type KeybindingsSnapshot = {
  overrides: KeybindingOverrides;
  /** Where the file lives, for Settings to show. */
  filePath: string;
  /** Set when the file exists but could not be read; defaults then apply. */
  error?: string;
};

export type KeybindingWriteRequest =
  | { kind: "set"; actionId: KeybindingActionId; chords: readonly string[] }
  | { kind: "reset"; actionId: KeybindingActionId }
  | { kind: "reset_all" };
