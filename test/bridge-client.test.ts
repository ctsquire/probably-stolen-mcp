import assert from 'node:assert/strict';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridgeClient, maxTimeoutMs } from '../src/bridge-client.ts';
import { makeBridgeDirectory, startFakeGame } from './helpers/fake-game.ts';

describe('bridge client', () => {
  it('writes a versioned request and returns the reply without protocol fields', async () => {
    const game = await startFakeGame(request => ({ ok: true, message: `ran ${String(request.command)}`, day: 3 }));
    try {
      const client = createBridgeClient({ directory: game.directory, pollMs: 5 });
      const reply = await client.send('move_item', { itemId: 4, destinationId: 9 });

      assert.deepEqual(reply, { ok: true, message: 'ran move_item', day: 3 });
      const [request] = game.requests;
      assert.ok(request);
      assert.equal(request.version, 1);
      assert.equal(request.command, 'move_item');
      assert.equal(request.itemId, 4);
      assert.equal(request.destinationId, 9);
      assert.match(String(request.id), /^[a-f0-9]{32}$/);
      assert.equal(typeof request.expiresAtMs, 'number');
      assert.deepEqual(await readdir(game.directory), []);
    } finally {
      await game.stop();
    }
  });

  it('does not let a payload override protocol fields', async () => {
    const game = await startFakeGame();
    try {
      const client = createBridgeClient({ directory: game.directory, pollMs: 5 });
      await client.send('status', { command: 'quit_game', version: 99 });
      assert.equal(game.requests[0]?.command, 'status');
      assert.equal(game.requests[0]?.version, 1);
    } finally {
      await game.stop();
    }
  });

  it('queues concurrent requests instead of rejecting them', async () => {
    const game = await startFakeGame(request => ({ ok: true, command: request.command }));
    try {
      const client = createBridgeClient({ directory: game.directory, pollMs: 5 });
      const replies = await Promise.all(['status', 'inventory', 'call_next'].map(command => client.send(command, {})));

      assert.deepEqual(replies.map(reply => reply.command), ['status', 'inventory', 'call_next']);
      assert.deepEqual(game.requests.map(request => request.command), ['status', 'inventory', 'call_next']);
    } finally {
      await game.stop();
    }
  });

  it('keeps serving requests after one fails', async () => {
    const game = await startFakeGame(request => (request.command === 'status' ? undefined : { ok: true }));
    try {
      const client = createBridgeClient({ directory: game.directory, pollMs: 5, timeoutMs: 100 });
      const [first, second] = await Promise.allSettled([client.send('status', {}), client.send('call_next', {})]);
      assert.equal(first.status, 'rejected');
      assert.equal(second.status, 'fulfilled');
    } finally {
      await game.stop();
    }
  });

  it('caps the timeout below the window the game accepts', async () => {
    const game = await startFakeGame();
    try {
      const client = createBridgeClient({ directory: game.directory, pollMs: 5, timeoutMs: 60_000 });
      const before = Date.now();
      await client.send('status', {});
      assert.ok(Number(game.requests[0]?.expiresAtMs) <= before + maxTimeoutMs + 50);
    } finally {
      await game.stop();
    }
  });

  it('explains a missing bridge folder', async () => {
    const directory = await makeBridgeDirectory();
    await rm(directory, { recursive: true });
    const client = createBridgeClient({ directory, pollMs: 5 });
    await assert.rejects(client.send('status', {}), /in-game bridge has not started/);
  });

  it('distinguishes an unresponsive bridge from an unconfirmed action', async () => {
    const game = await startFakeGame(() => undefined);
    try {
      const client = createBridgeClient({ directory: game.directory, pollMs: 5, timeoutMs: 80 });
      await assert.rejects(client.send('status', {}), /bridge did not respond/);
      await assert.rejects(client.send('sleep', {}), /did not confirm the action/);
      assert.deepEqual(await readdir(game.directory), []);
    } finally {
      await game.stop();
    }
  });

  it('waits for a reply that is still being written', async () => {
    const directory = await makeBridgeDirectory();
    try {
      const client = createBridgeClient({ directory, pollMs: 5, timeoutMs: 2_000 });
      const pending = client.send('status', {});

      let id: string | undefined;
      while (id === undefined) {
        id = (await readdir(directory)).map(file => /^request-([a-f0-9]{32})\.json$/.exec(file)?.[1]).find(Boolean);
        await delay(5);
      }
      const responsePath = join(directory, `response-${id}.json`);
      await writeFile(responsePath, '{"version":1,"id":');
      await delay(50);
      await writeFile(responsePath, JSON.stringify({ version: 1, id, ok: true }));

      assert.deepEqual(await pending, { ok: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects replies for another request', async () => {
    const game = await startFakeGame(() => ({ ok: true, id: 'f'.repeat(32) }));
    try {
      const client = createBridgeClient({ directory: game.directory, pollMs: 5 });
      await assert.rejects(client.send('status', {}), /unrelated response/);
    } finally {
      await game.stop();
    }
  });

  it('rejects malformed replies', async () => {
    const game = await startFakeGame(() => ({ ok: 'yes' }));
    try {
      const client = createBridgeClient({ directory: game.directory, pollMs: 5 });
      await assert.rejects(client.send('status', {}), /does not understand/);
    } finally {
      await game.stop();
    }
  });

  it('asks for a restart when the game runs an older bridge', async () => {
    const game = await startFakeGame(() => ({ ok: false, message: 'Unknown game action.' }));
    try {
      const client = createBridgeClient({ directory: game.directory, pollMs: 5 });
      await assert.rejects(client.send('fish_tank_action', {}), /older bridge/);
    } finally {
      await game.stop();
    }
  });

  it('stops waiting when the call is cancelled', async () => {
    const game = await startFakeGame(() => undefined);
    try {
      const client = createBridgeClient({ directory: game.directory, pollMs: 5, timeoutMs: 5_000 });
      const controller = new AbortController();
      const pending = client.send('status', {}, controller.signal);
      await delay(30);
      controller.abort();
      await assert.rejects(pending, { name: 'AbortError' });
      assert.deepEqual(await readdir(game.directory), []);
    } finally {
      await game.stop();
    }
  });
});
