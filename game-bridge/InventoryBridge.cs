using System;
using System.Collections.Generic;

namespace ProbablyStolenMcpBridge
{
    internal sealed class InventoryBridge
    {
        private const int MaxListedContainers = 150;
        private InventorySnapshot snapshot;

        internal void Invalidate()
        {
            snapshot = null;
        }

        internal void List(BridgeRequest request, BridgeReply reply)
        {
            var inventory = Capture();
            snapshot = inventory;
            if (inventory.Grids.Count == 0)
            {
                reply.message = "No supported inventories are available in the current location.";
                return;
            }

            int limit = Math.Max(1, Math.Min(request.limit, 100));
            int offset = Math.Max(0, request.offset);
            var rows = new List<InventoryItem>();
            var containers = new List<InventoryContainer>();
            var includedContainers = new HashSet<int>();
            int matches = 0;
            foreach (var entry in inventory.Items)
            {
                if (!Matches(entry.Name, request.query) && !Matches(entry.Item.identifier, request.query) &&
                    !Matches(entry.Container.Name, request.query)) continue;
                if (matches++ < offset || rows.Count >= limit) continue;
                rows.Add(new InventoryItem
                {
                    itemId = entry.Id,
                    containerId = entry.Container.Id,
                    name = entry.Name,
                    identifier = entry.Item.identifier,
                    quantity = entry.Quantity,
                    canMove = CanMoveItem(entry.Item),
                    canBeOutingBackpack = reply.outingLocation.Length == 0 && entry.Item.IsTag("BACKPACK_TAG") && CanMoveItem(entry.Item)
                });
                IncludeContainer(entry.Container, includedContainers, containers);
            }

            foreach (var grid in inventory.Grids)
                if (grid.IsRoot || Matches(grid.Name, request.query)) IncludeContainer(grid, includedContainers, containers);
            foreach (var grid in inventory.Grids)
                IncludeContainer(grid, includedContainers, containers);

            reply.ok = true;
            reply.inventorySnapshot = inventory.Token;
            reply.inventoryContainers = containers.ToArray();
            reply.inventoryItems = rows.ToArray();
            reply.matchingItems = matches;
            reply.hasMoreItems = offset + rows.Count < matches;
            reply.hasMoreContainers = containers.Count < inventory.Grids.Count;
        }

        internal void Move(BridgeRequest request, BridgeReply reply, PlayerStore store)
        {
            if (snapshot == null || request.inventorySnapshot != snapshot.Token)
            {
                reply.message = "Read the live inventory again before moving an item.";
                return;
            }

            if ((ModHelper.IsOutsideStore() && ModHelper.GetCurrentAfterhourLocationId() != AfterhoursBridge.DumpingGround) ||
                store.lockAllFlag > 0 || store.lockAllInventoryFlag > 0 ||
                (ItemMouseDragHandler.current != null && ItemMouseDragHandler.current.IsDraggingItem))
            {
                reply.message = "The game is not ready for inventory moves at the current location or during this interaction.";
                return;
            }

            var source = snapshot.Items.Find(entry => entry.Id == request.itemId);
            var target = snapshot.Grids.Find(grid => grid.Id == request.destinationId);
            if (source == null || target == null || ReferenceEquals(source.Container.Grid, target.Grid))
            {
                reply.message = "Choose an item and a different destination from the live inventory.";
                return;
            }

            var live = Capture();
            var item = source.Item;
            if (!live.Items.Exists(candidate => ReferenceEquals(candidate.Item, item) &&
                    ReferenceEquals(candidate.Container.Grid, source.Container.Grid)) ||
                !live.Grids.Exists(candidate => ReferenceEquals(candidate.Grid, target.Grid)) ||
                item.unitCount != source.Quantity)
            {
                Invalidate();
                reply.message = "The item or its destination changed. Read the live inventory again.";
                return;
            }

            int requested = request.quantity == 0 ? source.Quantity : request.quantity;
            reply.requestedQuantity = requested;
            if (requested < 1 || requested > source.Quantity ||
                !CanMoveItem(item) || target.Grid.IsInsertLocked() ||
                !ReferenceEquals(item.parentInventory, source.Container.Grid) ||
                ContainsGrid(item, target.Grid))
            {
                reply.message = "The game does not allow that item, quantity, or destination.";
                return;
            }

            // The game's quick transfer finds a slot and uses TryAcceptOnce to move or stack the item.
            var slot = target.Grid.TryFindOneValidInventorySlot(item);
            var slotInventory = slot == null ? null : (slot.targetItem == null ? slot.inventory : slot.targetItem.parentInventory);
            if (!ReferenceEquals(slotInventory, target.Grid) || slot.numTransfer < requested || item.MaxNumRemove() < requested)
            {
                reply.message = "The requested quantity will not fit in a legal slot. Try a smaller quantity or a different container.";
                return;
            }

            Invalidate();
            reply.itemName = source.Name;
            reply.destinationName = target.Name;
            reply.movedQuantity = slot.TryAcceptOnce(requested);
            reply.ok = reply.movedQuantity == requested;
            reply.message = reply.ok ? "The game moved the requested quantity." :
                "The game did not move the full quantity. Read the live inventory before retrying.";
        }

