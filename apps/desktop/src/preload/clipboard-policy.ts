type ClipboardEnvironment = {
  CI?: string;
  PWRAGENT_E2E?: string;
};

export function shouldWriteSystemClipboard(
  environment: ClipboardEnvironment,
): boolean {
  if (environment.PWRAGENT_E2E !== "1") {
    return true;
  }
  return environment.CI === "1" || environment.CI === "true";
}
