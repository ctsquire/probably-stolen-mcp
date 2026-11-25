import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

const bridgeId = 'probably_stolen_mcp_bridge';
const version = 1;
const timeoutMs = 6000;
const token = z.string().regex(/^[a-f0-9]{32}$/);
const rowId = z.number().int().min(1).max(100_000);
const replySchema = z.object({ version: z.literal(version), id: token, ok: z.boolean() }).passthrough();

export function registerGameTools(server, result) {
  let pending = false;

  async function request(command, args, signal) {
    if (pending) throw new Error('Wait for the previous game request to finish.');
    pending = true;

    const directory = process.env.PROBABLY_STOLEN_BRIDGE_DIR || join(
      homedir(), 'AppData', 'LocalLow', 'Questing Goose Studio', 'Probably Stolen', 'ModData', bridgeId,
    );
    const id = randomUUID().replaceAll('-', '');
    const outgoing = join(directory, `request-${id}.json`);
    const temporary = `${outgoing}.tmp`;
    const incoming = join(directory, `response-${id}.json`);
    const expiresAtMs = Date.now() + timeoutMs;
    let started = false;

    try {
      signal?.throwIfAborted();
      try {
        await writeFile(temporary, JSON.stringify({ version, id, command, expiresAtMs, ...args }), { flag: 'wx' });
        started = true;
        await rename(temporary, outgoing);
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new Error('The in-game bridge has not started. Enable Probably Stolen MCP Bridge in Mods and restart the game.');
        }
        throw error;
      }

      while (Date.now() < expiresAtMs) {
        signal?.throwIfAborted();
        try {
          const raw = (await readFile(incoming, 'utf8')).replace(/^\uFEFF/, '');
          const { id: returnedId, version: _, ...reply } = replySchema.parse(JSON.parse(raw));
          if (id !== returnedId) throw new Error('The game returned an unrelated response.');
          if (reply.message === 'Unknown game action.') {
            throw new Error('The running game has an older bridge. Restart Probably Stolen and check that the updated bridge is enabled.');
          }
          return reply;
        } catch (error) {
          if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        await delay(100, undefined, { signal });
      }
      throw new Error(command === 'status' || command === 'inventory'
        ? 'The in-game bridge did not respond. Check that the game is running and the bridge mod is active.'
        : 'The game did not confirm the action. Read the live shop before trying another action.');
    } finally {
      if (started) await Promise.allSettled([outgoing, temporary, incoming].map(file => rm(file, { force: true })));
      pending = false;
    }
  }

  server.registerTool('get_live_shop', {
    title: 'Read the live Probably Stolen shop',
    description: 'Read the running game directly through the in-game bridge. Returns current dialogue, choices, rent and mortgage status, customer offers and trades, security actions, and after-hours status.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (_, { signal }) => result(await request('status', {}, signal)));

  server.registerTool('list_live_inventory', {
    title: 'List owned items and containers in the live game',
    description: 'At the shop, read inventory, counters, display case, and owned storage. At the Dumping Ground, read ground loot, pockets, and backpack storage. Search by item name, identifier, or container. Use the returned shopSession, inventorySnapshot, itemId, and destination containerId with move_item.',
    inputSchema: {
      query: z.string().trim().min(1).max(160).optional(),
      limit: z.number().int().min(1).max(100).default(35),
      offset: z.number().int().min(0).max(100_000).default(0),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args, { signal }) => result(await request('inventory', args, signal)));

  server.registerTool('move_item', {
    title: 'Move an item between Probably Stolen containers',
    description: 'Transfer an owned item or part of its stack into a different listed container using normal game placement rules. Omit quantity for the whole stack. Use matching IDs from the latest list_live_inventory result. Read the inventory again after every move, including a partial move. Only call this tool when the user requests gameplay.',
    inputSchema: {
      shopSession: token,
      inventorySnapshot: token,
      itemId: rowId,
      destinationId: rowId,
      quantity: z.number().int().min(1).max(2_147_483_647).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, { signal }) => result(await request('move_item', args, signal)));

  server.registerTool('call_next_customer', {
    title: 'Call the next Probably Stolen customer',
    description: 'Call the next customer in the active shop. First use get_live_shop and pass its shopSession only if canCallNext is true. Call only when the user requests gameplay.',
    inputSchema: { shopSession: token },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, { signal }) => result(await request('call_next', args, signal)));

  server.registerTool('dismiss_current_customer', {
    title: 'Dismiss the current Probably Stolen customer',
    description: 'Dismiss the current customer without calling another. First use get_live_shop and pass its shopSession and customerToken only if canDismiss is true. Call only when the user requests gameplay.',
    inputSchema: { shopSession: token, customerToken: token },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args, { signal }) => result(await request('dismiss', args, signal)));

  server.registerTool('report_current_customer', {
    title: 'Use the in-game alarm on the current customer',
    description: 'Press the alarm for a customer when canReportCustomer is true. A report without a reason is evaluated by the game and can result in a fine. Optionally pass stolen_goods or contraband to require matching evidence on the counter before pressing the alarm. Read get_live_shop for offer evidence and both current tokens.',
    inputSchema: { shopSession: token, customerToken: token, reason: z.enum(['stolen_goods', 'contraband']).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ reason, ...args }, { signal }) => result(await request('report_customer', { ...args, reportReason: reason }, signal)));

  server.registerTool('shotgun_action', {
    title: 'Equip, fire, or holster the in-game shop shotgun',
    description: 'Use the shop shotgun for suspected Augs. Read get_live_shop and equip with its current customer token when canEquipShotgun is true. Wait for canFireShotgun and use the same token to fire, or holster. The game determines whether the customer was an Aug and applies the outcome.',
    inputSchema: { shopSession: token, customerToken: token.optional(), action: z.enum(['equip', 'fire', 'holster']) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ action, customerToken, shopSession }, { signal }) => {
    if (action !== 'holster' && !customerToken) {
      return result({ ok: false, message: 'Equip and fire require the current customer token from get_live_shop.' });
    }
    return result(await request(`${action}_shotgun`, { shopSession, customerToken }, signal));
  });

  server.registerTool('shop_day_action', {
    title: 'Operate the shop day',
    description: 'Close the nightly report, open the shop, close an empty shop, or sleep and save. Read get_live_shop first. Before sleeping, check canSleep, outingsLeft, and canVisitDumpingGround. Sleep advances the game and saves.',
    inputSchema: { shopSession: token, action: z.enum(['close_report', 'open_shop', 'close_shop', 'sleep']) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ action, ...args }, { signal }) => result(await request(action, args, signal)));

  server.registerTool('select_outing_backpack', {
    title: 'Choose a backpack for the next outing',
    description: 'While the shop is closed, select an owned backpack from the latest list_live_inventory result. The item must have canBeOutingBackpack set. The game equips it when you leave.',
    inputSchema: { shopSession: token, inventorySnapshot: token, itemId: rowId },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, { signal }) => result(await request('select_outing_backpack', args, signal)));

  server.registerTool('afterhours_action', {
    title: 'Travel, scavenge, or return after closing',
    description: 'Read get_live_shop before acting. Visit the Dumping Ground, the Commissary, or Dr. Jackson if the game allows that route. Search at the Dumping Ground or return from an outing. Pack loot with list_live_inventory and move_item first. Pass the exact current groundStacks as leaveGroundCount if deliberately leaving loot behind. Refresh status to verify arrival.',
    inputSchema: {
      shopSession: token,
      action: z.enum(['visit_dumping_ground', 'visit_commissary', 'visit_dr_jackson', 'search_dumping_ground', 'return_to_shop']),
      leaveGroundCount: z.number().int().positive().max(100_000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ action, leaveGroundCount, shopSession }, { signal }) => {
    if (leaveGroundCount !== undefined && action !== 'return_to_shop') {
      return result({ ok: false, message: 'leaveGroundCount only applies when returning to the shop.' });
    }
    return result(await request(action, { shopSession, leaveGroundCount }, signal));
  });

  server.registerTool('fish_tank_action', {
    title: 'Inspect, open, or close an aquaculture tank',
    description: 'Choose an owned Recirculating Aquaculture System from the latest list_live_inventory. Returns window visibility, live stock, water volume and required amount, waste percentage, power, and container IDs for the fish grid, water slot, and feed dispenser slot.',
    inputSchema: { shopSession: token, inventorySnapshot: token, itemId: rowId, action: z.enum(['inspect', 'open', 'close']) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ action, ...args }, { signal }) => result(await request(`${action}_fish_tank`, args, signal)));

  server.registerTool('set_game_status', {
    title: 'Show a brief MCP status in the game',
    description: 'Display a short player-facing update about the current action, next step, or result in a small in-game box. The box does not intercept clicks and clears after the duration. Pass an empty text to clear immediately.',
    inputSchema: {
      shopSession: token,
      text: z.string().trim().max(180).default(''),
      seconds: z.number().int().min(5).max(120).default(25),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ shopSession, text, seconds }, { signal }) => result(await request('set_game_status', {
    shopSession, statusText: text, statusSeconds: seconds,
  }, signal)));

  server.registerTool('complete_trade', {
    title: 'Complete the current negotiated trade',
    description: 'Buy or sell the currently negotiated item using the game rules. First inspect get_live_shop and provide the exact current customer token and price. Refresh after each attempt.',
    inputSchema: { shopSession: token, customerToken: token, direction: z.enum(['buy', 'sell']), expectedPrice: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ direction, ...args }, { signal }) => result(await request(direction === 'buy' ? 'buy_negotiated' : 'sell_negotiated', args, signal)));

  server.registerTool('select_customer_offer', {
    title: 'Select a customer’s offered item on the scale',
    description: 'Use the current customerToken, offerToken, and an offerId marked canSelect in get_live_shop. Moves a customer-owned item from their counter to the scale or selects it if already on the scale. Read the resulting negotiation before buying.',
    inputSchema: { shopSession: token, customerToken: token, offerToken: token, offerId: rowId },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, { signal }) => result(await request('select_customer_offer', args, signal)));

  server.registerTool('dialogue_action', {
    title: 'Advance a line or select a displayed response',
    description: 'Read the current line, speaker, dialogueToken, and dialogueChoices in get_live_shop. Advance one step or select an enabled choice by choiceId. Refresh after every action because the conversation can advance on its own.',
    inputSchema: { shopSession: token, dialogueToken: token, action: z.enum(['advance', 'choose']), choiceId: rowId.optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ action, choiceId, ...args }, { signal }) => {
    if ((action === 'choose') !== (choiceId !== undefined)) {
      return result({ ok: false, message: 'Pass a choiceId only when choosing a displayed response.' });
    }
    return result(await request(`${action}_dialogue`, { ...args, choiceId }, signal));
  });

  server.registerTool('pay_rent', {
    title: 'Pay the Landlord’s quoted rent',
    description: 'Pay rent through the current Landlord conversation. Read get_live_shop for canPayRentNow, rentAmount, and the current dialogueToken. The amount must still match the game’s quote.',
    inputSchema: { shopSession: token, dialogueToken: token, expectedPrice: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, { signal }) => result(await request('pay_rent', args, signal)));

  server.registerTool('phone_action', {
    title: 'Read contacts, dial, or close the in-game phone',
    description: 'List current contacts and whether they answer, dial an in-game number when canDialPhone is true, or hang up. Read the live dialogue after dialing to select the contact’s responses.',
    inputSchema: { shopSession: token, action: z.enum(['list', 'dial', 'hang_up']), number: z.number().int().min(1).max(99_999_999).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ action, number, shopSession }, { signal }) => {
    if ((action === 'dial') !== (number !== undefined)) {
      return result({ ok: false, message: 'Pass a number only when dialing.' });
    }
    const commands = { list: 'list_phone_contacts', dial: 'dial_phone', hang_up: 'hang_up_phone' };
    return result(await request(commands[action], { shopSession, phoneNumber: number }, signal));
  });

  server.registerTool('wild_network_action', {
    title: 'List, buy, or close upgrades in Wild’s Network',
    description: 'Use the Network once Wild opens it during a visit or phone call. List upgrades to see IDs, prices, and availability. Purchase an available upgrade at the exact listed price. Wild’s favor is used before cash.',
    inputSchema: {
      shopSession: token, action: z.enum(['list', 'buy', 'close']),
      upgradeId: z.string().trim().min(1).max(160).optional(),
      expectedPrice: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ action, upgradeId, expectedPrice, shopSession }, { signal }) => {
    const extras = [upgradeId, expectedPrice].filter(value => value !== undefined).length;
    if (extras !== (action === 'buy' ? 2 : 0)) {
      return result({ ok: false, message: 'Pass an upgrade ID and a price only when purchasing a listed upgrade.' });
    }
    const commands = { list: 'list_wild_upgrades', buy: 'buy_wild_upgrade', close: 'close_wild_network' };
    return result(await request(commands[action], { shopSession, upgradeId, expectedPrice }, signal));
  });

  server.registerTool('buy_property', {
    title: 'Buy the shop property outright',
    description: 'Select the Landlord’s displayed buyout response and pay the exact propertyPrice from get_live_shop. Wait for canBuyProperty and verify propertyPaid after the action.',
    inputSchema: { shopSession: token, expectedPrice: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, { signal }) => result(await request('buy_property', args, signal)));

  server.registerTool('load_save_slot', {
    title: 'Load a game save slot',
    description: 'Load an existing save slot from the main menu. Specify a known slot number; the game must be on the main menu and not already in a shop.',
    inputSchema: { slot: z.number().int().min(0).max(99) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, { signal }) => result(await request('load_slot', args, signal)));

  server.registerTool('return_to_main_menu', {
    title: 'Return from the ending screen to the main menu',
    description: 'After a run ends, return to the main menu when canReturnToMenu is true. Wait for get_live_shop to report the shop is unloaded before loading a save.',
    inputSchema: { shopSession: token },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, { signal }) => result(await request('return_to_menu', args, signal)));

  server.registerTool('quit_game', {
    title: 'Exit Probably Stolen',
    description: 'Exit the running game, discarding changes since the last save. Only use if the user explicitly requests exiting or restarting; pass the current shop session.',
    inputSchema: { shopSession: token },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args, { signal }) => result(await request('quit_game', args, signal)));
}