        /// <summary>
        /// Uses one owned item on another, the way the game does when the player drops an item onto
        /// another item: pouring a water jug into the RAS water tank, cutting a fish with a blade,
        /// fitting scrap metal to a machine, and so on. Mirrors ItemMouseDragHandler.EndDrag.
        /// </summary>
        internal void UseOn(BridgeRequest request, BridgeReply reply, PlayerStore store)
        {
            if (snapshot == null || request.inventorySnapshot != snapshot.Token)
            {
                reply.message = "Read the live inventory again before using an item.";
                return;
            }

            if ((ModHelper.IsOutsideStore() && ModHelper.GetCurrentAfterhourLocationId() != AfterhoursBridge.DumpingGround) ||
                store.lockAllFlag > 0 || store.lockAllInventoryFlag > 0 ||
                (ItemMouseDragHandler.current != null && ItemMouseDragHandler.current.IsDraggingItem))
            {
                reply.message = "The game is not ready for item use at the current location or during this interaction.";
                return;
            }

            var source = snapshot.Items.Find(entry => entry.Id == request.itemId);
            var target = snapshot.Items.Find(entry => entry.Id == request.targetItemId);
            if (source == null || target == null || ReferenceEquals(source.Item, target.Item))
            {
                reply.message = "Choose two different items from the live inventory.";
                return;
            }

            var live = Capture();
            if (!IsStillPresent(live, source) || !IsStillPresent(live, target))
            {
                Invalidate();
                reply.message = "One of the items changed. Read the live inventory again.";
                return;
            }

            var tool = source.Item;
            var subject = target.Item;
            reply.itemName = source.Name;
            reply.destinationName = target.Name;
            if (!tool.MayTarget(subject) || !tool.CanTarget(subject))
            {
                reply.message = "The game does not allow using " + source.Name + " on " + target.Name + " right now.";
                return;
            }

            Invalidate();
            // Same order as a drop: item behaviours first, then the item's own target handler if it still applies.
            var behaviours = ItemBehaviourManager.current;
            if (behaviours != null) behaviours.Target(tool, subject);
            if (tool.MayTarget(subject) && tool.CanTarget(subject)) tool.Target(subject);
            reply.ok = true;
            reply.message = "Used " + source.Name + " on " + target.Name + ". Read the live inventory or tank to check the result.";
        }

