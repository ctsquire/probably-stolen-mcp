import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { child, parseBinaryKeyValues } from '../src/binary-kv.ts';
import { achievementsFromSchema, schemaPath, steamAppId } from '../src/steam.ts';
import { encodeKeyValues, schemaFixture } from './helpers/binary-kv-writer.ts';

describe('binary key-values', () => {
  it('reads nested sections and every value type Steam uses', () => {
    const parsed = parseBinaryKeyValues(encodeKeyValues([
      { key: 'Root', section: [
        { key: 'text', string: 'Ünïcode ✓' },
        { key: 'count', int32: -12 },
        { key: 'ratio', float32: 0.5 },
        { key: 'big', uint64: 2n ** 40n },
        { key: 'empty', section: [] },
      ] },
    ]));

    const root = child(parsed, 'root');
    assert.ok(root instanceof Map);
    assert.equal(root.get('text'), 'Ünïcode ✓');
    assert.equal(root.get('count'), -12);
    assert.equal(root.get('ratio'), 0.5);
    assert.equal(root.get('big'), 2n ** 40n);
    assert.deepEqual(root.get('empty'), new Map());
  });

  it('rejects truncated or unknown data', () => {
    const valid = encodeKeyValues([{ key: 'a', string: 'b' }]);
    assert.throws(() => parseBinaryKeyValues(valid.subarray(0, valid.length - 1)), /ended before/);
    assert.throws(() => parseBinaryKeyValues(Buffer.from([1, 0x61])), /Unterminated string/);
    assert.throws(() => parseBinaryKeyValues(Buffer.from([9, 0x61, 0, 8])), /Unsupported key-value type 9/);
  });
});

describe('Steam achievement schema', () => {
  it('lists achievements with English text and hidden flags in file order', () => {
    const schema = parseBinaryKeyValues(schemaFixture(steamAppId, [
      { id: 'FIRST_SALE', name: 'Open for Business', description: 'Sell your first item.' },
      { id: 'SECRET_ENDING', name: 'Probably Stolen', description: 'Reach the secret ending.', hidden: { key: 'hidden', string: '1' } },
      { id: 'BIG_FISH', name: 'Aquaculture', hidden: { key: 'hidden', int32: 0 } },
    ]));

    assert.deepEqual(achievementsFromSchema(schema), [
      { id: 'FIRST_SALE', name: 'Open for Business', description: 'Sell your first item.', hidden: false },
      { id: 'SECRET_ENDING', name: 'Probably Stolen', description: 'Reach the secret ending.', hidden: true },
      { id: 'BIG_FISH', name: 'Aquaculture', description: '', hidden: false },
    ]);
  });

  it('falls back to another language or the ID when English text is missing', () => {
    const schema = parseBinaryKeyValues(schemaFixture(steamAppId, [
      { id: 'GERMAN_ONLY', name: [{ key: 'german', string: 'Nur Deutsch' }] },
      { id: 'NO_NAME', name: [] },
    ]));
    assert.deepEqual(achievementsFromSchema(schema).map(({ name }) => name), ['Nur Deutsch', 'NO_NAME']);
  });

  it('rejects a schema for a different game', () => {
    const schema = parseBinaryKeyValues(schemaFixture(1234, [{ id: 'X', name: 'X' }]));
    assert.throws(() => achievementsFromSchema(schema), /does not list any stats/);
  });

  it('points at the cached schema for Probably Stolen', () => {
    assert.match(schemaPath('/steam'), /appcache[\\/]stats[\\/]UserGameStatsSchema_4348910\.bin$/);
  });
});
