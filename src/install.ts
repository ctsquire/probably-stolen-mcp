import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { errorCode } from './errors.ts';
import { findSteamDirectory, readSteamAchievements, schemaPath, type AchievementDefinition } from './steam.ts';

const dataDirectory = 'Probably Stolen_Data';

/** Achievement list some setups keep next to the game's Steam API library. Used when Steam's own schema is missing. */
export const gameAchievementFile = join(dataDirectory, 'Plugins', 'x86_64', 'steam_settings', 'achievements.json');

const gameAchievementSchema = z.array(z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  hidden: z.union([z.boolean(), z.literal(0), z.literal(1)]),
}));

export type AchievementSource = { kind: 'steam' | 'game-files'; path: string };

export type InstallInfo = {
  configured: boolean;
  message?: string;
  directory?: string;
  recognized?: boolean;
  game?: string | null;
  studio?: string | null;
  steamDirectory: string | null;
  achievementSource: AchievementSource | null;
};

export type Achievement = AchievementDefinition;

export type AchievementList = {
  source: AchievementSource;
  hiddenIncluded: boolean;
  total: number;
  achievements: Achievement[];
};

export type AchievementQuery = { query?: string | undefined; includeHidden: boolean };

export type Install = {
  info: () => Promise<InstallInfo>;
  achievements: (options: AchievementQuery) => Promise<AchievementList>;
};

export type InstallOptions = {
  /** Folder containing Probably Stolen.exe, usually from PROBABLY_STOLEN_GAME_DIR. */
  gameDirectory?: string | undefined;
  /** Locates the Steam client folder. Defaults to {@link findSteamDirectory}. */
  findSteam?: () => Promise<string | undefined>;
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

async function readGameAchievements(path: string): Promise<AchievementDefinition[]> {
  const json: unknown = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  return gameAchievementSchema.parse(json).map(({ name, displayName, description, hidden }) => ({
    id: name, name: displayName, description, hidden: Boolean(hidden),
  }));
}

/** Opens the local game and Steam installs used by the offline tools. */
export function openInstall({ gameDirectory, findSteam = findSteamDirectory }: InstallOptions = {}): Install {
  const directory = gameDirectory ? resolve(gameDirectory) : null;
  let steamLookup: Promise<string | undefined> | undefined;
  const steamDirectory = (): Promise<string | undefined> => (steamLookup ??= findSteam());

  async function achievementSource(): Promise<AchievementSource | null> {
    const steam = await steamDirectory();
    if (steam && await isFile(schemaPath(steam))) return { kind: 'steam', path: schemaPath(steam) };
    if (directory && await isFile(join(directory, gameAchievementFile))) {
      return { kind: 'game-files', path: join(directory, gameAchievementFile) };
    }
    return null;
  }

  return {
    async info() {
      const [steam, source] = await Promise.all([steamDirectory(), achievementSource()]);
      const shared = { steamDirectory: steam ?? null, achievementSource: source };
      if (!directory) {
        return { configured: false, message: 'Set PROBABLY_STOLEN_GAME_DIR to identify the game install.', ...shared };
      }

      const infoPath = join(directory, dataDirectory, 'app.info');
      const [executableFound, metadataFound] = await Promise.all([
        isFile(join(directory, 'Probably Stolen.exe')),
        isFile(infoPath),
      ]);
      const { studio, game } = metadataFound ? await readMetadata(infoPath) : { studio: null, game: null };
      return {
        configured: true,
        directory,
        recognized: executableFound && game === 'Probably Stolen',
        game,
        studio,
        ...shared,
      };
    },

    async achievements({ query, includeHidden }) {
      const source = await achievementSource();
      if (!source) {
        throw new Error('Could not find the Probably Stolen achievement list. Launch the game through Steam once so Steam caches it, or set STEAM_DIR if Steam is installed in an unusual folder.');
      }

      let definitions: AchievementDefinition[];
      try {
        definitions = source.kind === 'steam' ? await readSteamAchievements(source.path) : await readGameAchievements(source.path);
      } catch (error) {
        throw new Error(`Could not read the achievement list at ${source.path}.`, { cause: error });
      }

      const terms = query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      const achievements = definitions.filter(({ id, name, description, hidden }) => {
        if (hidden && !includeHidden) return false;
        const searchable = `${id} ${name} ${description}`.toLowerCase();
        return terms.every(term => searchable.includes(term));
      });
      return { source, hiddenIncluded: includeHidden, total: achievements.length, achievements };
    },
  };
}