        /// <summary>
        /// Scratches every panel of an owned Scratcher Ticket the way the scratch window does
        /// (ScratcherUIManager.OpenUI, then OnScratchComplete for each slot), and optionally cashes a
        /// winning ticket in the way using a fully scratched ticket does.
        /// </summary>
        internal void Scratch(BridgeRequest request, BridgeReply reply, PlayerStore store)
        {
            if (snapshot == null || request.inventorySnapshot != snapshot.Token)
            {
                reply.message = "Read the live inventory again before scratching a ticket.";
                return;
            }

            if ((ModHelper.IsOutsideStore() && ModHelper.GetCurrentAfterhourLocationId() != AfterhoursBridge.DumpingGround) ||
                store.lockAllFlag > 0 || store.lockAllInventoryFlag > 0 ||
                (ItemMouseDragHandler.current != null && ItemMouseDragHandler.current.IsDraggingItem))
            {
                reply.message = "The game is not ready to scratch a ticket at the current location or during this interaction.";
                return;
            }

            var entry = snapshot.Items.Find(candidate => candidate.Id == request.itemId);
            if (entry == null)
            {
                reply.message = "Choose a Scratcher Ticket from the live inventory.";
                return;
            }

            var live = Capture();
            if (!IsStillPresent(live, entry))
            {
                Invalidate();
                reply.message = "The ticket changed. Read the live inventory again.";
                return;
            }

            var ticket = entry.Item;
            reply.itemName = entry.Name;
            if (!ticket.IsTag("SCRATCHER_TAG") || ticket.unitCount != 1)
            {
                reply.message = entry.Name + " is not a single Scratcher Ticket.";
                return;
            }

            Invalidate();
            if (!ScratcherHelper.IsFullyScratched(ticket))
            {
                // Opening the ticket rerolls an unscratched ticket for the player's current luck.
                ScratcherHelper.TryRerollForBetterLuck(ticket);
                for (int slot = 1; slot <= 3; slot++)
                {
                    if (ticket.GetTagReadonly("SCRATCHER_STATE" + slot).GetInt() != 1)
                        ScratcherHelper.MarkSymbolScratched(ticket, slot);
                }
            }

            var window = ScratcherUIManager.Instance;
            bool windowShowsTicket = window != null && ReferenceEquals(window.currentActiveScratcherItem, ticket) &&
                window.ui != null && window.ui.activeSelf;
            if (windowShowsTicket && window.scratchInputs != null)
            {
                foreach (var panel in window.scratchInputs)
                    if (panel != null) panel.RevealAll();
            }

            if (!ScratcherHelper.CanRedeemPrize(ticket))
            {
                reply.ok = true;
                reply.message = "Scratched " + entry.Name + ". No prize.";
                return;
            }

            int prize = (int)ticket.unitValue;
            if (!request.redeem)
            {
                reply.ok = true;
                reply.message = "Scratched " + entry.Name + ". It won " + prize + " credits; it has not been cashed in yet.";
                return;
            }

            if (windowShowsTicket) window.CloseUI();
            if (!ScratcherHelper.TryRedeemPrize(ticket))
            {
                reply.ok = true;
                reply.message = "Scratched " + entry.Name + ". It won " + prize + " credits, but the game did not cash it in.";
                return;
            }

            reply.ok = true;
            reply.message = "Scratched " + entry.Name + " and cashed in " + prize + " credits.";
        }

        private static bool IsStillPresent(InventorySnapshot live, ItemEntry entry)
        {
            return live.Items.Exists(candidate => ReferenceEquals(candidate.Item, entry.Item) &&
                ReferenceEquals(candidate.Container.Grid, entry.Container.Grid));
        }

        internal void SelectBackpack(BridgeRequest request, BridgeReply reply, PlayerStore store)
        {
            if (snapshot == null || snapshot.Token != request.inventorySnapshot || ModHelper.IsOutsideStore() || store.storeState.ToString() != "CLOSED")
            { reply.message = "Read the inventory while the shop is closed before choosing a backpack."; return; }
            var source = snapshot.Items.Find(entry => entry.Id == request.itemId);
            var live = Capture();
            if (source == null || !live.Items.Exists(entry => ReferenceEquals(entry.Item, source.Item) && ReferenceEquals(entry.Container.Grid, source.Container.Grid)) ||
                !source.Item.IsTag("BACKPACK_TAG") || !CanMoveItem(source.Item))
            { reply.message = "That item is no longer available as a backpack."; Invalidate(); return; }
            EmporiumEntry.Instance.selectedBackpack = source.Item;
            reply.ok = true; reply.itemName = source.Name; reply.message = "Selected backpack for the next outing.";
            Invalidate();
        }

