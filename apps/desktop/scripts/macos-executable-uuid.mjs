import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

// Electron distributes the same main Mach-O UUID to every consuming app.
// TN3179 requires a unique main executable UUID for reliable LAN privacy.
// Patch only the staged executable, before electron-builder signs the app.
// A stable app/version/architecture identity also makes repeated afterPack
// calls (including the universal merge) idempotent.
export function personalizeMacExecutableUuid(input, identity) {
  if (!identity) throw new Error("Missing macOS executable identity");
  const output = Buffer.from(input);
  const range = (offset, size, end = output.length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size)
      || offset < 0 || size < 0 || offset + size > end) {
      throw new Error("Invalid Mach-O bounds");
    }
  };
  const patchSlice = (offset, size) => {
    range(offset, size);
    const end = offset + size;
    range(offset, 32, end);
    if (output.readUInt32LE(offset) !== 0xfeedfacf) {
      throw new Error("Expected a little-endian 64-bit Mach-O executable");
    }
    if (output.readUInt32LE(offset + 12) !== 2) throw new Error("Expected MH_EXECUTE");
    const cpu = output.readUInt32LE(offset + 4);
    const subtype = output.readUInt32LE(offset + 8);
    const count = output.readUInt32LE(offset + 16);
    const commandBytes = output.readUInt32LE(offset + 20);
    range(offset + 32, commandBytes, end);
    const commandsEnd = offset + 32 + commandBytes;
    let command = offset + 32;
    let uuidOffset;
    for (let i = 0; i < count; i++) {
      range(command, 8, commandsEnd);
      const kind = output.readUInt32LE(command);
      const length = output.readUInt32LE(command + 4);
      if (length < 8) throw new Error("Invalid Mach-O command length");
      range(command, length, commandsEnd);
      if (kind === 0x1b) {
        if (length !== 24 || uuidOffset !== undefined) throw new Error("Invalid LC_UUID");
        uuidOffset = command + 8;
      }
      command += length;
    }
    if (command !== commandsEnd || uuidOffset === undefined) throw new Error("Missing or invalid LC_UUID");
    const uuid = createHash("sha256").update(`${identity}\0${cpu}\0${subtype}`).digest().subarray(0, 16);
    uuid[6] = (uuid[6] & 0x0f) | 0x80; // RFC 9562 version 8, application-defined.
    uuid[8] = (uuid[8] & 0x3f) | 0x80;
    uuid.copy(output, uuidOffset);
  };
  range(0, 8);
  const magic = output.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const wide = magic === 0xcafebabf;
    const count = output.readUInt32BE(4);
    const entrySize = wide ? 32 : 20;
    range(8, count * entrySize);
    if (count === 0) throw new Error("Empty universal Mach-O");
    const slices = [];
    for (let i = 0; i < count; i++) {
      const entry = 8 + i * entrySize;
      const offset = wide ? Number(output.readBigUInt64BE(entry + 8)) : output.readUInt32BE(entry + 8);
      const size = wide ? Number(output.readBigUInt64BE(entry + 16)) : output.readUInt32BE(entry + 12);
      range(offset, size);
      if (offset < 8 + count * entrySize
        || slices.some((slice) => offset < slice.end && offset + size > slice.offset)) {
        throw new Error("Overlapping Mach-O slices");
      }
      slices.push({ offset, end: offset + size });
      patchSlice(offset, size);
    }
  } else {
    patchSlice(0, output.length);
  }
  return output;
}

export async function personalizeMacExecutableFile(file, identity) {
  const original = await readFile(file);
  const updated = personalizeMacExecutableUuid(original, identity);
  if (!updated.equals(original)) await writeFile(file, updated);
}
