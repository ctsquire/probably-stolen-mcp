import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createBridgeClient } from '../src/bridge-client.ts';
import { gameTools } from '../src/game-tools.ts';
import { openInstall } from '../src/install.ts';
import { createServer } from '../src/server.ts';
import type { Wiki } from '../src/wiki.ts';
import { startFakeGame, type FakeGame } from './helpers/fake-game.ts';

const shopSession = 'a'.repeat(32);

const wiki: Wiki = {
  search: (query, limit) => Promise.resolve({ query, total: limit, results: [] }),
  page: title => Promise.resolve({ title, found: false, suggestedPages: [] }),
};

describe('MCP server', () => {
  let game: FakeGame;
  let client: Client;

  before(async () => {
    game = await startFakeGame(request => (
      request.command === 'call_next' ? { ok: false, message: 'The counter is busy.' } : { ok: true, command: request.command }
    ));
    const server = createServer({
      install: openInstall(undefined),
      wiki,
      bridge: createBridgeClient({ directory: game.directory, pollMs: 5 }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'server-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  after(async () => {
    await client.close();
    await game.stop();
  });

  it('advertises the reference and game tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(({ name }) => name).sort();
    const expected = ['get_install_info', 'get_wiki_page', 'list_achievements', 'search_wiki', ...gameTools.map(({ name }) => name)].sort();
    assert.deepEqual(names, expected);
    assert.equal(tools.find(({ name }) => name === 'quit_game')?.annotations?.destructiveHint, true);
  });

  it('sends a validated game command through the bridge', async () => {
    const result = await client.callTool({ name: 'shop_day_action', arguments: { shopSession, action: 'open_shop' } });
    assert.deepEqual(result.structuredContent, { ok: true, command: 'open_shop' });
    assert.equal(result.isError, undefined);
    assert.equal(game.requests.at(-1)?.shopSession, shopSession);
  });

  it('marks refusals from the game as errors', async () => {
    const result = await client.callTool({ name: 'call_next_customer', arguments: { shopSession } });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { ok: false, message: 'The counter is busy.' });
  });

  it('refuses inconsistent arguments without contacting the game', async () => {
    const requestCount = game.requests.length;
    const result = await client.callTool({ name: 'phone_action', arguments: { shopSession, action: 'dial' } });
    assert.equal(result.isError, true);
    assert.equal(game.requests.length, requestCount);
  });

  it('rejects invalid tokens at the schema', async () => {
    const result = await client.callTool({ name: 'call_next_customer', arguments: { shopSession: 'nope' } });
    assert.equal(result.isError, true);
  });

  it('serves the reference tools', async () => {
    const search = await client.callTool({ name: 'search_wiki', arguments: { query: 'water' } });
    assert.deepEqual(search.structuredContent, { query: 'water', total: 5, results: [] });

    const info = await client.callTool({ name: 'get_install_info', arguments: {} });
    assert.equal(z.object({ configured: z.boolean() }).parse(info.structuredContent).configured, false);
  });
});

describe('server entry point', () => {
  it('starts over stdio', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../src/main.ts', import.meta.url))],
      stderr: 'ignore',
    });
    const client = new Client({ name: 'entry-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      assert.equal(client.getServerVersion()?.name, 'probably-stolen');
    } finally {
      await client.close();
    }
  });
});