        internal void FishTankAction(BridgeRequest request, BridgeReply reply, PlayerStore store)
        {
            if (snapshot == null || snapshot.Token != request.inventorySnapshot || reply.outingLocation.Length != 0)
            { reply.message = "Read the live shop inventory before choosing a fish tank."; return; }
            var source = snapshot.Items.Find(entry => entry.Id == request.itemId);
            if (source == null || !source.Item.IsTag("RAS_TAG") ||
                !Capture().Items.Exists(entry => ReferenceEquals(entry.Item, source.Item) && ReferenceEquals(entry.Container.Grid, source.Container.Grid)))
            { reply.message = "Choose an owned Recirculating Aquaculture System from the latest inventory."; return; }

            var machine = source.Item;
            var window = machine.contentWindow;
            if (window == null)
            { reply.message = "This aquaculture system has no tank window available."; return; }
            if (request.command != "inspect_fish_tank")
            {
                if (store.lockAllFlag > 0 || store.lockAllInventoryFlag > 0 ||
                    (ItemMouseDragHandler.current != null && ItemMouseDragHandler.current.IsDraggingItem))
                { reply.message = "Finish the current interaction before opening or closing the tank."; return; }
                if (request.command == "open_fish_tank")
                {
                    if (window.IsVisible()) window.ToFront(false);
                    else
                    {
                        window.SetTitle(source.Name);
                        window.Show();
                        machine.RestoreContentWindowPosition();
                    }
                }
                else if (window.IsVisible()) machine.CloseContentWindow(false);
            }

            var tank = MachineRAS.GetTankGrid(machine);
            var waterSlot = MachineRAS.GetWaterSlot(machine);
            var water = waterSlot == null ? null : waterSlot.childItem;
            var tankGrid = snapshot.Grids.Find(grid => ReferenceEquals(grid.Grid, tank));
            var waterGrid = snapshot.Grids.Find(grid => ReferenceEquals(grid.Grid, waterSlot));
            var dispenser = MachineRAS.GetDispenserSlot(machine);
            var dispenserGrid = snapshot.Grids.Find(grid => ReferenceEquals(grid.Grid, dispenser));
            reply.itemName = source.Name;
            reply.tankWindowOpen = window.IsVisible();
            reply.tankContainerId = tankGrid == null ? 0 : tankGrid.Id;
            reply.waterSlotContainerId = waterGrid == null ? 0 : waterGrid.Id;
            reply.dispenserContainerId = dispenserGrid == null ? 0 : dispenserGrid.Id;
            reply.inventorySnapshot = snapshot.Token;
            reply.tankHasWaterContainer = water != null;
            reply.tankWaterMl = AquacultureHelper.GetWaterMl(water);
            reply.tankRequiredWaterMl = tank == null ? 0 : AquacultureHelper.GetTotalWaterNeedMl(tank);
            reply.tankWastePercent = water == null ? 0 : AquacultureHelper.GetWastePercent(water);
            reply.tankHasLiveStock = MachineRAS.HasLiveStock(machine);
            reply.tankHasPower = MachineHelper.CanPower(machine);
            reply.ok = request.command == "inspect_fish_tank" ||
                reply.tankWindowOpen == (request.command == "open_fish_tank");
            reply.message = reply.ok ? (reply.tankWindowOpen ? "The tank window is open." : "The tank window is closed.") :
                "The game did not change the tank window as requested.";
        }

        private static InventorySnapshot Capture()
        {
            var inventory = new InventorySnapshot();
            var entry = EmporiumEntry.Instance;
            if (entry == null) return inventory;

            if (ModHelper.IsOutsideStore())
            {
                if (ModHelper.GetCurrentAfterhourLocationId() == AfterhoursBridge.DumpingGround)
                    AddRoot(inventory, entry.afterhourWindow, "After-hours", entry);
                return inventory;
            }

            AddRoot(inventory, entry.invWindow, "Shop inventory");
            AddRoot(inventory, entry.frontInvWindow, "Front counter");
            AddRoot(inventory, entry.backInvWindow, "Back counter");
            AddRoot(inventory, entry.showcaseWindow, "Display case");
            return inventory;
        }

