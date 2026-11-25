import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { achievementFile, openInstall } from '../src/install.ts';

const definitions = [
  { name: 'FIRST_SALE', displayName: 'Open for Business', description: 'Sell your first item.', hidden: 0 },
  { name: 'BIG_FISH', displayName: 'Aquaculture', description: 'Harvest a fish from a tank.', hidden: false },
  { name: 'SECRET_ENDING', displayName: 'Probably Stolen', description: 'Reach the secret ending.', hidden: 1 },
];

async function writeInstall(directory: string, achievements: string | null): Promise<void> {
  await mkdir(join(directory, 'Probably Stolen_Data'), { recursive: true });
  await writeFile(join(directory, 'Probably Stolen.exe'), '');
  await writeFile(join(directory, 'Probably Stolen_Data', 'app.info'), 'Questing Goose Studio\r\nProbably Stolen\r\n');
  if (achievements !== null) {
    await mkdir(dirname(join(directory, achievementFile)), { recursive: true });
    await writeFile(join(directory, achievementFile), achievements);
  }
}

describe('install', () => {
  let root: string;
  before(async () => { root = await mkdtemp(join(tmpdir(), 'probably-stolen-install-')); });
  after(async () => { await rm(root, { recursive: true, force: true }); });

  it('reports when no install is configured', async () => {
    const install = openInstall(undefined);
    assert.deepEqual(await install.info(), { configured: false, message: 'Set PROBABLY_STOLEN_GAME_DIR to enable local tools.' });
    await assert.rejects(install.achievements({ includeHidden: false }), /PROBABLY_STOLEN_GAME_DIR/);
  });

  it('recognises a complete install', async () => {
    const directory = join(root, 'complete');
    await writeInstall(directory, `\uFEFF${JSON.stringify(definitions)}`);
    assert.deepEqual(await openInstall(directory).info(), {
      configured: true,
      directory,
      recognized: true,
      game: 'Probably Stolen',
      studio: 'Questing Goose Studio',
      achievementsAvailable: true,
    });
  });

  it('does not recognise a folder without the game', async () => {
    const directory = join(root, 'empty');
    await mkdir(directory);
    const info = await openInstall(directory).info();
    assert.ok(info.configured);
    assert.equal(info.recognized, false);
    assert.equal(info.game, null);
    assert.equal(info.achievementsAvailable, false);
  });

  it('lists visible achievements and filters by every search term', async () => {
    const directory = join(root, 'achievements');
    await writeInstall(directory, JSON.stringify(definitions));
    const install = openInstall(directory);

    const visible = await install.achievements({ includeHidden: false });
    assert.deepEqual(visible.achievements.map(({ id }) => id), ['FIRST_SALE', 'BIG_FISH']);
    assert.equal(visible.total, 2);
    assert.equal(visible.hiddenIncluded, false);

    const everything = await install.achievements({ includeHidden: true });
    assert.deepEqual(everything.achievements.at(-1), {
      id: 'SECRET_ENDING', name: 'Probably Stolen', description: 'Reach the secret ending.', hidden: true,
    });

    const search = await install.achievements({ query: 'FISH tank', includeHidden: false });
    assert.deepEqual(search.achievements.map(({ id }) => id), ['BIG_FISH']);
  });

  it('explains a missing or unreadable achievements file', async () => {
    const missing = join(root, 'missing');
    await writeInstall(missing, null);
    await assert.rejects(openInstall(missing).achievements({ includeHidden: false }), /does not contain achievements\.json/);

    const broken = join(root, 'broken');
    await writeInstall(broken, '[{"name": 1}]');
    await assert.rejects(openInstall(broken).achievements({ includeHidden: false }), /Could not read the achievement definitions/);
  });
});
