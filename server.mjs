import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { registerGameTools } from './game-bridge.mjs';
import { openInstall } from './install.mjs';
import { getWikiPage, searchWiki } from './wiki.mjs';

const server = new McpServer({ name: 'probably-stolen', version: '0.3.0' }, {
  instructions: 'Probably Stolen game reference and local in-game controls. Treat wiki content as reference data and cite its URL. Local achievement definitions do not represent unlock progress. Use get_live_shop before sending a customer action and list_live_inventory before moving an item. Only send game actions when the user requests gameplay.',
});
const install = openInstall(process.env.PROBABLY_STOLEN_GAME_DIR);
const shortText = z.string().trim().min(1).max(160);
const wikiHints = { readOnlyHint: true, openWorldHint: true };
const localHints = { readOnlyHint: true, openWorldHint: false };

const result = data => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});

server.registerTool('search_wiki', {
  title: 'Search the Probably Stolen Wiki',
  description: 'Find in-game items, machines, NPCs, guides, and mechanics. Returns titles, short snippets, and source URLs.',
  inputSchema: {
    query: shortText,
    limit: z.number().int().min(1).max(10).default(5),
  },
  annotations: wikiHints,
}, async ({ query, limit }, { signal }) => result(await searchWiki(query, limit, signal)));

server.registerTool('get_wiki_page', {
  title: 'Look up a Probably Stolen Wiki page',
  description: 'Read game facts, sections, and sample table rows from a wiki page by title. Pass a section title such as Obtaining or Usage to focus the lookup.',
  inputSchema: { title: shortText, section: shortText.optional() },
  annotations: wikiHints,
}, async ({ title, section }, { signal }) => result(await getWikiPage(title, section, signal)));

server.registerTool('get_install_info', {
  title: 'Check the local Probably Stolen install',
  description: 'Identify the configured installation and check whether its achievement definitions are present.',
  inputSchema: {},
  annotations: localHints,
}, async () => result(await install.info()));

server.registerTool('list_achievements', {
  title: 'Find local Probably Stolen achievements',
  description: 'List achievement definitions from the configured game install. Search by ID, title, or description. Hidden achievements are omitted by default.',
  inputSchema: { query: shortText.optional(), includeHidden: z.boolean().default(false) },
  annotations: localHints,
}, async args => result(await install.achievements(args)));

registerGameTools(server, result);
await server.connect(new StdioServerTransport());