        private static void AddRoot(InventorySnapshot snapshot, GraphNodeStorage root, string label, EmporiumEntry outing = null)
        {
            if (root == null) return;
            foreach (var grid in GraphUtils.FindChildrenType<GameInventory>(root, candidate => true, candidate => true))
            {
                if (!snapshot.Seen.Add(grid)) continue;
                var owner = grid.GetParentItem();
                if (owner != null && (!GeneralHelper.IsItemOwned(owner) || GeneralHelper.IsInsideNonOwnedContainer(owner))) continue;
                string gridName = string.IsNullOrEmpty(grid.identifier) ? "" : " [" + grid.identifier + "]";
                string name = owner == null ? label + gridName : label + " / " + owner.GetDisplayName(true) + gridName;
                if (outing != null)
                {
                    if (ReferenceEquals(grid, outing.afterhourInventory)) name = label + " / Ground";
                    else if (ReferenceEquals(grid, outing.afterhourPocketSlotInvLeft)) name = label + " / Left pocket";
                    else if (ReferenceEquals(grid, outing.afterhourPocketSlotInvRight)) name = label + " / Right pocket";
                    else if (ReferenceEquals(grid, outing.afterhourPocketSlotInvBackpack)) name = label + " / Backpack slot";
                }
                var container = new GridEntry(snapshot.Grids.Count + 1, name, grid, owner == null);
                snapshot.Grids.Add(container);
                foreach (var item in grid.childItems)
                {
                    if (item == null || item.unitCount <= 0 || !GeneralHelper.IsItemOwned(item) ||
                        GeneralHelper.IsInsideNonOwnedContainer(item)) continue;
                    snapshot.Items.Add(new ItemEntry(snapshot.Items.Count + 1, container, item));
                }
            }
        }

        private static bool CanMoveItem(GameItem item)
        {
            return item.MayRemove() && !GeneralHelper.IsItemLocked(item);
        }

        private static void IncludeContainer(GridEntry entry, HashSet<int> seen, List<InventoryContainer> containers)
        {
            if (containers.Count >= MaxListedContainers || !seen.Add(entry.Id)) return;
            containers.Add(new InventoryContainer { containerId = entry.Id, name = entry.Name, acceptsItems = !entry.Grid.IsInsertLocked() });
        }

        private static bool ContainsGrid(GameItem item, GameInventory target)
        {
            var owner = target.GetParentItem();
            var ancestors = new HashSet<GameItem>();
            while (owner != null)
            {
                if (ReferenceEquals(owner, item) || !ancestors.Add(owner)) return true;
                var parent = owner.parentInventory;
                owner = parent == null ? null : parent.GetParentItem();
            }
            return false;
        }

        private static bool Matches(string value, string query)
        {
            return string.IsNullOrEmpty(query) || (value != null && value.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0);
        }

        private sealed class InventorySnapshot
        {
            internal readonly string Token = Guid.NewGuid().ToString("N");
            internal readonly List<GridEntry> Grids = new List<GridEntry>();
            internal readonly List<ItemEntry> Items = new List<ItemEntry>();
            internal readonly HashSet<GameInventory> Seen = new HashSet<GameInventory>();
        }

        private sealed class GridEntry
        {
            internal readonly int Id;
            internal readonly string Name;
            internal readonly GameInventory Grid;
            internal readonly bool IsRoot;

            internal GridEntry(int id, string name, GameInventory grid, bool isRoot)
            {
                Id = id;
                Name = name;
                Grid = grid;
                IsRoot = isRoot;
            }
        }

        private sealed class ItemEntry
        {
            internal readonly int Id;
            internal readonly string Name;
            internal readonly int Quantity;
            internal readonly GridEntry Container;
            internal readonly GameItem Item;

            internal ItemEntry(int id, GridEntry container, GameItem item)
            {
                Id = id;
                Container = container;
                Item = item;
                Name = item.GetDisplayName(true);
                Quantity = item.unitCount;
            }
        }
    }

    [Serializable]
    internal sealed class InventoryContainer
    {
        public int containerId;
        public string name;
        public bool acceptsItems;
    }

    [Serializable]
    internal sealed class InventoryItem
    {
        public int itemId;
        public int containerId;
        public string name;
        public string identifier;
        public int quantity;
        public bool canMove;
        public bool canBeOutingBackpack;
    }
}
