using UnityEngine;

namespace ProbablyStolenMcpBridge
{
    internal sealed class AfterhoursBridge
    {
        internal const string DumpingGround = "dumping_ground";
        private const string Commissary = "commissary";
        private const string Doctor = "dr_jackson";
        private float transitionUntil;

        internal void Reset()
        {
            transitionUntil = 0;
        }

        internal void FillStatus(BridgeReply reply, PlayerStore store)
        {
            var entry = EmporiumEntry.Instance;
            var map = MapUIManager.Instance;
            reply.outingLocation = ModHelper.GetCurrentAfterhourLocationId();
            reply.outingInTransit = Time.unscaledTime < transitionUntil;
            reply.outingsLeft = store.visitLeftTonight;
            reply.lastOutingDay = store.lastAfterhourOutingDay;
            var backpack = entry == null ? null : entry.selectedBackpack;
            reply.outingBackpack = backpack == null ? "" : backpack.GetDisplayName(true);
            string departureBlocker = GetDepartureBlocker(reply, store, map);
            reply.outingBlockReason = GetRouteBlocker(departureBlocker, DumpingGround, "The Dumping Ground");
            reply.commissaryBlockReason = GetRouteBlocker(departureBlocker, Commissary, "The Commissary");
            reply.doctorBlockReason = GetRouteBlocker(departureBlocker, Doctor, "Dr. Jackson's clinic");
            reply.canVisitDumpingGround = reply.outingBlockReason.Length == 0;
            reply.canVisitCommissary = reply.commissaryBlockReason.Length == 0;
            reply.canVisitDoctor = reply.doctorBlockReason.Length == 0;

            if (map == null || entry == null || entry.afterhourInventory == null || reply.outingLocation.Length == 0) return;
            reply.groundStacks = entry.afterhourInventory.childItems.Count;
            bool ready = !reply.outingInTransit && store.lockAllFlag <= 0 && !IsDragging();
            reply.canReturnToShop = ready;
            if (reply.outingLocation != DumpingGround) return;

            reply.searchesLeft = Mathf.Max(0, ScavHelper.GetScavTimeLeft());
            reply.canSearchDumpingGround = ready && ScavHelper.CanScavenge();
            reply.minorWoundChancePercent = store.dumpingGroundMinorWoundImmunitySearchesLeft > 0 ? 0 : ScavHelper.GetMinorWoundChance();
            reply.majorWoundChancePercent = store.dumpingGroundMajorWoundImmunitySearchesLeft > 0 ? 0 : ScavHelper.GetMajorWoundChance();
        }

        private static string GetDepartureBlocker(BridgeReply reply, PlayerStore store, MapUIManager map)
        {
            if (reply.outingInTransit) return "Wait for the outing transition to finish.";
            if (reply.outingLocation.Length > 0) return "Return to the shop before choosing a new outing.";
            if (reply.shopState != "CLOSED") return "Outings are available after closing the shop for the night.";
            if (map == null || StoreShutterButton.Instance == null || StoreStation.Instance == null || EmporiumEntry.Instance == null)
                return "The after-hours map is unavailable.";
            if (store.lockAllFlag > 0 || store.lockStorePhysicalFlag > 0 || IsDragging()) return "Finish the current shop interaction first.";
            if (!store.isAfterhoursIntroduced) return "The game has not introduced after-hours outings yet.";
            if (reply.outingsLeft <= 0) return "There are no outings left tonight.";
            if (HealthData.IsSeriouslyWounded()) return "A serious wound prevents leaving the shop.";
            if (StartingPerkContent.IsAgoraphobiaResting()) return "The Agoraphobia perk requires a night of rest.";
            if (StoreStation.Instance.storeEventManager.IsEventActive("crackdown")) return "A crackdown prevents leaving the shop.";
            return "";
        }

        private static string GetRouteBlocker(string departureBlocker, string locationId, string locationName)
        {
            if (departureBlocker.Length > 0) return departureBlocker;
            var location = AfterhourLocation.Get(locationId);
            if (location == null || !location.IsDiscovered()) return locationName + " has not been discovered.";
            return location.IsAvailable() ? "" : locationName + " is closed tonight.";
        }

        private bool Depart(MapUIManager map, BridgeReply reply, string locationId, string blocker)
        {
            if (blocker.Length > 0) { reply.message = blocker; return false; }
            map.Travel(AfterhourLocation.Get(locationId));
            transitionUntil = Time.unscaledTime + 1f;
            reply.message = "Requested after-hours travel. Read the live shop to verify arrival.";
            return true;
        }

        internal bool Act(BridgeRequest request, BridgeReply reply)
        {
            var map = MapUIManager.Instance;
            switch (request.command)
            {
                case "visit_dumping_ground":
                    return Depart(map, reply, DumpingGround, reply.outingBlockReason);

                case "visit_commissary":
                    return Depart(map, reply, Commissary, reply.commissaryBlockReason);

                case "visit_dr_jackson":
                    return Depart(map, reply, Doctor, reply.doctorBlockReason);

                case "search_dumping_ground":
                    if (!reply.canSearchDumpingGround)
                    { reply.message = "A search is unavailable at the current location or in the current condition."; return false; }
                    map.ScavengeButtonClick();
                    reply.message = "Completed one search. Read the after-hours inventory for loot.";
                    return true;

                case "return_to_shop":
                    if (!reply.canReturnToShop) { reply.message = "The game is not ready to return to the shop."; return false; }
                    if (reply.groundStacks != request.leaveGroundCount)
                    { reply.message = "Pack the ground loot first, or explicitly confirm the current number of stacks to leave behind."; return false; }
                    var confirmation = GenericConfirmationUIManager.Instance;
                    if (reply.groundStacks > 0 && confirmation == null)
                    { reply.message = "The game cannot confirm leaving loot behind right now."; return false; }
                    map.Return();
                    if (reply.groundStacks > 0) confirmation.ConfirmButtonPressed();
                    transitionUntil = Time.unscaledTime + 1f;
                    reply.message = "Requested return to the shop. Read the live shop to verify arrival.";
                    return true;
            }
            return false;
        }

        private static bool IsDragging()
        {
            return ItemMouseDragHandler.current != null && ItemMouseDragHandler.current.IsDraggingItem;
        }
    }
}
