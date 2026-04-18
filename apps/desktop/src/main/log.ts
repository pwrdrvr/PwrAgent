import electronLog from "electron-log/main";

let initialized = false;

export function initializeMainLogger(): void {
  if (initialized) {
    return;
  }

  initialized = true;
  electronLog.initialize();
  electronLog.scope.labelPadding = false;
}

export function getMainLogger(scope: string) {
  return electronLog.scope(scope);
}
