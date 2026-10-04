import { NODE_PTY_REQUIRED_FILES } from "./stage-native-prebuilds.mjs";

export function normalizeAsarListing(listing) {
  return listing.map((entry) => entry.replaceAll("\\", "/"));
}

const windowsX64CanvasBindingRoot =
  "/node_modules/@napi-rs/canvas-win32-x64-msvc";

// beforePack stages these from each package's Node-API prebuilds, which are
// themselves excluded from the package. Both loaders fall back to
// build/Release, so a missing file here is a startup failure, not a warning.
function stagedNativeFiles(platform) {
  const nodePtyFiles = NODE_PTY_REQUIRED_FILES[platform] ?? [];
  return [
    "/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    ...nodePtyFiles.map((file) => `/node_modules/node-pty/build/Release/${file}`),
  ].map((entry) => ({ entry, unpacked: true }));
}

export function requiredPackagedRuntimeFiles(platform, arch) {
  const stagedNatives = stagedNativeFiles(platform);
  if (platform !== "win32" || arch !== "x64") {
    return stagedNatives;
  }

  return [
    {
      entry: `${windowsX64CanvasBindingRoot}/package.json`,
      unpacked: false,
    },
    {
      entry: `${windowsX64CanvasBindingRoot}/icudtl.dat`,
      unpacked: true,
    },
    {
      entry: `${windowsX64CanvasBindingRoot}/skia.win32-x64-msvc.node`,
      unpacked: true,
    },
    ...stagedNatives,
  ];
}

export function missingPackagedRuntimeFiles(listing, platform, arch) {
  const entries = new Set(normalizeAsarListing(listing));
  return requiredPackagedRuntimeFiles(platform, arch)
    .filter(({ entry }) => !entries.has(entry));
}
