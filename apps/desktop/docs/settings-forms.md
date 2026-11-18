# Explicit-Save Settings Forms

Moved from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps a summary and
says when to read this document. Relative links were updated for this location.

## Explicit-Save Settings Forms

Most Settings write as they change. The few that collect edits behind a Save
button (Federation's Configuration and its manual Cloudflare edge policy) have
two rules, because the settings snapshot they render from changes constantly —
`useDesktopSettings` replaces it on **any** config write, from any section or
any window, plus on runtime-changed events.

- **Never copy the snapshot back into form state.** Federation had a
  `useEffect` on `[props.snapshot]` that re-seeded every field, so an unrelated
  write (Cloudflare Access "Connect" calls `onSettingsChanged`) silently
  reverted whatever was typed. Use
  [`useSettingsDraft`](../src/renderer/src/features/settings/useSettingsDraft.ts):
  a field follows the saved value until it is edited, then holds the edit until
  it is saved or discarded. Discard the draft after a successful write — what
  is typed and what is stored can differ (`"047831"`, blank endpoint lines).
- **Tell Settings what would be lost.** Register with
  [`useUnsavedSettingsChanges`](../src/renderer/src/features/settings/UnsavedSettingsChanges.tsx)
  while the form is dirty. A route that unmounts the pane — a nav item, Exit
  Settings, or anything in `App` that changes `mainView` — then asks Save /
  Discard / Keep editing first. A jump to another section of the same pane does
  not, because nothing unmounts.

**A setup step must not read another section's unsaved field.** `CloudflareSetup`
takes the *saved* listener (`props.snapshot.federation.listenPort.value`) and
says so in the Create step, because Create writes that port into Cloudflare's
tunnel: reading the Configuration form's draft once published an endpoint on a
port the operator had typed but never saved, which collided with another
profile's gateway.

Closing the window is still not guarded. Electron emits the BrowserWindow
`close` event *before* the renderer's `beforeunload`, and `close` already hands
off to the quit manager, so a `beforeunload` guard would cancel an unload
whose shutdown had begun. Quitting with unsaved Settings edits discards them.
