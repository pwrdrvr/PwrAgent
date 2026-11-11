import fs from "node:fs";
import path from "node:path";

// A valid 1x1 PNG. Discovery used to decode an icon only when the `.icns`
// held a PNG entry, so an icon without one would prove nothing.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function icnsWithPng(png: Buffer): Buffer {
  const entry = Buffer.alloc(8);
  entry.write("ic07", 0, "latin1");
  entry.writeUInt32BE(png.length + 8, 4);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "latin1");
  header.writeUInt32BE(header.length + entry.length + png.length, 4);
  return Buffer.concat([header, entry, png]);
}

/**
 * A bundle `discoverDesktopApplications` knows: VimR. It looks for no
 * binaries, so discovering it spawns nothing, and few hosts install it, so
 * the fake bundle is usually the one discovered.
 */
export const FAKE_APPLICATION_ID = "vimr";
const FAKE_APPLICATION_BUNDLE = "VimR.app";

/** Where a host's own install would win over the fake one. */
export const REAL_APPLICATION_PATH = path.join("/Applications", FAKE_APPLICATION_BUNDLE);

/**
 * Installs a fake VimR bundle, with a decodable icon, where
 * discovery looks for per-user applications: `<home>/Applications`. Point
 * `HOME` (and `USERPROFILE` on Windows) at `home` before the discovery module
 * evaluates, since it reads `os.homedir()` when it builds its known
 * applications. Every host then has one application to discover, whatever is
 * installed in `/Applications`.
 */
export function installFakeApplicationBundle(home: string): { appPath: string; iconPath: string } {
  const appPath = path.join(home, "Applications", FAKE_APPLICATION_BUNDLE);
  const resources = path.join(appPath, "Contents", "Resources");
  fs.mkdirSync(resources, { recursive: true });
  const iconPath = path.join(resources, "AppIcon.icns");
  fs.writeFileSync(iconPath, icnsWithPng(ONE_PIXEL_PNG));
  return { appPath, iconPath };
}
