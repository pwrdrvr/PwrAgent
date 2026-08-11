export function normalizeAsarListing(listing) {
  return listing.map((entry) => entry.replaceAll("\\", "/"));
}

const windowsX64CanvasBindingRoot =
  "/node_modules/@napi-rs/canvas-win32-x64-msvc";

export function requiredPackagedRuntimeFiles(platform, arch) {
  if (platform !== "win32" || arch !== "x64") {
    return [];
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
  ];
}

export function missingPackagedRuntimeFiles(listing, platform, arch) {
  const entries = new Set(normalizeAsarListing(listing));
  return requiredPackagedRuntimeFiles(platform, arch)
    .filter(({ entry }) => !entries.has(entry));
}
