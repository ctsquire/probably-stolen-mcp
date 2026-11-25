import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { gameAchievementFile, openInstall } from '../src/install.ts';
import { schemaPath, steamAppId } from '../src/steam.ts';
import { schemaFixture } from './helpers/binary-kv-writer.ts';

const gameDefinitions = [
  { name: 'FIRST_SALE', displayName: 'Open for Business', description: 'Sell your first item.', hidden: 0 },
  { name: 'SECRET_ENDING', displayName: 'Probably Stolen', description: 'Reach the secret ending.', hidden: 1 },
];

const noSteam = (): Promise<undefined> => Promise.resolve(undefined);

async function writeGame(directory: string, achievements: string | null): Promise<void> {
  await mkdir(join(directory, 'Probably Stolen_Data'), { recursive: true });
  await writeFile(join(directory, 'Probably Stolen.exe'), '');
  await writeFile(join(directory, 'Probably Stolen_Data', 'app.info'), 'Questing Goose Studio\r\nProbably Stolen\r\n');
  if (achievements !== null) {
    await mkdir(dirname(join(directory, gameAchievementFile)), { recursive: true });
    await writeFile(join(directory, gameAchievementFile), achievements);
  }
}

async function writeSteam(directory: string): Promise<void> {
  const path = schemaPath(directory);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, schemaFixture(steamAppId, [
    { id: 'FIRST_SALE', name: 'Open for Business', description: 'Sell your first item.' },
    { id: 'BIG_FISH', name: 'Aquaculture', description: 'Harvest a fish from a tank.' },
    { id: 'SECRET_ENDING', name: 'Probably Stolen', description: 'Reach the secret ending.', hidden: { key: 'hidden', string: '1' } },
  ]));
}

describe('install', () => {
  let root: string;
  before(async () => { root = await mkdtemp(join(tmpdir(), 'probably-stolen-install-')); });
  after(async () => { await rm(root, { recursive: true, force: true }); });

  it('reports a missing game folder and achievement list', async () => {
    const install = openInstall({ findSteam: noSteam });
    assert.deepEqual(await install.info(), {
      configured: false,
      message: 'Set PROBABLY_STOLEN_GAME_DIR to identify the game install.',
      steamDirectory: null,
      achievementSource: null,
    });
    await assert.rejects(install.achievements({ includeHidden: false }), /Launch the game through Steam once/);
  });

  it('recognises a game install and Steam schema', async () => {
    const game = join(root, 'recognised-game');
    const steam = join(root, 'recognised-steam');
    await writeGame(game, null);
    await writeSteam(steam);

    assert.deepEqual(await openInstall({ gameDirectory: game, findSteam: () => Promise.resolve(steam) }).info(), {
      configured: true,
      directory: game,
      recognized: true,
      game: 'Probably Stolen',
      studio: 'Questing Goose Studio',
      steamDirectory: steam,
      achievementSource: { kind: 'steam', path: schemaPath(steam) },
    });
  });

  it('does not recognise a folder without the game', async () => {
    const directory = join(root, 'empty');
    await mkdir(directory);
    const info = await openInstall({ gameDirectory: directory, findSteam: noSteam }).info();
    assert.equal(info.recognized, false);
    assert.equal(info.game, null);
  });

  it('reads achievements from Steam without a game folder', async () => {
    const steam = join(root, 'steam-only');
    await writeSteam(steam);
    const install = openInstall({ findSteam: () => Promise.resolve(steam) });

    const visible = await install.achievements({ includeHidden: false });
    assert.equal(visible.source.kind, 'steam');
    assert.deepEqual(visible.achievements.map(({ id }) => id), ['FIRST_SALE', 'BIG_FISH']);

    const everything = await install.achievements({ includeHidden: true });
    assert.equal(everything.total, 3);
    assert.deepEqual(everything.achievements.at(-1), {
      id: 'SECRET_ENDING', name: 'Probably Stolen', description: 'Reach the secret ending.', hidden: true,
    });

    const search = await install.achievements({ query: 'FISH tank', includeHidden: false });
    assert.deepEqual(search.achievements.map(({ id }) => id), ['BIG_FISH']);
  });

  it('prefers Steam over files in the game folder', async () => {
    const game = join(root, 'both-game');
    const steam = join(root, 'both-steam');
    await writeGame(game, JSON.stringify(gameDefinitions));
    await writeSteam(steam);
    const list = await openInstall({ gameDirectory: game, findSteam: () => Promise.resolve(steam) }).achievements({ includeHidden: true });
    assert.equal(list.source.kind, 'steam');
    assert.equal(list.total, 3);
  });

  it('falls back to an achievements.json in the game folder', async () => {
    const game = join(root, 'game-files');
    await writeGame(game, `\uFEFF${JSON.stringify(gameDefinitions)}`);
    const list = await openInstall({ gameDirectory: game, findSteam: noSteam }).achievements({ includeHidden: true });
    assert.deepEqual(list.source, { kind: 'game-files', path: join(game, gameAchievementFile) });
    assert.deepEqual(list.achievements.map(({ id, hidden }) => [id, hidden]), [['FIRST_SALE', false], ['SECRET_ENDING', true]]);
  });

  it('explains an unreadable achievement list', async () => {
    const steam = join(root, 'broken-steam');
    await mkdir(dirname(schemaPath(steam)), { recursive: true });
    await writeFile(schemaPath(steam), Buffer.from([0, 0x31]));
    await assert.rejects(
      openInstall({ findSteam: () => Promise.resolve(steam) }).achievements({ includeHidden: false }),
      /Could not read the achievement list/,
    );

    const game = join(root, 'broken-game');
    await writeGame(game, '[{"name": 1}]');
    await assert.rejects(
      openInstall({ gameDirectory: game, findSteam: noSteam }).achievements({ includeHidden: false }),
      /Could not read the achievement list/,
    );
  });
});
