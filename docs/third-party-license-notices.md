# Third-Party License Notices

PwrAgent's desktop app ships a generated `THIRD_PARTY_LICENSES` file with npm
production dependency notices and the Electron runtime MIT license.

The notice is generated with:

```bash
pnpm licenses:generate
```

CI checks it with:

```bash
pnpm licenses:check
```

## Electron and Chromium

PwrAgent is built on Electron, which includes Chromium and Node.js runtime
components. The generated PwrAgent notice includes Electron's MIT license and
the npm packages bundled by the app.

Electron also publishes Chromium's generated credits as
`LICENSES.chromium.html` inside Electron runtime distributions. For the pinned
desktop runtime used by PwrAgent, that file is about 18 MB, so PwrAgent does
not append it to the readable `THIRD_PARTY_LICENSES` text file.

Reference links:

- Chromium source and credits entry point: https://source.chromium.org/chromium
- Electron releases: https://github.com/electron/electron/releases
- Electron license: https://github.com/electron/electron/blob/main/LICENSE
