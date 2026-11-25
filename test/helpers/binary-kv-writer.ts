/** Minimal encoder for Valve binary KeyValues, used to build schema fixtures. */
export type Entry =
  | { key: string; section: Entry[] }
  | { key: string; string: string }
  | { key: string; int32: number }
  | { key: string; float32: number }
  | { key: string; uint64: bigint };

function cString(text: string): Buffer {
  return Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]);
}

function encodeEntries(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    if ('section' in entry) {
      parts.push(Buffer.from([0]), cString(entry.key), encodeEntries(entry.section));
    } else if ('string' in entry) {
      parts.push(Buffer.from([1]), cString(entry.key), cString(entry.string));
    } else if ('int32' in entry) {
      const value = Buffer.alloc(4);
      value.writeInt32LE(entry.int32);
      parts.push(Buffer.from([2]), cString(entry.key), value);
    } else if ('float32' in entry) {
      const value = Buffer.alloc(4);
      value.writeFloatLE(entry.float32);
      parts.push(Buffer.from([3]), cString(entry.key), value);
    } else {
      const value = Buffer.alloc(8);
      value.writeBigUInt64LE(entry.uint64);
      parts.push(Buffer.from([7]), cString(entry.key), value);
    }
  }
  parts.push(Buffer.from([8]));
  return Buffer.concat(parts);
}

export function encodeKeyValues(entries: Entry[]): Buffer {
  return encodeEntries(entries);
}

type AchievementFixture = { id: string; name: string | Entry[]; description?: string; hidden?: Entry };

/** Builds a UserGameStatsSchema file shaped like the ones Steam caches. */
export function schemaFixture(appId: number, achievements: AchievementFixture[]): Buffer {
  const bits: Entry[] = achievements.map(({ id, name, description = '', hidden }, index) => ({
    key: String(index),
    section: [
      { key: 'name', string: id },
      { key: 'bit', int32: index },
      {
        key: 'display',
        section: [
          typeof name === 'string'
            ? { key: 'name', section: [{ key: 'english', string: name }, { key: 'token', string: `NEW_ACHIEVEMENT_${String(index)}_NAME` }] }
            : { key: 'name', section: name },
          { key: 'desc', section: [{ key: 'english', string: description }] },
          ...(hidden ? [hidden] : []),
          { key: 'icon', string: `${id}.jpg` },
        ],
      },
    ],
  }));

  return encodeKeyValues([{
    key: String(appId),
    section: [
      { key: 'gamename', string: 'Probably Stolen' },
      { key: 'version', string: '7' },
      {
        key: 'stats',
        section: [
          { key: '1', section: [{ key: 'type', string: '1' }, { key: 'name', string: 'TOTAL_SALES' }] },
          { key: '2', section: [{ key: 'type', string: '4' }, { key: 'id', string: '2' }, { key: 'bits', section: bits }] },
        ],
      },
    ],
  }]);
}
