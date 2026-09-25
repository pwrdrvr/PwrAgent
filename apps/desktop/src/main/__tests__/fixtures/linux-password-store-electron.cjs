const { writeFileSync } = require("node:fs");
const { app, safeStorage } = require("electron");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");

const userDataDir = process.env.PWRAGENT_SECRET_STORE_USER_DATA;
const resultPath = process.env.PWRAGENT_SECRET_STORE_RESULT;
app.setPath("userData", userDataDir);

const linuxPasswordStore = require(process.env.PWRAGENT_SECRET_STORE_MODULE);
const selected = linuxPasswordStore.applyRememberedLinuxPasswordStore({
  platform: process.platform,
  argv: process.argv,
  env: process.env,
  userDataDir,
  appendSwitch: (backend) => {
    app.commandLine.appendSwitch("password-store", backend);
  },
});

app.whenReady().then(() => {
  const backend = safeStorage.getSelectedStorageBackend();
  const available = safeStorage.isEncryptionAvailable();
  let roundtrip = null;
  let restarted = null;
  if (available) {
    roundtrip = safeStorage.decryptString(
      safeStorage.encryptString("pwragent-secret-store"),
    );
    if (process.env.PWRAGENT_SECRET_STORE_CIPHER_OUT) {
      writeFileSync(
        process.env.PWRAGENT_SECRET_STORE_CIPHER_OUT,
        safeStorage.encryptString("pwragent-secret-store"),
      );
    }
    if (process.env.PWRAGENT_SECRET_STORE_CIPHER_IN) {
      const { readFileSync } = require("node:fs");
      restarted = safeStorage.decryptString(
        readFileSync(process.env.PWRAGENT_SECRET_STORE_CIPHER_IN),
      );
    }
  }
  writeFileSync(resultPath, JSON.stringify({
    selected: selected ?? null,
    backend,
    available,
    roundtrip,
    restarted,
  }));
  app.exit(0);
});
