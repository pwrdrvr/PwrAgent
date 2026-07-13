const SECRET_FRAGMENT_PATTERN =
  /((?:--?)?(?:api[-_]?key|token|secret|password|authorization)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;
const ASSIGNMENT_SECRET_PATTERN =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)[A-Z0-9_]*=)("[^"]*"|'[^']*'|\S+)/g;

export function redactCommandText(value: string): string {
  return value
    .replace(SECRET_FRAGMENT_PATTERN, "$1[redacted]")
    .replace(ASSIGNMENT_SECRET_PATTERN, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim();
}

export function safeCommandTitle(command: string | undefined): string {
  if (!command) {
    return "Ran command";
  }

  const stripped = command
    .replace(/^\/bin\/[a-z]+ -lc /, "")
    .replace(/^['"]|['"]$/g, "");
  const collapsed = redactCommandText(stripped);
  return collapsed || "Ran command";
}
