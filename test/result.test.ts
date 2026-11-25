import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { toolResult } from '../src/result.ts';
import { serverVersion } from '../src/version.ts';

describe('tool results', () => {
  it('returns data as text and structured content', () => {
    const data = { ok: true, day: 4 };
    assert.deepEqual(toolResult(data), {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
    });
  });

  it('flags refused actions as errors', () => {
    assert.equal(toolResult({ ok: false, message: 'The shop is not ready to open.' }).isError, true);
    assert.equal(toolResult({ results: [] }).isError, undefined);
  });
});

describe('version', () => {
  it('matches package.json', async () => {
    const manifest = z.object({ version: z.string() }).parse(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')));
    assert.equal(serverVersion, manifest.version);
  });
});
