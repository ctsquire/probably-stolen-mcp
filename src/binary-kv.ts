/**
 * Reader for Valve's binary KeyValues format, used by Steam's cached achievement schema
 * (`appcache/stats/UserGameStatsSchema_<appid>.bin`).
 */

export type KeyValue = string | number | bigint | KeyValues;
export type KeyValues = Map<string, KeyValue>;

const types = {
  section: 0,
  string: 1,
  int32: 2,
  float32: 3,
  pointer: 4,
  wideString: 5,
  color: 6,
  uint64: 7,
  end: 8,
  int64: 10,
} as const;

export function parseBinaryKeyValues(buffer: Buffer): KeyValues {
  let offset = 0;

  function readString(): string {
    const end = buffer.indexOf(0, offset);
    if (end < 0) throw new Error('Unterminated string in key-value data.');
    const value = buffer.toString('utf8', offset, end);
    offset = end + 1;
    return value;
  }

  function readSection(): KeyValues {
    const section: KeyValues = new Map<string, KeyValue>();
    for (;;) {
      if (offset >= buffer.length) throw new Error('Key-value data ended before its section closed.');
      const type = buffer.readUInt8(offset);
      offset += 1;
      if (type === types.end) return section;

      const key = readString();
      switch (type) {
        case types.section:
          section.set(key, readSection());
          break;
        case types.string:
          section.set(key, readString());
          break;
        case types.int32:
          section.set(key, buffer.readInt32LE(offset));
          offset += 4;
          break;
        case types.float32:
          section.set(key, buffer.readFloatLE(offset));
          offset += 4;
          break;
        case types.pointer:
        case types.color:
          section.set(key, buffer.readUInt32LE(offset));
          offset += 4;
          break;
        case types.uint64:
          section.set(key, buffer.readBigUInt64LE(offset));
          offset += 8;
          break;
        case types.int64:
          section.set(key, buffer.readBigInt64LE(offset));
          offset += 8;
          break;
        default:
          throw new Error(`Unsupported key-value type ${String(type)}.`);
      }
    }
  }

  return readSection();
}

/** Looks up a key case-insensitively, as Steam does. */
export function child(section: KeyValues, key: string): KeyValue | undefined {
  const exact = section.get(key);
  if (exact !== undefined) return exact;
  const lower = key.toLowerCase();
  for (const [name, value] of section) {
    if (name.toLowerCase() === lower) return value;
  }
  return undefined;
}
