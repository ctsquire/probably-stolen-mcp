using System;
using UnityEngine;

namespace ProbablyStolenMcpBridge
{
    public sealed class BridgeMod : IMod
    {
        private ModLog log;
        private BridgeRunner runner;

        public void Init(ModManifest manifest)
        {
            log = new ModLog(manifest);
        }

        public void OnEnable()
        {
            if (runner != null) return;
            var host = new GameObject("Probably Stolen MCP Bridge");
            UnityEngine.Object.DontDestroyOnLoad(host);
            runner = host.AddComponent<BridgeRunner>();
            runner.Log = log;
        }

        public void OnDisable()
        {
            if (runner == null) return;
            runner.enabled = false;
            UnityEngine.Object.Destroy(runner.gameObject);
            runner = null;
        }
    }

    public sealed class BridgeRunner : MonoBehaviour
    {
        private const string ModId = "probably_stolen_mcp_bridge";
        private const int ProtocolVersion = 1;
        private const int BridgeVersion = 13;
        private static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        internal ModLog Log;
        private float nextPoll;
        private string shopSession = "";
        private StoreClientInstance previousCustomer;
        private string customerToken = "";
        private readonly InventoryBridge inventory = new InventoryBridge();
        private readonly AfterhoursBridge afterhours = new AfterhoursBridge();
        private readonly StatusOverlay statusOverlay = new StatusOverlay();
        private readonly SecurityBridge security = new SecurityBridge();
        private readonly DialogueBridge dialogue = new DialogueBridge();
        private readonly OfferBridge offers = new OfferBridge();

        private void OnEnable()
        {
            ModHook.OnGameLoadedLate += BeginShopSession;
            ModHelper.WriteModDataFileText(ModId, "bridge-version.txt", BridgeVersion.ToString());
        }

        private void OnDisable()
        {
            ModHook.OnGameLoadedLate -= BeginShopSession;
            statusOverlay.Clear();
        }

        private void BeginShopSession()
        {
            shopSession = Guid.NewGuid().ToString("N");
            previousCustomer = null;
            customerToken = "";
            inventory.Invalidate();
            afterhours.Reset();
            statusOverlay.Clear();
            security.Reset();
            dialogue.Reset();
            offers.Reset();
        }

        private System.Collections.IEnumerator QuitAfterReply()
        {
            yield return new WaitForSecondsRealtime(1f);
            Application.Quit();
        }

        private void Update()
        {
            statusOverlay.Tick();
            if (Time.unscaledTime < nextPoll) return;
            nextPoll = Time.unscaledTime + 0.2f;

            var files = ModHelper.ListModDataFiles(ModId);
            if (files == null) return;
            foreach (var file in files)
            {
                if (!file.StartsWith("request-", StringComparison.Ordinal) ||
                    !file.EndsWith(".json", StringComparison.Ordinal)) continue;
                string id = file.Substring(8, file.Length - 13);
                Guid ignored;
                if (!Guid.TryParseExact(id, "N", out ignored)) continue;
                ProcessRequest(file, id);
                break;
            }
        }

        private void ProcessRequest(string file, string id)
        {
            try
            {
                string content = ModHelper.ReadModDataFileText(ModId, file);
                if (!ModHelper.DeleteModDataFile(ModId, file)) return;
                if (string.IsNullOrEmpty(content) || content.Length > 4096) return;

                var request = JsonUtility.FromJson<BridgeRequest>(content);
                long now = (long)(DateTime.UtcNow - Epoch).TotalMilliseconds;
                if (request == null || request.version != ProtocolVersion || request.id != id ||
                    request.expiresAtMs <= now || request.expiresAtMs > now + 15000) return;

                BridgeReply reply = Execute(request);
                ModHelper.WriteModDataFileText(ModId, "response-" + id + ".json", SerializeReply(reply));
            }
            catch (Exception error)
            {
                if (Log != null) Log.Error(error);
            }
        }

        private static string Quote(string value)
        {
            if (value == null) return "null";
            var b = new System.Text.StringBuilder("\"");
            foreach (char c in value)
            {
                if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
                else if (c < 32) b.Append("\\u").Append(((int)c).ToString("x4"));
                else b.Append(c);
            }
            return b.Append('"').ToString();
        }

