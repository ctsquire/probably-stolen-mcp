# Probably Stolen MCP

A local companion for [Probably Stolen – Cyberpunk Shopkeeper Sim](https://store.steampowered.com/app/4348910/). It works with MCP clients that launch local servers over standard input and output. Reference tools work while the game is closed. Live tools communicate with an installed mod through the game's `ModData` folder and use the game's own methods.

| Tool | What it does |
| --- | --- |
| `search_wiki` | Finds items, characters, mechanics, and guides on the [Probably Stolen Wiki](https://probablystolen.wiki.gg/). |
| `get_wiki_page` | Returns item facts, section links, excerpts, and sample table rows. Pass `section` to focus on a heading such as `Obtaining`. |
| `get_install_info` | Checks the Windows install directory and whether its achievement definitions are available. |
| `list_achievements` | Reads achievement definitions from the local install. Set `includeHidden` to `true` to allow hidden entries. |
| `get_live_shop` | Reads day, credits, customer, available actions, and after-hours status, including departure blockers and search risks. |
| `call_next_customer` | Calls a customer when the game allows it. Requires the active shop token from `get_live_shop`. |
| `dismiss_current_customer` | Dismisses the customer at the counter. Requires the shop and customer tokens from `get_live_shop`. |
| `report_current_customer` | Uses the counter alarm on the current customer. An optional reason checks for stolen goods or serious contraband first. |
| `shotgun_action` | Equips, fires, or holsters the shop shotgun. Equipping and firing require the current customer token. |
| `list_live_inventory` | Lists owned shop items and containers, or ground loot, pockets, and backpack storage at the Dumping Ground. |
| `move_item` | Moves a whole item stack or a specified quantity to a different listed container when a legal slot is available. |
| `shop_day_action` | Closes the morning report, opens or closes the shop, or sleeps and saves. |
| `complete_trade` | Completes the currently negotiated purchase or sale, guarded by customer token and expected price. |
| `select_customer_offer` | Moves a seller’s offered item to the scale or selects an item already on the scale. |
| `dialogue_action` | Advances the current line or selects a displayed response. |
| `pay_rent` | Selects the Landlord’s pay-rent response at the quoted amount. |
| `buy_property` | Selects the Landlord’s buyout response at the quoted price. |
| `phone_action` | Lists in-game contacts, dials a contact, or hangs up. |
| `wild_network_action` | Lists available upgrades, buys at the quoted price, or closes Wild’s Network. |
| `select_outing_backpack` | Selects an owned backpack to equip on departure. |
| `afterhours_action` | Visits the Dumping Ground, the Commissary, or Dr. Jackson. It also searches once at the Dumping Ground or returns to the shop. |
| `fish_tank_action` | Inspects, opens, or closes an owned aquaculture system and reports water, power, live stock, and storage slot IDs. |
| `set_game_status` | Shows a short progress message at the top center of the screen. It clears automatically or when passed empty text. |
| `load_save_slot` | Loads an existing slot from the main menu. |
| `return_to_main_menu` | Returns from the game's ending screen to the main menu. |
| `quit_game` | Exits the loaded game on explicit request. Changes since the last save are discarded. |

Wiki tools need internet access and may describe a different game build. Local tools use the directory you configure. Achievement results describe unlock requirements and contain no player progress.

Use the included version 11 bridge for the current tool set. `get_live_shop` reports the running version. Replace the installed bridge DLL and restart the game after upgrading.

## Enable live controls

1. Put `manifest.xml` and `ProbablyStolenMcpBridge.dll` from `game-bridge` into `Mods\ProbablyStolenMcpBridge` under the game install. The included DLL was tested with the Windows build that reports version `0.46D`. Rebuild against your local game assemblies if the APIs differ.
2. In the game, open **Mods** and enable **Probably Stolen MCP Bridge**, then restart the game. This uses the normal [mod activation flow](https://github.com/dragonpan2/probably-stolen-modding#run-the-game-and-activate-the-mod).
3. Load a shop and start a new Codex chat so it picks up the new MCP tools. Ask it to read the live shop. To try an action, ask it to call the next customer when the counter is ready.

You can turn off live controls from the game's **Mods** menu. The bridge operates inside the game and uses its own mod data folder for short-lived requests and replies.

To try an item transfer, ask Codex to list your live inventory. Then name an item and where it should go, such as “Move one water filter to the front counter.” The game picks a legal slot in the destination. The tool returns the number of units it moved. Read the inventory again before each move because item and container IDs belong to the latest inventory snapshot.

## Scavenge after closing

1. Close the shop and check `canVisitDumpingGround` in `get_live_shop`. Pick an item marked `canBeOutingBackpack` with `select_outing_backpack` if you want more carrying space.
2. Call `afterhours_action` with `visit_dumping_ground`. Read the live shop until `outingLocation` is `dumping_ground` and the transition has finished.
3. Check `canSearchDumpingGround`, `searchesLeft`, and the wound chances. Use `search_dumping_ground` for each search. List the inventory and move useful finds from **After-hours / Ground** to a pocket or your backpack’s storage.
4. Use `return_to_shop` and confirm arrival in `get_live_shop`. If you choose to leave items behind, pass the current `groundStacks` count as `leaveGroundCount`.

For other outings, check `canVisitCommissary` or `canVisitDoctor`. The matching blocker fields explain when a route is unavailable. The game decides when each location is discovered and open.

## Inspect a fish tank

List `ras` in the live inventory and use the selected Recirculating Aquaculture System's item ID and snapshot with `fish_tank_action`. The `inspect` action reads tank status. The `open` and `close` actions update the actual window and report its visibility. One inventory snapshot can identify several tanks until another inventory listing or item move replaces it.

## Use the alarm or shotgun

Check `canReportCustomer` in `get_live_shop` before using the alarm. Omit the reason to let the game evaluate the report. Pass `stolen_goods` to require `offerStolenItem` or `contraband` to require `offerSeriousContrabandItem` on the counter. The game handles the customer's response, the reward, and any false-report fine.

For a suspected Aug, equip the unlocked shotgun with `shotgun_action` and the current customer token. Wait until `canFireShotgun` is true, then use the same token to fire. The game resolves the shot and its consequences. Use `holster` to put the shotgun away.

## Handle visitors and rent day

Read `dialogueChannel`, `dialogueLine`, and `dialogueChoices` in `get_live_shop`. Use `dialogue_action` with the current `dialogueToken` to advance a counter or phone line or choose a displayed response. If a seller has several items, use the current offer token and item ID to select one on the scale, then read its negotiated price before buying.

`rentAmount`, `daysUntilRent`, and mortgage status come from the loaded save. On a rent visit, advance the Landlord’s dialogue until `canPayRentNow` or `canBuyProperty` is true. Send the exact amount shown in `get_live_shop`. For a Loan Shark visit, use the responses the game displays. A buyout is complete when the game sets `propertyPaid`.

Use `phone_action` to list answering contacts and dial a number. After calling Joe Wild’s assistant on `8376`, choose the response for browsing services. Once the Network is open, `wild_network_action` returns its upgrade list and prices. Purchases spend Wild’s favor first and pay any remainder in credits.

## Connect to Codex

Install Node.js 22 or newer and run these commands in PowerShell from the cloned repository. Provide the folder containing `Probably Stolen.exe`, then start a new Codex session after registration. [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

```powershell
npm ci
$gameDir = (Resolve-Path -LiteralPath (Read-Host 'Probably Stolen install directory')).Path
$serverPath = (Resolve-Path -LiteralPath 'server.mjs').Path
$nodePath = (Get-Command node.exe).Source
codex mcp add probably-stolen --env "PROBABLY_STOLEN_GAME_DIR=$gameDir" -- $nodePath $serverPath
```

Try asking “Use the Probably Stolen MCP to find where I can buy a Water Purifier” or “Show me the achievements in my install.”

## Use another client or move the server

On a fresh copy, install Node.js 22 or newer and run `npm ci` from the project folder. Configure your client to launch `node` with the absolute path to `server.mjs` as its sole argument. Set `PROBABLY_STOLEN_GAME_DIR` in the server environment to the folder containing `Probably Stolen.exe`. Leave it unset for wiki access alone.

## Build and test

Run `npm test` to verify the MCP tool schemas, request mapping, and cleanup without running Probably Stolen. Rebuild the game mod on Windows from your installed game assemblies. Run the following from the repository root with `$gameDir` set as above.

```powershell
.\game-bridge\build.ps1 -GameDirectory $gameDir
```
