type TomlValue = string | number | boolean;

export function parseFlatToml(contents: string, filePath: string): Record<string, TomlValue> {
  const values: Record<string, TomlValue> = {};

  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = stripInlineComment(rawLine).trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      throw new Error(`Unsupported TOML table on line ${index + 1} in ${filePath}`);
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 1) {
      throw new Error(`Invalid TOML line ${index + 1} in ${filePath}`);
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    if (!key) {
      throw new Error(`Invalid TOML key on line ${index + 1} in ${filePath}`);
    }
    values[key] = parseValue(rawValue, filePath, index + 1);
  }

  return values;
}

export function stringifyFlatToml(values: Record<string, TomlValue | undefined>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key} = ${formatValue(value as TomlValue)}`)
    .join("\n")
    .concat("\n");
}

function parseValue(value: string, filePath: string, lineNumber: number): TomlValue {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return unescapeQuotedString(value.slice(1, -1), filePath, lineNumber);
  }

  return value;
}

function stripInlineComment(line: string): string {
  let inQuotedString = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = inQuotedString;
      continue;
    }
    if (character === "\"") {
      inQuotedString = !inQuotedString;
      continue;
    }
    if (character === "#" && !inQuotedString) {
      return line.slice(0, index);
    }
  }

  return line;
}

function unescapeQuotedString(
  value: string,
  filePath: string,
  lineNumber: number,
): string {
  let result = "";

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      result += character;
      continue;
    }

    index += 1;
    const escape = value[index];
    if (escape === undefined) {
      throw new Error(`Invalid TOML escape on line ${lineNumber} in ${filePath}`);
    }
    if (escape === "\\" || escape === "\"") {
      result += escape;
      continue;
    }
    if (escape === "n") {
      result += "\n";
      continue;
    }
    if (escape === "t") {
      result += "\t";
      continue;
    }
    throw new Error(`Unsupported TOML escape \\${escape} on line ${lineNumber} in ${filePath}`);
  }

  return result;
}

function formatValue(value: TomlValue): string {
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }

  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/"/g, '\\"')}"`;
}
