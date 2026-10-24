import electronUpdater, { type AppUpdater } from "electron-updater";

// BaseUpdater.install performs the synchronous authorization and installation
// without arming a relaunch or scheduling a quit. Reset its retry guard when
// authorization fails, as BaseUpdater.quitAndInstall normally would.
export class ManagedDebUpdater extends electronUpdater.DebUpdater {
  authorizeInstall(): boolean {
    const installed = this.install(false, false);
    if (!installed) this.quitAndInstallCalled = false;
    return installed;
  }
}

export class ManagedPacmanUpdater extends electronUpdater.PacmanUpdater {
  authorizeInstall(): boolean {
    const installed = this.install(false, false);
    if (!installed) this.quitAndInstallCalled = false;
    return installed;
  }
}

export class ManagedRpmUpdater extends electronUpdater.RpmUpdater {
  private installingDowngrade = false;

  authorizeInstall(downgrade: boolean): boolean {
    this.installingDowngrade = downgrade;
    try {
      const installed = this.install(false, false);
      if (!installed) this.quitAndInstallCalled = false;
      return installed;
    } finally {
      this.installingDowngrade = false;
    }
  }

  protected runCommandWithSudoIfNeeded(commandWithArgs: string[]): string {
    const command = [...commandWithArgs];
    if (this.installingDowngrade) {
      if (command[0] === "rpm") command.splice(2, 0, "--oldpackage");
      if (command[0] === "dnf" || command[0] === "yum") command[1] = "downgrade";
      // Upstream already passes zypper's -f, which permits downgrades.
    }
    return super.runCommandWithSudoIfNeeded(command);
  }
}

export function createLinuxPackageUpdater(updater: AppUpdater): AppUpdater {
  if (process.platform !== "linux") return updater;
  if (updater instanceof electronUpdater.DebUpdater) return new ManagedDebUpdater();
  if (updater instanceof electronUpdater.RpmUpdater) return new ManagedRpmUpdater();
  if (updater instanceof electronUpdater.PacmanUpdater) return new ManagedPacmanUpdater();
  return updater;
}

export function authorizeLinuxPackageUpdate(updater: AppUpdater, downgrade: boolean): boolean {
  if (updater instanceof ManagedRpmUpdater) return updater.authorizeInstall(downgrade);
  if (updater instanceof ManagedDebUpdater || updater instanceof ManagedPacmanUpdater) {
    return updater.authorizeInstall();
  }
  throw new Error("Unsupported Linux package updater");
}
