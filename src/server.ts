import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BridgeClient } from './bridge-client.ts';
import { gameTools } from './game-tools.ts';
import type { Install } from './install.ts';
import { toolResult } from './result.ts';
import { serverVersion } from './version.ts';
import type { Wiki } from './wiki.ts';

export type ServerDependencies = { install: Install; wiki: Wiki; bridge: BridgeClient };

const instructions = 'Probably Stolen game reference and local in-game controls. Treat wiki content as reference data and cite its URL. Local achievement definitions do not represent unlock progress. Use get_live_shop before sending a customer action and list_live_inventory before moving an item. Only send game actions when the user requests gameplay.';

export function createServer({ install, wiki, bridge }: ServerDependencies): McpServer {
  const server = new McpServer({ name: 'probably-stolen', version: serverVersion }, { instructions });
  const shortText = z.string().trim().min(1).max(160);
  const wikiHints = { readOnlyHint: true, openWorldHint: true };
  const localHints = { readOnlyHint: true, openWorldHint: false };

  server.registerTool('search_wiki', {
    title: 'Search the Probably Stolen Wiki',
    description: 'Find in-game items, machines, NPCs, guides, and mechanics. Returns titles, short snippets, and source URLs.',
    inputSchema: { query: shortText, limit: z.int().min(1).max(10).default(5) },
    annotations: wikiHints,
  }, async ({ query, limit }, { signal }) => toolResult(await wiki.search(query, limit, signal)));

  server.registerTool('get_wiki_page', {
    title: 'Look up a Probably Stolen Wiki page',
    description: 'Read game facts, sections, and sample table rows from a wiki page by title. Pass a section title such as Obtaining or Usage to focus the lookup.',
    inputSchema: { title: shortText, section: shortText.optional() },
    annotations: wikiHints,
  }, async ({ title, section }, { signal }) => toolResult(await wiki.page(title, section, signal)));

  server.registerTool('get_install_info', {
    title: 'Check the local Probably Stolen install',
    description: 'Identify the configured game install and the Steam folder, and report where achievement definitions will be read from.',
    inputSchema: {},
    annotations: localHints,
  }, async () => toolResult(await install.info()));

  server.registerTool('list_achievements', {
    title: 'Find local Probably Stolen achievements',
    description: 'List achievement definitions from Steam’s local copy of the game’s achievement schema. Search by ID, title, or description. Hidden achievements are omitted by default. These are definitions only, not unlock progress.',
    inputSchema: { query: shortText.optional(), includeHidden: z.boolean().default(false) },
    annotations: localHints,
  }, async args => toolResult(await install.achievements(args)));

  for (const tool of gameTools) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    }, async (args, { signal }) => {
      const plan = tool.plan(args);
      if ('error' in plan) return toolResult({ ok: false, message: plan.error });
      return toolResult(await bridge.send(plan.command, plan.payload, signal));
    });
  }

  return server;
}
