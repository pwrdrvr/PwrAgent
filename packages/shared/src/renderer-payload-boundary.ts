export const RENDERER_PAYLOAD_STRING_LIMIT_CHARS = 32_000;
export const RENDERER_PAYLOAD_STRING_HEAD_CHARS = 24_000;
export const RENDERER_PAYLOAD_STRING_TAIL_CHARS = 4_000;

export function truncateRendererPayloadString(
  value: string,
  label = "payload string",
): string {
  if (value.length <= RENDERER_PAYLOAD_STRING_LIMIT_CHARS) {
    return value;
  }

  const head = value.slice(0, RENDERER_PAYLOAD_STRING_HEAD_CHARS);
  const tail = value.slice(-RENDERER_PAYLOAD_STRING_TAIL_CHARS);
  const omitted =
    value.length
    - RENDERER_PAYLOAD_STRING_HEAD_CHARS
    - RENDERER_PAYLOAD_STRING_TAIL_CHARS;

  return [
    head,
    "",
    `[PwrAgent renderer boundary: truncated ${omitted} characters from ${label}; original length ${value.length}; full value was kept out of renderer memory.]`,
    "",
    tail,
  ].join("\n");
}

export function sanitizeRendererPayload<T>(payload: T): T {
  return sanitizeRendererPayloadValue(payload, "$", new WeakMap()) as T;
}

function sanitizeRendererPayloadValue(
  value: unknown,
  path: string,
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === "string") {
    return truncateRendererPayloadString(value, path);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const cached = seen.get(value);
  if (cached) {
    return cached;
  }

  if (Array.isArray(value)) {
    let changed = false;
    const sanitized: unknown[] = [];
    seen.set(value, sanitized);
    value.forEach((entry, index) => {
      const next = sanitizeRendererPayloadValue(
        entry,
        `${path}[${index}]`,
        seen,
      );
      sanitized.push(next);
      if (next !== entry) {
        changed = true;
      }
    });
    if (!changed) {
      seen.set(value, value);
      return value;
    }
    return sanitized;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return value;
  }

  let changed = false;
  const input = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  seen.set(value, sanitized);
  for (const [key, entry] of Object.entries(input)) {
    const next = isRendererImageUrlField(input, key, entry)
      ? entry
      : sanitizeRendererPayloadValue(entry, `${path}.${key}`, seen);
    sanitized[key] = next;
    if (next !== entry) {
      changed = true;
    }
  }

  if (!changed) {
    seen.set(value, value);
    return value;
  }
  return sanitized;
}

function isRendererImageUrlField(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const type = typeof record.type === "string" ? record.type : undefined;
  if (key === "url" && type === "image") {
    return isRendererImageUrl(value);
  }
  if (
    key === "image_url"
    && (type === "image" || type === "input_image" || type === "image_url")
  ) {
    return isRendererImageUrl(value);
  }

  return false;
}

function isRendererImageUrl(value: string): boolean {
  return (
    value.startsWith("data:image/")
    || value.startsWith("file://")
    || value.startsWith("pwragent-image://")
    || /^https?:\/\/.+/i.test(value)
  );
}
