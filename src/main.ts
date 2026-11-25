import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBridgeClient } from './bridge-client.ts';
import { openInstall } from './install.ts';
import { createServer } from './server.ts';
import { createWiki } from './wiki.ts';

const server = createServer({
  install: openInstall({ gameDirectory: process.env.PROBABLY_STOLEN_GAME_DIR }),
  wiki: createWiki(),
  bridge: createBridgeClient(),
});
await server.connect(new StdioServerTransport());
