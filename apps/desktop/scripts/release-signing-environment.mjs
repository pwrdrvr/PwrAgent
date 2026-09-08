// electron-builder 26.15.x treats these variables as instructions to import a
// certificate into a keychain it owns. When it follows that path, it supplies
// the .p12 import password to `security set-key-partition-list` instead of the
// generated keychain password, which macOS 26 rejects. The release script has
// already imported and verified the certificate in its own keychain, then put
// that keychain first in the user search list, so electron-builder only needs
// the selected CSC_NAME identity.
export function handoffPreloadedCodesignIdentity(env) {
  delete env.CSC_KEYCHAIN;
  delete env.CSC_LINK;
  delete env.CSC_KEY_PASSWORD;
}