        private static string SerializeReply(BridgeReply reply)
        {
            string basic = JsonUtility.ToJson(reply);
            var b = new System.Text.StringBuilder(basic.Substring(0, basic.Length - 1));
            AppendRows(b, basic, "inventoryItems", reply.inventoryItems, (builder, x) => builder
                 .Append("{\"itemId\":").Append(x.itemId).Append(",\"containerId\":").Append(x.containerId)
                 .Append(",\"name\":").Append(Quote(x.name)).Append(",\"identifier\":").Append(Quote(x.identifier))
                 .Append(",\"quantity\":").Append(x.quantity).Append(",\"canMove\":").Append(x.canMove ? "true" : "false")
                 .Append(",\"canBeOutingBackpack\":").Append(x.canBeOutingBackpack ? "true" : "false").Append('}'));
            AppendRows(b, basic, "inventoryContainers", reply.inventoryContainers, (builder, x) => builder
                .Append("{\"containerId\":").Append(x.containerId).Append(",\"name\":").Append(Quote(x.name))
                .Append(",\"acceptsItems\":").Append(x.acceptsItems ? "true" : "false").Append('}'));
            AppendRows(b, basic, "dialogueChoices", reply.dialogueChoices, (builder, x) => builder
                .Append("{\"choiceId\":").Append(x.choiceId).Append(",\"label\":").Append(Quote(x.label))
                .Append(",\"actionName\":").Append(Quote(x.actionName)).Append(",\"enabled\":").Append(x.enabled ? "true" : "false").Append('}'));
            AppendRows(b, basic, "customerOffers", reply.customerOffers, (builder, x) => builder
                .Append("{\"offerId\":").Append(x.offerId).Append(",\"name\":").Append(Quote(x.name))
                .Append(",\"quantity\":").Append(x.quantity).Append(",\"location\":").Append(Quote(x.location))
                .Append(",\"selected\":").Append(x.selected ? "true" : "false")
                .Append(",\"canSelect\":").Append(x.canSelect ? "true" : "false").Append('}'));
            AppendRows(b, basic, "phoneContacts", reply.phoneContacts, (builder, x) => builder
                .Append("{\"number\":").Append(x.number).Append(",\"name\":").Append(Quote(x.name))
                .Append(",\"state\":").Append(Quote(x.state)).Append(",\"willAnswer\":").Append(x.willAnswer ? "true" : "false").Append('}'));
            AppendRows(b, basic, "wildUpgrades", reply.wildUpgrades, (builder, x) => builder
                .Append("{\"upgradeId\":").Append(Quote(x.upgradeId)).Append(",\"name\":").Append(Quote(x.name))
                .Append(",\"description\":").Append(Quote(x.description)).Append(",\"price\":").Append(x.price)
                .Append(",\"unlocked\":").Append(x.unlocked ? "true" : "false")
                .Append(",\"canPurchase\":").Append(x.canPurchase ? "true" : "false").Append('}'));
            return b.Append('}').ToString();
        }

        private static void AppendRows<T>(System.Text.StringBuilder builder, string basic, string field, T[] rows,
            Action<System.Text.StringBuilder, T> appendRow)
        {
            if (rows == null || basic.Contains("\"" + field + "\":")) return;
            builder.Append(",\"").Append(field).Append("\":[");
            for (int i = 0; i < rows.Length; i++)
            {
                if (i > 0) builder.Append(',');
                appendRow(builder, rows[i]);
            }
            builder.Append(']');
        }

