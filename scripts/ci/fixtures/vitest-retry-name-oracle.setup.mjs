export function teardown() {
  const mode = process.env.PWRAGENT_RETRY_NAME_ORACLE_TEARDOWN;
  if (mode === "throw") throw new Error("fixture global teardown failed");
  if (mode === "exit") process.exit(process.env.PWRAGENT_RETRY_NAME_ORACLE_PHASE === "first" ? 1 : 0);
}
