/**
 * Shapes for the Windows custom title-bar menu bar bridge.
 *
 * On Windows the native title bar is hidden (`titleBarStyle: "hidden"`), which
 * also removes the native menu bar — on Windows the menu lives in the title bar
 * the OS just hid. So the renderer paints its own top-level entries (File /
 * View / Profiles / Window / Help) and, on click or Alt-mnemonic, asks main to
 * pop the REAL native submenu at the button. The submenu behavior (roles,
 * accelerators, enable state, click handlers) stays the single source of truth
 * in the application menu `installApplicationMenu` already builds.
 *
 * macOS keeps its system menu bar; Linux keeps the native frame's menu bar.
 * Neither uses this bridge.
 */

/** One top-level application-menu entry, for the renderer's custom menu bar. */
export type AppMenuTopLevel = { index: number; label: string };

/**
 * Request to pop a top-level submenu. `index` is the menu-model index;
 * `x`/`y` are window-relative DIP (the menu button's bottom-left). When
 * absent, Electron falls back to the cursor position.
 */
export type AppMenuPopupRequest = { index: number; x?: number; y?: number };
