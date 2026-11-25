import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const dataDirectory = 'Probably Stolen_Data';
const achievementFile = join(dataDirectory, 'Plugins', 'x86_64', 'steam_settings', 'achievements.json');
const achievementSchema = z.array(z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  hidden: z.union([z.boolean(), z.literal(0), z.literal(1)]),
}));

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

export function openInstall(configuredPath) {
  const directory = configuredPath ? resolve(configuredPath) : null;

  return {
    async info() {
      if (!directory) return { configured: false, message: 'Set PROBABLY_STOLEN_GAME_DIR to enable local tools.' };

      const infoPath = join(directory, dataDirectory, 'app.info');
      const [executableFound, metadataFound, achievementsAvailable] = await Promise.all([
        isFile(join(directory, 'Probably Stolen.exe')),
        isFile(infoPath),
        isFile(join(directory, achievementFile)),
      ]);
      const [studio, game] = metadataFound
        ? (await readFile(infoPath, 'utf8')).trim().split(/\r?\n/, 2)
        : [];

      return {
        configured: true,
        directory,
        recognized: executableFound && game === 'Probably Stolen',
        game: game ?? null,
        studio: studio ?? null,
        achievementsAvailable,
      };
    },

    async achievements({ query, includeHidden }) {
      if (!directory) throw new Error('Set PROBABLY_STOLEN_GAME_DIR to the folder containing Probably Stolen.exe.');
      const path = join(directory, achievementFile);
      if (!(await isFile(path))) {
        throw new Error('This install does not contain achievements.json. Some editions may omit that file.');
      }

      let definitions;
      try {
        const json = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
        definitions = achievementSchema.parse(JSON.parse(json));
      } catch {
        throw new Error('Could not read the achievement definitions from this install.');
      }

      const terms = query?.toLowerCase().split(/\s+/) ?? [];
      const achievements = definitions.flatMap(({ name, displayName, description, hidden }) => {
        if (hidden && !includeHidden) return [];
        const searchable = `${name} ${displayName} ${description}`.toLowerCase();
        if (!terms.every(term => searchable.includes(term))) return [];
        return [{ id: name, name: displayName, description, hidden: Boolean(hidden) }];
      });
      return { source: achievementFile, hiddenIncluded: includeHidden, total: achievements.length, achievements };
    },
  };
}
