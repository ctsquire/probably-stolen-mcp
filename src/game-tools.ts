import { z } from 'zod';

const token = z.string().regex(/^[a-f0-9]{32}$/);
const rowId = z.int().min(1).max(100_000);
const price = z.int().min(0);

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
};

/** A bridge command to send, or the reason the arguments were refused before reaching the game. */
export type CommandPlan =
  | { command: string; payload: Record<string, unknown> }
  | { error: string };

export type GameTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
  /** Validates raw tool arguments and maps them to a bridge command. Throws on invalid input. */
  plan: (input: unknown) => CommandPlan;
};

function defineTool<Shape extends z.ZodRawShape>(spec: Omit<GameTool, 'inputSchema' | 'plan'> & {
  inputSchema: Shape;
  plan: (input: z.infer<z.ZodObject<Shape>>) => CommandPlan;
}): GameTool {
  const schema = z.object(spec.inputSchema);
  return { ...spec, plan: input => spec.plan(schema.parse(input)) };
}

/** Drops undefined fields so the request only carries the arguments that were given. */
function compact(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

const send = (command: string, payload: Record<string, unknown> = {}): CommandPlan => ({ command, payload: compact(payload) });

const readOnly: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const action: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const destructive: ToolAnnotations = { ...action, destructiveHint: true };

export const gameTools: GameTool[] = [
  defineTool({
    name: 'get_live_shop',
    title: 'Read the live Probably Stolen shop',
    description: 'Read the running game directly through the in-game bridge. Returns current dialogue, choices, rent and mortgage status, customer offers and trades, security actions, and after-hours status.',
    inputSchema: {},
    annotations: readOnly,
    plan: () => send('status'),
  }),

  defineTool({
    name: 'list_live_inventory',
    title: 'List owned items and containers in the live game',
    description: 'At the shop, read inventory, counters, display case, and owned storage. At the Dumping Ground, read ground loot, pockets, and backpack storage. Search by item name, identifier, or container. Use the returned shopSession, inventorySnapshot, itemId, and destination containerId with move_item.',
    inputSchema: {
      query: z.string().trim().min(1).max(160).optional(),
      limit: z.int().min(1).max(100).default(35),
      offset: z.int().min(0).max(100_000).default(0),
    },
    annotations: readOnly,
    plan: args => send('inventory', args),
  }),

  defineTool({
    name: 'move_item',
    title: 'Move an item between Probably Stolen containers',
    description: 'Transfer an owned item or part of its stack into a different listed container using normal game placement rules. Omit quantity for the whole stack. Use matching IDs from the latest list_live_inventory result. Read the inventory again after every move, including a partial move. Only call this tool when the user requests gameplay.',
    inputSchema: {
      shopSession: token,
      inventorySnapshot: token,
      itemId: rowId,
      destinationId: rowId,
      quantity: z.int().min(1).max(2_147_483_647).optional(),
    },
    annotations: action,
    plan: args => send('move_item', args),
  }),

  defineTool({
    name: 'call_next_customer',
    title: 'Call the next Probably Stolen customer',
    description: 'Call the next customer in the active shop. First use get_live_shop and pass its shopSession only if canCallNext is true. Call only when the user requests gameplay.',
    inputSchema: { shopSession: token },
    annotations: action,
    plan: args => send('call_next', args),
  }),

  defineTool({
    name: 'dismiss_current_customer',
    title: 'Dismiss the current Probably Stolen customer',
    description: 'Dismiss the current customer without calling another. First use get_live_shop and pass its shopSession and customerToken only if canDismiss is true. Call only when the user requests gameplay.',
    inputSchema: { shopSession: token, customerToken: token },
    annotations: destructive,
    plan: args => send('dismiss', args),
  }),

  defineTool({
    name: 'report_current_customer',
    title: 'Use the in-game alarm on the current customer',
    description: 'Press the alarm for a customer when canReportCustomer is true. A report without a reason is evaluated by the game and can result in a fine. Optionally pass stolen_goods or contraband to require matching evidence on the counter before pressing the alarm. Read get_live_shop for offer evidence and both current tokens.',
    inputSchema: { shopSession: token, customerToken: token, reason: z.enum(['stolen_goods', 'contraband']).optional() },
    annotations: destructive,
    plan: ({ reason, ...args }) => send('report_customer', { ...args, reportReason: reason }),
  }),

  defineTool({
    name: 'shotgun_action',
    title: 'Equip, fire, or holster the in-game shop shotgun',
    description: 'Use the shop shotgun for suspected Augs. Read get_live_shop and equip with its current customer token when canEquipShotgun is true. Wait for canFireShotgun and use the same token to fire, or holster. The game determines whether the customer was an Aug and applies the outcome.',
    inputSchema: { shopSession: token, customerToken: token.optional(), action: z.enum(['equip', 'fire', 'holster']) },
    annotations: destructive,
    plan: ({ action: step, customerToken, shopSession }) => {
      if (step !== 'holster' && !customerToken) {
        return { error: 'Equip and fire require the current customer token from get_live_shop.' };
      }
      return send(`${step}_shotgun`, { shopSession, customerToken });
    },
  }),

  defineTool({
    name: 'shop_day_action',
    title: 'Operate the shop day',
    description: 'Close the nightly report, open the shop, close an empty shop, or sleep and save. Read get_live_shop first. Before sleeping, check canSleep, outingsLeft, and canVisitDumpingGround. Sleep advances the game and saves.',
    inputSchema: { shopSession: token, action: z.enum(['close_report', 'open_shop', 'close_shop', 'sleep']) },
    annotations: action,
    plan: ({ action: step, shopSession }) => send(step, { shopSession }),
  }),

  defineTool({
    name: 'select_outing_backpack',
    title: 'Choose a backpack for the next outing',
    description: 'While the shop is closed, select an owned backpack from the latest list_live_inventory result. The item must have canBeOutingBackpack set. The game equips it when you leave.',
    inputSchema: { shopSession: token, inventorySnapshot: token, itemId: rowId },
    annotations: action,
    plan: args => send('select_outing_backpack', args),
  }),

  defineTool({
    name: 'afterhours_action',
    title: 'Travel, scavenge, or return after closing',
    description: 'Read get_live_shop before acting. Visit the Dumping Ground, the Commissary, or Dr. Jackson if the game allows that route. Search at the Dumping Ground or return from an outing. Pack loot with list_live_inventory and move_item first. Pass the exact current groundStacks as leaveGroundCount if deliberately leaving loot behind. Refresh status to verify arrival.',
    inputSchema: {
      shopSession: token,
      action: z.enum(['visit_dumping_ground', 'visit_commissary', 'visit_dr_jackson', 'search_dumping_ground', 'return_to_shop']),
      leaveGroundCount: z.int().min(1).max(100_000).optional(),
    },
    annotations: destructive,
    plan: ({ action: step, leaveGroundCount, shopSession }) => {
      if (leaveGroundCount !== undefined && step !== 'return_to_shop') {
        return { error: 'leaveGroundCount only applies when returning to the shop.' };
      }
      return send(step, { shopSession, leaveGroundCount });
    },
  }),

  defineTool({
    name: 'fish_tank_action',
    title: 'Inspect, open, or close an aquaculture tank',
    description: 'Choose an owned Recirculating Aquaculture System from the latest list_live_inventory. Returns window visibility, live stock, water volume and required amount, waste percentage, power, and container IDs for the fish grid, water slot, and feed dispenser slot.',
    inputSchema: { shopSession: token, inventorySnapshot: token, itemId: rowId, action: z.enum(['inspect', 'open', 'close']) },
    annotations: { ...action, idempotentHint: true },
    plan: ({ action: step, ...args }) => send(`${step}_fish_tank`, args),
  }),

  defineTool({
    name: 'set_game_status',
    title: 'Show a brief MCP status in the game',
    description: 'Display a short player-facing update about the current action, next step, or result in a small in-game box. The box does not intercept clicks and clears after the duration. Pass an empty text to clear immediately.',
    inputSchema: {
      shopSession: token,
      text: z.string().trim().max(180).default(''),
      seconds: z.int().min(5).max(120).default(25),
    },
    annotations: action,
    plan: ({ shopSession, text, seconds }) => send('set_game_status', { shopSession, statusText: text, statusSeconds: seconds }),
  }),

  defineTool({
    name: 'complete_trade',
    title: 'Complete the current negotiated trade',
    description: 'Buy or sell the currently negotiated item using the game rules. First inspect get_live_shop and provide the exact current customer token and price. Refresh after each attempt.',
    inputSchema: { shopSession: token, customerToken: token, direction: z.enum(['buy', 'sell']), expectedPrice: price },
    annotations: action,
    plan: ({ direction, ...args }) => send(direction === 'buy' ? 'buy_negotiated' : 'sell_negotiated', args),
  }),

  defineTool({
    name: 'select_customer_offer',
    title: 'Select a customer’s offered item on the scale',
    description: 'Use the current customerToken, offerToken, and an offerId marked canSelect in get_live_shop. Moves a customer-owned item from their counter to the scale or selects it if already on the scale. Read the resulting negotiation before buying.',
    inputSchema: { shopSession: token, customerToken: token, offerToken: token, offerId: rowId },
    annotations: action,
    plan: args => send('select_customer_offer', args),
  }),

  defineTool({
    name: 'dialogue_action',
    title: 'Advance a line or select a displayed response',
    description: 'Read the current line, speaker, dialogueToken, and dialogueChoices in get_live_shop. Advance one step or select an enabled choice by choiceId. Refresh after every action because the conversation can advance on its own.',
    inputSchema: { shopSession: token, dialogueToken: token, action: z.enum(['advance', 'choose']), choiceId: rowId.optional() },
    annotations: destructive,
    plan: ({ action: step, choiceId, ...args }) => {
      if ((step === 'choose') !== (choiceId !== undefined)) {
        return { error: 'Pass a choiceId only when choosing a displayed response.' };
      }
      return send(`${step}_dialogue`, { ...args, choiceId });
    },
  }),

  defineTool({
    name: 'pay_rent',
    title: 'Pay the Landlord’s quoted rent',
    description: 'Pay rent through the current Landlord conversation. Read get_live_shop for canPayRentNow, rentAmount, and the current dialogueToken. The amount must still match the game’s quote.',
    inputSchema: { shopSession: token, dialogueToken: token, expectedPrice: price },
    annotations: action,
    plan: args => send('pay_rent', args),
  }),

  defineTool({
    name: 'phone_action',
    title: 'Read contacts, dial, or close the in-game phone',
    description: 'List current contacts and whether they answer, dial an in-game number when canDialPhone is true, or hang up. Read the live dialogue after dialing to select the contact’s responses.',
    inputSchema: { shopSession: token, action: z.enum(['list', 'dial', 'hang_up']), number: z.int().min(1).max(99_999_999).optional() },
    annotations: action,
    plan: ({ action: step, number, shopSession }) => {
      if ((step === 'dial') !== (number !== undefined)) return { error: 'Pass a number only when dialing.' };
      const commands = { list: 'list_phone_contacts', dial: 'dial_phone', hang_up: 'hang_up_phone' } as const;
      return send(commands[step], { shopSession, phoneNumber: number });
    },
  }),

  defineTool({
    name: 'wild_network_action',
    title: 'List, buy, or close upgrades in Wild’s Network',
    description: 'Use the Network once Wild opens it during a visit or phone call. List upgrades to see IDs, prices, and availability. Purchase an available upgrade at the exact listed price. Wild’s favor is used before cash.',
    inputSchema: {
      shopSession: token,
      action: z.enum(['list', 'buy', 'close']),
      upgradeId: z.string().trim().min(1).max(160).optional(),
      expectedPrice: price.optional(),
    },
    annotations: action,
    plan: ({ action: step, upgradeId, expectedPrice, shopSession }) => {
      const extras = [upgradeId, expectedPrice].filter(value => value !== undefined).length;
      if (extras !== (step === 'buy' ? 2 : 0)) {
        return { error: 'Pass an upgrade ID and a price only when purchasing a listed upgrade.' };
      }
      const commands = { list: 'list_wild_upgrades', buy: 'buy_wild_upgrade', close: 'close_wild_network' } as const;
      return send(commands[step], { shopSession, upgradeId, expectedPrice });
    },
  }),

  defineTool({
    name: 'buy_property',
    title: 'Buy the shop property outright',
    description: 'Select the Landlord’s displayed buyout response and pay the exact propertyPrice from get_live_shop. Wait for canBuyProperty and verify propertyPaid after the action.',
    inputSchema: { shopSession: token, expectedPrice: price },
    annotations: action,
    plan: args => send('buy_property', args),
  }),

  defineTool({
    name: 'load_save_slot',
    title: 'Load a game save slot',
    description: 'Load an existing save slot from the main menu. Specify a known slot number; the game must be on the main menu and not already in a shop.',
    inputSchema: { slot: z.int().min(0).max(99) },
    annotations: action,
    plan: args => send('load_slot', args),
  }),

  defineTool({
    name: 'return_to_main_menu',
    title: 'Return from the ending screen to the main menu',
    description: 'After a run ends, return to the main menu when canReturnToMenu is true. Wait for get_live_shop to report the shop is unloaded before loading a save.',
    inputSchema: { shopSession: token },
    annotations: action,
    plan: args => send('return_to_menu', args),
  }),

  defineTool({
    name: 'quit_game',
    title: 'Exit Probably Stolen',
    description: 'Exit the running game, discarding changes since the last save. Only use if the user explicitly requests exiting or restarting; pass the current shop session.',
    inputSchema: { shopSession: token },
    annotations: destructive,
    plan: args => send('quit_game', args),
  }),
];
