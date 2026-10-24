/**
 * Names that mark a value as a credential. The MCP elicitation card refuses
 * to collect such a field, and messaging withholds such a tool parameter.
 */

// A parameter key. Anchored at the end, so `access_token` is a secret and
// `max_tokens` and `token_budget` are not.
const SECRET_KEY = /(?:api[-_ ]?key|token|secret|password|passphrase|passcode|authorization|credentials?|private[-_ ]?key|card[-_ ]?number|cvc|cvv)$/iu;

// A human label, such as "Password (required)" or "API key:". Whole words
// anywhere, because a title carries punctuation and qualifiers a key does not.
const SECRET_LABEL = /\b(?:password|passphrase|passcode|api[- ]?key|access token|refresh token|bearer token|auth(?:entication|orization)? token|client secret|secret key|private key|card number|cvc|cvv)\b/iu;

export function isSecretFieldName(name: string): boolean {
  return SECRET_KEY.test(name.trim());
}

export function isSecretFieldLabel(label: string): boolean {
  return SECRET_LABEL.test(label);
}