        private BridgeReply Execute(BridgeRequest request)
        {
            var menu = MainMenuUIController.Instance;
            bool atMainMenu = menu != null && menu.isActiveAndEnabled;
            PlayerStore store = !atMainMenu && EmporiumEntry.Instance != null && PlayerStore.IsInstanceExist() ? PlayerStore.Instance : null;
            var reply = new BridgeReply { version = ProtocolVersion, id = request.id, bridgeVersion = BridgeVersion };
            if (request.command == "load_slot")
            {
                if (!atMainMenu || request.slot < 0 || request.slot > 99 || SaveUIManager.GetPreview(request.slot) == null)
                { reply.message = "That save slot cannot be loaded from the current game state."; return reply; }
                NewGameData.Instance.saveSlot = request.slot;
                NewGameData.Instance.saveFile = null;
                shopSession = "";
                menu.StartNewGameClick();
                reply.ok = true; reply.message = "Requested loading the save slot.";
                return reply;
            }
            if (store == null || shopSession.Length == 0)
            {
                reply.ok = request.command == "status";
                reply.message = "Load a shop in Probably Stolen before sending game actions.";
                return reply;
            }

            FillShopState(reply, store);
            if (request.command == "status")
            {
                reply.ok = true;
                return reply;
            }
            if (request.command == "inventory")
            {
                if (reply.outingInTransit) { reply.message = "Wait for the outing transition to finish."; return reply; }
                inventory.List(request, reply);
                return reply;
            }

            if (request.shopSession != shopSession)
            {
                reply.message = "The active shop changed. Read the live shop before sending another action.";
                return reply;
            }

            if (reply.outingInTransit && request.command != "quit_game" && request.command != "set_game_status")
            { reply.message = "Wait for the outing transition to finish."; return reply; }

            switch (request.command)
            {
                case "set_game_status":
                    string status = (request.statusText ?? "").Replace('\r', ' ').Replace('\n', ' ').Replace('\t', ' ').Trim();
                    if (status.Length > 180 || request.statusSeconds < 5 || request.statusSeconds > 120)
                    { reply.message = "Enter up to 180 characters and a duration of 5 to 120 seconds."; return reply; }
                    if (!statusOverlay.Show(transform, status, request.statusSeconds))
                    { reply.message = "The game could not display the status box."; return reply; }
                    reply.message = status.Length == 0 ? "Cleared the in-game status box." : "Updated the in-game status box.";
                    break;

                case "quit_game":
                    StartCoroutine(QuitAfterReply());
                    reply.message = "Game exit requested; unsaved changes will be lost.";
                    break;
                case "return_to_menu":
                    if (!reply.canReturnToMenu)
                    { reply.message = "The game is not on its ending screen."; return reply; }
                    GameOverUIManager.Instance.GoToMainMenu();
                    reply.ok = true;
                    reply.message = "Requested returning to the main menu. Check the live shop before loading another save.";
                    return reply;
                case "close_report":
                    if (AdvCalendarUIManager.Instance == null) { reply.message = "Calendar is not available."; return reply; }
                    AdvCalendarUIManager.Instance.CloseUI();
                    reply.message = "Closed the calendar report.";
                    break;

                case "open_shop":
                    if (store.storeState.ToString() != "MORNING" || !store.CanStartDay() || StoreShutterButton.Instance == null || store.lockShutterButtonFlag > 0)
                    { reply.message = "The shop is not ready to open."; return reply; }
                    StoreShutterButton.Instance.OnClick();
                    reply.message = "Requested opening the shop.";
                    break;

                case "close_shop":
                    if (!reply.canCloseShop || StoreShutterButton.Instance == null)
                    { reply.message = "Serve or dismiss all customers before closing the shop."; return reply; }
                    StoreShutterButton.Instance.OnClick();
                    reply.message = "Requested closing the shop.";
                    break;

                case "sleep":
                    if (!reply.canSleep)
                    { reply.message = "The shop is not ready for sleep."; return reply; }
                    var bed = UnityEngine.Object.FindObjectOfType<StoreBedroll>();
                    if (bed == null || EndOfDayUIManager.Instance == null) { reply.message = "Bed or end-of-day interface is unavailable."; return reply; }
                    bed.OnClick();
                    if (!EndOfDayUIManager.Instance.IsOpen) { reply.message = "The end-of-day screen did not open."; return reply; }
                    EndOfDayUIManager.Instance.OnEndDayButtonClick();
                    reply.message = "Requested sleep and the nightly save.";
                    break;

                case "sell_negotiated":
                case "buy_negotiated":
                    if (!reply.hasCustomer || customerToken != request.customerToken || store.currentNegociatedItem == null ||
                        store.currentNegociatedItem.GetNegociatedValue() != request.expectedPrice)
                    { reply.message = "The customer, item, or price changed. Read the live shop again."; return reply; }
                    if (request.command == "sell_negotiated")
                    {
                        if (!reply.canSell) { reply.message = "The game does not allow this sale."; return reply; }
                        store.SellItemFromTable();
                    }
                    else
                    {
                        if (!reply.canBuy) { reply.message = "The game does not allow this purchase."; return reply; }
                        store.BuyItemFromTable();
                    }
                    reply.message = "Requested the transaction; inspect the shop to verify its outcome.";
                    break;

                case "buy_property":
                case "pay_rent":
                case "advance_dialogue":
                case "choose_dialogue":
                    if (!dialogue.Act(request, reply, store)) return reply;
                    break;

                case "select_customer_offer":
                    if (!offers.Select(request, reply, store)) return reply;
                    inventory.Invalidate();
                    break;

                case "list_phone_contacts":
                case "dial_phone":
                case "hang_up_phone":
                case "list_wild_upgrades":
                case "buy_wild_upgrade":
                case "close_wild_network":
                    if (!PhoneBridge.Act(request, reply, store)) return reply;
                    break;

                case "move_item":
                    inventory.Move(request, reply, store);
                    return reply;

                case "use_item_on_item":
                    inventory.UseOn(request, reply, store);
                    if (reply.ok) FillShopState(reply, store);
                    return reply;

                case "scratch_ticket":
                    inventory.Scratch(request, reply, store);
                    if (reply.ok) FillShopState(reply, store);
                    return reply;

                case "select_outing_backpack":
                    inventory.SelectBackpack(request, reply, store);
                    if (reply.ok) FillShopState(reply, store);
                    return reply;

                case "inspect_fish_tank":
                case "open_fish_tank":
                case "close_fish_tank":
                    inventory.FishTankAction(request, reply, store);
                    return reply;

                case "report_customer":
                case "equip_shotgun":
                case "fire_shotgun":
                case "holster_shotgun":
                    if (!security.Act(request, reply, store)) return reply;
                    break;

                case "visit_dumping_ground":
                case "visit_commissary":
                case "visit_dr_jackson":
                case "search_dumping_ground":
                case "return_to_shop":
                    if (!afterhours.Act(request, reply)) return reply;
                    inventory.Invalidate();
                    break;

                case "call_next":
                    if (!reply.canCallNext)
                    {
                        reply.message = "The game is not ready to call another customer.";
                        return reply;
                    }
                    store.TryCallNextClient();
                    reply.message = "Requested the next customer.";
                    break;

                case "dismiss":
                    if (!reply.canDismiss || request.customerToken != customerToken)
                    {
                        reply.message = "That customer is no longer at the counter or cannot be dismissed now.";
                        return reply;
                    }
                    store.TryPlayerDismissCurrentClient(false);
                    reply.message = "Requested dismissal of the current customer.";
                    break;

                default:
                    reply.message = "Unknown game action.";
                    return reply;
            }

            reply.ok = true;
            FillShopState(reply, store);
            return reply;
        }

