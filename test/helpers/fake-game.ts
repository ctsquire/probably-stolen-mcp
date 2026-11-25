import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

export type GameRequest = Record<string, unknown>;

/** Returns the reply fields for a request, or undefined to leave it unanswered. */
export type Responder = (request: GameRequest) => Record<string, unknown> | undefined;

export type FakeGame = {
  directory: string;
  requests: GameRequest[];
  /** Stops polling and deletes the bridge folder. */
  stop: () => Promise<void>;
};

const requestFile = /^request-([a-f0-9]{32})\.json$/;
const requestSchema = z.record(z.string(), z.unknown());

export function makeBridgeDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'probably-stolen-mcp-'));
}

/** Imitates the in-game bridge: consumes request files and writes response files. */
export async function startFakeGame(respond: Responder = () => ({ ok: true })): Promise<FakeGame> {
  const directory = await makeBridgeDirectory();
  const requests: GameRequest[] = [];
  const stopped = new AbortController();

  const worker = (async () => {
    while (!stopped.signal.aborted) {
      for (const file of await readdir(directory)) {
        const id = requestFile.exec(file)?.[1];
        if (id === undefined) continue;
        const path = join(directory, file);
        const request = requestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        await rm(path);
        requests.push(request);
        const reply = respond(request);
        if (reply) {
          await writeFile(join(directory, `response-${id}.json`), JSON.stringify({ version: 1, id, ...reply }));
        }
      }
      await delay(5);
    }
  })();

  return {
    directory,
    requests,
    async stop() {
      stopped.abort();
      await worker;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
