import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { child, parseBinaryKeyValues, type KeyValue, type KeyValues } from './binary-kv.ts';
import { errorCode } from './errors.ts';

/** Probably Stolen's Steam app ID. */
export const steamAppId = 4348910;

export type AchievementDefinition = { id: string; name: string; description: string; hidden: boolean };

const run = promisify(execFile);

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return false;
    throw error;
  }
}

/** Reads Steam's install folder from the Windows registry. */
async function registrySteamPath(): Promise<string | undefined> {
  try {
    const { stdout } = await run('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true });
    return /SteamPath\s+REG_\w+\s+(.+)/.exec(stdout)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/** Finds the Steam client folder: `STEAM_DIR`, then the registry on Windows, then the usual install locations. */
export async function findSteamDirectory(): Promise<string | undefined> {
  const configured = process.env.STEAM_DIR;
  if (configured) return configured;

  const candidates = process.platform === 'win32'
    ? [await registrySteamPath(), 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']
    : [join(homedir(), '.steam', 'steam'), join(homedir(), '.local', 'share', 'Steam'), join(homedir(), 'Library', 'Application Support', 'Steam')];

  for (const candidate of candidates) {
    if (candidate && await isDirectory(candidate)) return candidate;
  }
  return undefined;
}

export function schemaPath(steamDirectory: string): string {
  return join(steamDirectory, 'appcache', 'stats', `UserGameStatsSchema_${String(steamAppId)}.bin`);
}

/** Resolves a localized schema string: the English text, or the value itself when it is a plain string. */
function localized(value: KeyValue | undefined, fallback: string): string {
  if (typeof value === 'string') return value;
  if (value instanceof Map) {
    const english = child(value, 'english');
    if (typeof english === 'string' && english) return english;
    for (const text of value.values()) {
      if (typeof text === 'string' && text) return text;
    }
  }
  return fallback;
}

function isSet(value: KeyValue | undefined): boolean {
  if (typeof value === 'string') return value.trim() !== '' && Number(value) !== 0;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  return false;
}

/** Extracts achievement definitions from a parsed schema, in file order. */
export function achievementsFromSchema(schema: KeyValues, appId = steamAppId): AchievementDefinition[] {
  const game = child(schema, String(appId));
  const stats = game instanceof Map ? child(game, 'stats') : undefined;
  if (!(stats instanceof Map)) throw new Error('The Steam schema does not list any stats for Probably Stolen.');

  const achievements: AchievementDefinition[] = [];
  for (const entry of stats.values()) {
    const bits = entry instanceof Map ? child(entry, 'bits') : undefined;
    if (!(bits instanceof Map)) continue;
    for (const bit of bits.values()) {
      if (!(bit instanceof Map)) continue;
      const id = child(bit, 'name');
      if (typeof id !== 'string' || !id) continue;
      const displayValue = child(bit, 'display');
      const display: KeyValues = displayValue instanceof Map ? displayValue : new Map<string, KeyValue>();
      achievements.push({
        id,
        name: localized(child(display, 'name'), id),
        description: localized(child(display, 'desc'), ''),
        hidden: isSet(child(display, 'hidden')),
      });
    }
  }
  return achievements;
}

export async function readSteamAchievements(path: string): Promise<AchievementDefinition[]> {
  return achievementsFromSchema(parseBinaryKeyValues(await readFile(path)));
}
