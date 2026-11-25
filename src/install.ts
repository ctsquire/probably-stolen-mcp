import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { errorCode } from './errors.ts';

const dataDirectory = 'Probably Stolen_Data';
export const achievementFile = join(dataDirectory, 'Plugins', 'x86_64', 'steam_settings', 'achievements.json');

const achievementSchema = z.array(z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  hidden: z.union([z.boolean(), z.literal(0), z.literal(1)]),
}));

export type InstallInfo =
  | { configured: false; message: string }
  | {
    configured: true;
    directory: string;
    recognized: boolean;
    game: string | null;
    studio: string | null;
    achievementsAvailable: boolean;
  };

export type Achievement = { id: string; name: string; description: string; hidden: boolean };

export type AchievementList = {
  source: string;
  hiddenIncluded: boolean;
  total: number;
  achievements: Achievement[];
};

export type AchievementQuery = { query?: string | undefined; includeHidden: boolean };

export type Install = {
  info: () => Promise<InstallInfo>;
  achievements: (options: AchievementQuery) => Promise<AchievementList>;
};

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

async function readMetadata(path: string): Promise<{ studio: string | null; game: string | null }> {
  const [studio, game] = (await readFile(path, 'utf8')).trim().split(/\r?\n/, 2);
  return { studio: studio ?? null, game: game ?? null };
}

/** Opens the game install at `configuredPath`, or an unconfigured install when it is empty. */
export function openInstall(configuredPath: string | undefined): Install {
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
      const { studio, game } = metadataFound ? await readMetadata(infoPath) : { studio: null, game: null };

      return {
        configured: true,
        directory,
        recognized: executableFound && game === 'Probably Stolen',
        game,
        studio,
        achievementsAvailable,
      };
    },

    async achievements({ query, includeHidden }) {
      if (!directory) throw new Error('Set PROBABLY_STOLEN_GAME_DIR to the folder containing Probably Stolen.exe.');
      const path = join(directory, achievementFile);
      if (!(await isFile(path))) {
        throw new Error('This install does not contain achievements.json. Some editions may omit that file.');
      }

      let definitions: z.infer<typeof achievementSchema>;
      try {
        const json: unknown = JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''));
        definitions = achievementSchema.parse(json);
      } catch {
        throw new Error('Could not read the achievement definitions from this install.');
      }

      const terms = query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
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
