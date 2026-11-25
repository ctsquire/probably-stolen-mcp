import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { gameTools, type GameTool } from '../src/game-tools.ts';

const shopSession = 'a'.repeat(32);
const customerToken = 'b'.repeat(32);
const inventorySnapshot = 'c'.repeat(32);
const dialogueToken = 'd'.repeat(32);
const offerToken = 'e'.repeat(32);
const customer = { shopSession, customerToken };

function tool(name: string): GameTool {
  const found = gameTools.find(candidate => candidate.name === name);
  assert.ok(found, `${name} must be defined`);
  return found;
}

/** Applies schema defaults the way the MCP SDK does before a tool handler runs. */
function plan(name: string, args: Record<string, unknown>): ReturnType<GameTool['plan']> {
  const definition = tool(name);
  return definition.plan(z.object(definition.inputSchema).parse(args));
}

type Case = [tool: string, args: Record<string, unknown>, command: string, payload?: Record<string, unknown>];

const cases: Case[] = [
  ['get_live_shop', {}, 'status'],
  ['list_live_inventory', { query: 'ras' }, 'inventory', { query: 'ras', limit: 35, offset: 0 }],
  ['move_item', { shopSession, inventorySnapshot, itemId: 1, destinationId: 3 }, 'move_item'],
  ['move_item', { shopSession, inventorySnapshot, itemId: 1, destinationId: 3, quantity: 2 }, 'move_item'],
  ['use_item_on_item', { shopSession, inventorySnapshot, itemId: 9, targetItemId: 16 }, 'use_item_on_item'],
  ['call_next_customer', { shopSession }, 'call_next'],
  ['dismiss_current_customer', customer, 'dismiss'],
  ['shop_day_action', { shopSession, action: 'sleep' }, 'sleep', { shopSession }],
  ['complete_trade', { ...customer, direction: 'sell', expectedPrice: 42 }, 'sell_negotiated', { ...customer, expectedPrice: 42 }],
  ['complete_trade', { ...customer, direction: 'buy', expectedPrice: 7 }, 'buy_negotiated', { ...customer, expectedPrice: 7 }],
  ['select_customer_offer', { ...customer, offerToken, offerId: 2 }, 'select_customer_offer'],
  ['dialogue_action', { shopSession, dialogueToken, action: 'advance' }, 'advance_dialogue', { shopSession, dialogueToken }],
  ['dialogue_action', { shopSession, dialogueToken, action: 'choose', choiceId: 2 }, 'choose_dialogue', { shopSession, dialogueToken, choiceId: 2 }],
  ['pay_rent', { shopSession, dialogueToken, expectedPrice: 230 }, 'pay_rent'],
  ['phone_action', { shopSession, action: 'list' }, 'list_phone_contacts', { shopSession }],
  ['phone_action', { shopSession, action: 'dial', number: 8376 }, 'dial_phone', { shopSession, phoneNumber: 8376 }],
  ['phone_action', { shopSession, action: 'hang_up' }, 'hang_up_phone', { shopSession }],
  ['wild_network_action', { shopSession, action: 'list' }, 'list_wild_upgrades', { shopSession }],
  ['wild_network_action', { shopSession, action: 'buy', upgradeId: 'example', expectedPrice: 100 }, 'buy_wild_upgrade', { shopSession, upgradeId: 'example', expectedPrice: 100 }],
  ['wild_network_action', { shopSession, action: 'close' }, 'close_wild_network', { shopSession }],
  ['return_to_main_menu', { shopSession }, 'return_to_menu'],
  ['buy_property', { shopSession, expectedPrice: 1000 }, 'buy_property'],
  ['load_save_slot', { slot: 8 }, 'load_slot'],
  ['quit_game', { shopSession }, 'quit_game'],
  ['select_outing_backpack', { shopSession, inventorySnapshot, itemId: 1 }, 'select_outing_backpack'],
  ['afterhours_action', { shopSession, action: 'visit_commissary' }, 'visit_commissary', { shopSession }],
  ['afterhours_action', { shopSession, action: 'return_to_shop', leaveGroundCount: 2 }, 'return_to_shop', { shopSession, leaveGroundCount: 2 }],
  ['fish_tank_action', { shopSession, inventorySnapshot, itemId: 1, action: 'open' }, 'open_fish_tank', { shopSession, inventorySnapshot, itemId: 1 }],
  ['set_game_status', { shopSession, text: '  Checking the tanks.  ' }, 'set_game_status', { shopSession, statusText: 'Checking the tanks.', statusSeconds: 25 }],
  ['report_current_customer', customer, 'report_customer'],
  ['report_current_customer', { ...customer, reason: 'stolen_goods' }, 'report_customer', { ...customer, reportReason: 'stolen_goods' }],
  ['shotgun_action', { ...customer, action: 'equip' }, 'equip_shotgun', customer],
  ['shotgun_action', { ...customer, action: 'fire' }, 'fire_shotgun', customer],
  ['shotgun_action', { shopSession, action: 'holster' }, 'holster_shotgun', { shopSession }],
];

