/** Redact credentials in Bot API URLs while retaining the request method. */
export function scrubBotToken(message: string): string {
  return message.replace(/\/bot[^/\s]+/g, "/bot<redacted>");
}