        private void FillShopState(BridgeReply reply, PlayerStore store)
        {
            bool atOpenShop = store.storeState.ToString() == "OPEN" && !ModHelper.IsOutsideStore();
            bool present = store.IsClientPresent();
            var customer = present ? store.currentClientInstance : null;
            if (!ReferenceEquals(customer, previousCustomer))
            {
                previousCustomer = customer;
                customerToken = customer == null ? "" : Guid.NewGuid().ToString("N");
            }

            var blueprint = customer == null ? null : customer.GetClientBlueprint();
            reply.loaded = true;
            reply.shopSession = shopSession;
            reply.day = StoreStation.Instance == null ? 0 : StoreStation.GetDayCounter();
            reply.credits = store.GetCash();
            reply.shopState = store.storeState.ToString();
            reply.queuedCustomers = store.GetClientInQueueCount();
            reply.hasCustomer = present;
            reply.customerName = blueprint == null ? "" : blueprint.displayName;
            reply.customerIntent = blueprint == null ? "" : store.GetCurrentClientIntent().ToString();
            reply.customerToken = customerToken;
            security.FillStatus(reply, store, blueprint, atOpenShop);
            bool counterReady = atOpenShop && !reply.shotgunEquipped && !reply.shotgunTransitioning && !reply.securityResponding;
            reply.canCallNext = counterReady && !present && store.CanNextClient();
            reply.canDismiss = counterReady && customer != null && store.CanDismissCurrentClient();
            reply.canOpenShop = store.storeState.ToString() == "MORNING" && store.CanStartDay() && store.lockShutterButtonFlag <= 0;
            reply.canCloseShop = counterReady && !present && store.GetClientInQueueCount() == 0 && store.CanEndDay() && store.lockShutterButtonFlag <= 0;
            reply.propertyPaid = store.IsPropertyPaid;
            reply.propertyPrice = store.GetStoreBuyPrice(false);
            var item = customer == null ? null : store.currentNegociatedItem;
            reply.negotiatedItem = item == null ? "" : item.GetDisplayName(true);
            reply.negotiatedPrice = item == null ? 0 : item.GetNegociatedValue();
            reply.canSell = counterReady && item != null && blueprint.IsClientBuying() && store.CanSellItemFromTable(false);
            reply.canBuy = counterReady && item != null && blueprint.IsClientSelling() && store.CanBuyItemFromTable();
            afterhours.FillStatus(reply, store);
            dialogue.FillStatus(reply, store, blueprint);
            offers.FillStatus(reply, store, blueprint, counterReady && !reply.outingInTransit);
            PhoneBridge.FillStatus(reply, store);
            var ending = GameOverUIManager.Instance;
            reply.canReturnToMenu = ending != null && ending.uiPanel != null && ending.uiPanel.activeInHierarchy;
            reply.statusText = statusOverlay.Message;
            reply.statusVisible = statusOverlay.IsVisible;
            reply.canSleep = reply.shopState == "CLOSED" && reply.outingLocation.Length == 0 &&
                !reply.outingInTransit && store.lockAllFlag <= 0 && EndOfDayUIManager.Instance != null;
        }
    }

