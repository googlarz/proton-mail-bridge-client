import { inflateRawSync } from "node:zlib";

// A minimal ZIP reader for Office documents, on node:zlib only. It reads the central directory, never writes to disk,
// and hands out entries by exact name. Archives come from mail, so every size is capped: the number of entries, the
// bytes one entry may inflate to and the bytes all reads together may inflate to. The declared sizes in the archive are
// not trusted; inflation itself is stopped at the cap (maxOutputLength), which is what defeats a zip bomb.

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export class ZipError extends Error {
  constructor(
    readonly reason: "invalid" | "too-large" | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "ZipError";
  }
}

interface Entry {
  method: number;
  encrypted: boolean;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

export interface ZipArchive {
  names: string[];
  /** The entry's bytes, or undefined when there is no usable entry of that name. Throws ZipError past a limit. */
  read(name: string): Buffer | undefined;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

// A name is usable only as a plain relative path: no absolute path, drive, backslash, NUL or ".." segment.
function isSafeName(name: string): boolean {
  if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0") || /^[a-z]:/i.test(name)) return false;
  return !name.split("/").some((segment) => segment === "..");
}

export function openZip(buf: Buffer, limits: ZipLimits): ZipArchive {
  // The end-of-central-directory record is 22 bytes plus a comment of at most 65535.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("invalid", "The file is not a valid ZIP archive.");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError("unsupported", "The archive uses ZIP64, which is not supported.");
  }
  if (count > limits.maxEntries) throw new ZipError("too-large", `The archive has ${count} entries, above the limit of ${limits.maxEntries}.`);
  if (cdOffset + cdSize > eocd) throw new ZipError("invalid", "The archive's central directory is out of bounds.");

  const entries = new Map<string, Entry>();
  let pos = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (pos + 46 > eocd || buf.readUInt32LE(pos) !== CENTRAL_SIGNATURE) throw new ZipError("invalid", "The archive's central directory is damaged.");
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const nameEnd = pos + 46 + nameLength;
    if (nameEnd > eocd) throw new ZipError("invalid", "The archive's central directory is damaged.");
    const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", pos + 46, nameEnd);
    // The first entry of a name wins; a later duplicate cannot replace what was already listed.
    if (isSafeName(name) && !entries.has(name)) {
      entries.set(name, { method, encrypted: (flags & 1) === 1, compressedSize, uncompressedSize, localOffset });
    }
    pos = nameEnd + extraLength + commentLength;
  }

  let inflatedTotal = 0;
  return {
    names: [...entries.keys()],
    read(name: string): Buffer | undefined {
      const entry = entries.get(name);
      if (!entry || entry.encrypted || (entry.method !== 0 && entry.method !== 8)) return undefined;
      const budget = Math.min(limits.maxEntryBytes, limits.maxTotalBytes - inflatedTotal);
      if (entry.uncompressedSize > budget) throw tooLarge(name, limits);
      const local = entry.localOffset;
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL_SIGNATURE) throw new ZipError("invalid", `The archive entry ${name} is damaged.`);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const end = start + entry.compressedSize;
      if (end > buf.length) throw new ZipError("invalid", `The archive entry ${name} is out of bounds.`);
      const raw = buf.subarray(start, end);
      let data: Buffer;
      if (entry.method === 0) {
        if (raw.length > budget) throw tooLarge(name, limits);
        data = raw;
      } else {
        try {
          // maxOutputLength must be at least 1; an empty budget still refuses any output.
          data = inflateRawSync(raw, { maxOutputLength: Math.max(1, budget) });
        } catch (error) {
          if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError) throw tooLarge(name, limits);
          throw new ZipError("invalid", `The archive entry ${name} could not be decompressed.`);
        }
        if (data.length > budget) throw tooLarge(name, limits);
      }
      inflatedTotal += data.length;
      return data;
    },
  };
}

function tooLarge(name: string, limits: ZipLimits): ZipError {
  return new ZipError(
    "too-large",
    `The archive entry ${name} decompresses to more than allowed (${limits.maxEntryBytes} bytes per entry, ${limits.maxTotalBytes} bytes in all); it may be a zip bomb.`,
  );
}