describe('game tools', () => {
  for (const [name, args, command, payload = args] of cases) {
    it(`maps ${name} ${JSON.stringify(args)} to ${command}`, () => {
      assert.deepEqual(plan(name, args), { command, payload });
    });
  }

  it('covers every tool in the mapping table', () => {
    const tested = new Set(cases.map(([name]) => name));
    assert.deepEqual(gameTools.map(({ name }) => name).filter(name => !tested.has(name)), []);
  });

  it('has unique tool names', () => {
    const names = gameTools.map(({ name }) => name);
    assert.equal(new Set(names).size, names.length);
  });

  it('refuses inconsistent arguments before reaching the game', () => {
    const refusals: [string, Record<string, unknown>][] = [
      ['shotgun_action', { shopSession, action: 'fire' }],
      ['afterhours_action', { shopSession, action: 'search_dumping_ground', leaveGroundCount: 2 }],
      ['dialogue_action', { shopSession, dialogueToken, action: 'choose' }],
      ['dialogue_action', { shopSession, dialogueToken, action: 'advance', choiceId: 1 }],
      ['phone_action', { shopSession, action: 'dial' }],
      ['phone_action', { shopSession, action: 'list', number: 1 }],
      ['wild_network_action', { shopSession, action: 'buy', upgradeId: 'example' }],
      ['wild_network_action', { shopSession, action: 'list', expectedPrice: 5 }],
      ['use_item_on_item', { shopSession, inventorySnapshot, itemId: 4, targetItemId: 4 }],
    ];
    for (const [name, args] of refusals) {
      const result = plan(name, args);
      assert.ok('error' in result, `${name} ${JSON.stringify(args)} should be refused`);
    }
  });

  it('rejects malformed tokens, IDs and prices', () => {
    assert.throws(() => tool('call_next_customer').plan({ shopSession: 'not-a-token' }));
    assert.throws(() => tool('move_item').plan({ shopSession, inventorySnapshot, itemId: 0, destinationId: 1 }));
    assert.throws(() => tool('pay_rent').plan({ shopSession, dialogueToken, expectedPrice: -1 }));
    assert.throws(() => tool('load_save_slot').plan({ slot: 1.5 }));
  });

  it('only sends commands the C# bridge handles', async () => {
    const directory = new URL('../game-bridge/', import.meta.url);
    const sources = await Promise.all((await readdir(directory))
      .filter(file => file.endsWith('.cs'))
      .map(file => readFile(new URL(file, directory), 'utf8')));
    const csharp = sources.join('\n');

    for (const [name, , command] of cases) {
      assert.ok(csharp.includes(`"${command}"`), `${name} sends ${command}, which the bridge does not handle`);
    }
  });

  it('marks read-only and destructive tools for clients', () => {
    assert.equal(tool('get_live_shop').annotations.readOnlyHint, true);
    assert.equal(tool('list_live_inventory').annotations.readOnlyHint, true);
    for (const name of ['quit_game', 'dismiss_current_customer', 'shotgun_action', 'report_current_customer', 'use_item_on_item']) {
      assert.equal(tool(name).annotations.destructiveHint, true, name);
    }
  });
});