    [Serializable]
    internal sealed class BridgeRequest
    {
        public int version;
        public string id;
        public long expiresAtMs;
        public string command;
        public string shopSession;
        public string customerToken;
        public string query;
        public int limit;
        public int offset;
        public string inventorySnapshot;
        public int itemId;
        public int destinationId;
        public int targetItemId;
        public bool redeem;
        public int quantity;
        public long expectedPrice;
        public int slot;
        public int leaveGroundCount;
        public string statusText;
        public int statusSeconds;
        public string reportReason;
        public string dialogueToken;
        public int choiceId;
        public string offerToken;
        public int offerId;
        public long phoneNumber;
        public string upgradeId;
    }

    [Serializable]
    internal sealed class BridgeReply
    {
        public int version;
        public int bridgeVersion;
        public string id;
        public bool ok;
        public string message;
        public bool loaded;
        public string shopSession;
        public int day;
        public int credits;
        public string shopState;
        public int queuedCustomers;
        public bool hasCustomer;
        public string customerName;
        public string customerIntent;
        public string customerToken;
        public bool canCallNext;
        public bool canDismiss;
        public string inventorySnapshot;
        public InventoryItem[] inventoryItems;
        public InventoryContainer[] inventoryContainers;
        public int matchingItems;
        public bool hasMoreItems;
        public bool hasMoreContainers;
        public string itemName;
        public string destinationName;
        public int requestedQuantity;
        public int movedQuantity;
        public bool canOpenShop;
        public bool canCloseShop;
        public bool propertyPaid;
        public int propertyPrice;
        public bool canBuyProperty;
        public string negotiatedItem;
        public long negotiatedPrice;
        public bool canSell;
        public bool canBuy;
        public bool canSleep;
        public string outingLocation;
        public string outingBackpack;
        public string outingBlockReason;
        public bool outingInTransit;
        public int outingsLeft;
        public int lastOutingDay;
        public bool canVisitDumpingGround;
        public bool canVisitCommissary;
        public bool canVisitDoctor;
        public string commissaryBlockReason;
        public string doctorBlockReason;
        public bool canSearchDumpingGround;
        public bool canReturnToShop;
        public int searchesLeft;
        public int groundStacks;
        public float minorWoundChancePercent;
        public float majorWoundChancePercent;
        public bool tankWindowOpen;
        public int tankContainerId;
        public int waterSlotContainerId;
        public int dispenserContainerId;
        public bool tankHasWaterContainer;
        public int tankWaterMl;
        public int tankRequiredWaterMl;
        public float tankWastePercent;
        public bool tankHasLiveStock;
        public bool tankHasPower;
        public string statusText;
        public bool statusVisible;
        public bool securityAlarmAvailable;
        public bool securityResponding;
        public bool canReportCustomer;
        public string offerStolenItem;
        public string offerSeriousContrabandItem;
        public bool shotgunUnlocked;
        public bool shotgunEquipped;
        public bool shotgunTransitioning;
        public bool canEquipShotgun;
        public bool canFireShotgun;
        public bool canHolsterShotgun;
        public string dialogueToken;
        public string dialogueSpeaker;
        public string dialogueChannel;
        public string dialogueLine;
        public DialogueChoiceRow[] dialogueChoices;
        public bool canAdvanceDialogue;
        public bool rentIsActive;
        public int daysUntilRent;
        public int rentAmount;
        public bool canPayRentNow;
        public bool mortgageActive;
        public int mortgagePaymentsLeft;
        public int mortgagePayment;
        public string offerToken;
        public CustomerOfferRow[] customerOffers;
        public bool canReturnToMenu;
        public bool phoneOpen;
        public bool phoneInCall;
        public long phoneNumber;
        public bool canDialPhone;
        public PhoneContactRow[] phoneContacts;
        public bool wildNetworkOpen;
        public int wildFavor;
        public WildUpgradeRow[] wildUpgrades;
    }
}
