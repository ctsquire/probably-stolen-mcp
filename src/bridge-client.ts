import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { errorCode } from './errors.ts';
import { protocolVersion } from './version.ts';

export const bridgeId = 'probably_stolen_mcp_bridge';

/** The game ignores requests that expire more than 15 seconds ahead, so timeouts must stay below that. */
export const maxTimeoutMs = 15_000;

/** Commands that only read state; a missing reply to these means the bridge is not running. */
const readCommands = new Set(['status', 'inventory']);

/**
 * Errors worth retrying while waiting for a reply: the file does not exist yet, or (on Windows)
 * the game still has it open for writing.
 */
const retryableReadErrors = new Set(['ENOENT', 'EBUSY', 'EPERM', 'EACCES']);

const replySchema = z.looseObject({
  version: z.literal(protocolVersion),
  id: z.string(),
  ok: z.boolean(),
});

export type BridgeReply = { ok: boolean } & Record<string, unknown>;

export type BridgeClientOptions = {
  /** Folder shared with the game mod. Defaults to the mod's data folder under LocalLow. */
  directory?: string;
  timeoutMs?: number;
  pollMs?: number;
};

export type BridgeClient = {
  readonly directory: string;
  send: (command: string, payload: Record<string, unknown>, signal?: AbortSignal) => Promise<BridgeReply>;
};

export function defaultBridgeDirectory(): string {
  const configured = process.env.PROBABLY_STOLEN_BRIDGE_DIR;
  if (configured) return configured;
  return join(homedir(), 'AppData', 'LocalLow', 'Questing Goose Studio', 'Probably Stolen', 'ModData', bridgeId);
}

/** Reads a reply file, returning undefined while it is missing, locked, or still being written. */
async function readReply(path: string, id: string): Promise<BridgeReply | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (retryableReadErrors.has(errorCode(error) ?? '')) return undefined;
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }

  const parsed = replySchema.safeParse(json);
  if (!parsed.success) throw new Error('The game returned a response this server does not understand.');
  if (parsed.data.id !== id) throw new Error('The game returned an unrelated response.');
  if (parsed.data.message === 'Unknown game action.') {
    throw new Error('The running game has an older bridge. Restart Probably Stolen and check that the updated bridge is enabled.');
  }

  const fields = Object.entries(parsed.data).filter(([key]) => key !== 'version' && key !== 'id');
  return { ...Object.fromEntries(fields), ok: parsed.data.ok };
}

/**
 * Talks to the in-game bridge through request and response files. Requests are sent one at a
 * time, in call order, so concurrent tool calls queue instead of failing.
 */
export function createBridgeClient(options: BridgeClientOptions = {}): BridgeClient {
  const directory = options.directory ?? defaultBridgeDirectory();
  const timeoutMs = Math.min(options.timeoutMs ?? 6_000, maxTimeoutMs);
  const pollMs = options.pollMs ?? 100;
  let queue: Promise<unknown> = Promise.resolve();

  async function exchange(command: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeReply> {
    signal?.throwIfAborted();
    const id = randomUUID().replaceAll('-', '');
    const requestPath = join(directory, `request-${id}.json`);
    const temporaryPath = `${requestPath}.tmp`;
    const responsePath = join(directory, `response-${id}.json`);
    const expiresAtMs = Date.now() + timeoutMs;
    let written = false;

    try {
      try {
        const body = JSON.stringify({ ...payload, version: protocolVersion, id, command, expiresAtMs });
        await writeFile(temporaryPath, body, { flag: 'wx' });
        written = true;
        await rename(temporaryPath, requestPath);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          throw new Error('The in-game bridge has not started. Enable Probably Stolen MCP Bridge in Mods and restart the game.', { cause: error });
        }
        throw error;
      }

      while (Date.now() < expiresAtMs) {
        signal?.throwIfAborted();
        const reply = await readReply(responsePath, id);
        if (reply) return reply;
        await delay(pollMs, undefined, { signal });
      }
      throw new Error(readCommands.has(command)
        ? 'The in-game bridge did not respond. Check that the game is running and the bridge mod is active.'
        : 'The game did not confirm the action. Read the live shop before trying another action.');
    } finally {
      if (written) await Promise.allSettled([requestPath, temporaryPath, responsePath].map(file => rm(file, { force: true })));
    }
  }

  return {
    directory,
    send(command, payload, signal) {
      const run = queue.then(() => exchange(command, payload, signal));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
