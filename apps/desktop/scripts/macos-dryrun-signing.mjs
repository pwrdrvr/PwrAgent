import { createRequire } from "node:module";
import { join } from "node:path";

export async function signMacDryrunApp(app, entitlements) {
  // Use the same signer as electron-builder without its PR identity guard.
  // The identity is always ad-hoc; no keychain discovery or credentials.
  const fromHere = createRequire(import.meta.url);
  const fromBuilder = createRequire(fromHere.resolve("electron-builder"));
  const fromBuilderLib = createRequire(fromBuilder.resolve("app-builder-lib"));
  const { signAsync } = fromBuilderLib("@electron/osx-sign");
  await signAsync({
    app,
    platform: "darwin",
    identity: "-",
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    // osx-sign discovers .app and .framework bundles, but not .plugin bundles.
    binaries: [join(app, "Contents", "PlugIns", "PwrAgentDockTilePlugin.plugin")],
    optionsForFile: () => ({
      entitlements,
      hardenedRuntime: false,
      timestamp: "none",
    }),
  });
}

export async function packageMacDryrun({ cli, args, app, entitlements, cwd }, {
  runChecked,
  signApp = signMacDryrunApp,
}) {
  // Finish merging, UUID personalization and fuse edits before signing. An
  // afterPack signature would be invalidated by the subsequent fuse edits.
  runChecked("node", [cli, ...args.filter((arg) => arg !== "dmg" && arg !== "zip"), "--dir"], { cwd });
  await signApp(app, entitlements);
  runChecked("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  // --prepackaged wraps the verified app without rebuilding or changing it.
  runChecked("node", [cli, ...args, "--prepackaged", app], { cwd });
}
