type Fields = Record<string, string | number | boolean | undefined>;
type Logger = {
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
};
type Observer = {
  logger: Logger;
  captureUntil: () => number | undefined;
  recordTraffic: (direction: "sent" | "received", fields: Fields) => void;
};
let observer: Observer | undefined;

/** The host retains diagnostics; the transport retains no desktop state. */
export function configureFederationObservability(value: Observer): void { observer = value; }
export function getMainLogger(_name: string): Logger {
  return {
    info: (message, fields) => observer?.logger.info(message, fields),
    warn: (message, fields) => observer?.logger.warn(message, fields),
    error: (message, fields) => observer?.logger.error(message, fields),
  };
}
export function federationTrafficCaptureUntil(): number | undefined { return observer?.captureUntil(); }
export function recordFederationTraffic(direction: "sent" | "received", fields: Fields): void {
  observer?.recordTraffic(direction, fields);
}
