using UnityEngine;

namespace ProbablyStolenMcpBridge
{
    internal sealed class SecurityBridge
    {
        private string equippedCustomerToken = "";
        private float transitionUntil;

        internal void Reset()
        {
            equippedCustomerToken = "";
            transitionUntil = 0;
        }

        internal void FillStatus(BridgeReply reply, PlayerStore store, StoreClient customer, bool atOpenShop)
        {
            var ui = StoreUIManager.Instance;
            var alarm = StoreSecButton.Instance;
            reply.shotgunUnlocked = store.isShootingUnlocked;
            reply.shotgunEquipped = ui != null && ui.isShootingMode;
            reply.shotgunTransitioning = Time.unscaledTime < transitionUntil;
            reply.securityResponding = store.isClientBeingArrested || store.isHandlingShootout;
            reply.securityAlarmAvailable = alarm != null && alarm.gameObject.activeInHierarchy &&
                !StoreReputation.IsPerkUnlocked("SEC_ALARM_IGNORED");
            reply.offerStolenItem = "";
            reply.offerSeriousContrabandItem = "";
            reply.canReportCustomer = false;

            bool ready = atOpenShop && !reply.securityResponding && !reply.shotgunTransitioning && ui != null;
            var shotgun = GetShotgun(ui);
            reply.canHolsterShotgun = ready && reply.shotgunEquipped && !ui.isShot;
            reply.canEquipShotgun = ready && customer != null && !reply.shotgunEquipped && reply.shotgunUnlocked &&
                store.lockAllFlag <= 0 && store.lockStorePhysicalFlag <= 0 && shotgun != null && shotgun.CanPickup();
            reply.canFireShotgun = ready && customer != null && reply.shotgunEquipped && reply.shotgunUnlocked &&
                reply.customerToken == equippedCustomerToken && ui.CanShoot() &&
                ui.arm != null && ui.arm.activeInHierarchy && ui.shootingUI != null && ui.shootingUI.activeInHierarchy;

            var entry = EmporiumEntry.Instance;
            if (atOpenShop && customer != null && entry != null &&
                entry.backInvinvElement != null && entry.frontInvinvElement != null)
            {
                // The alarm checks the customer's unowned items on both counters.
                foreach (var item in entry.GetAllNonOwnedItem())
                {
                    if (item == null) continue;
                    if (reply.offerStolenItem.Length == 0 && StolenHelper.IsStolenItem(item))
                        reply.offerStolenItem = item.GetDisplayName(true);
                    if (reply.offerSeriousContrabandItem.Length == 0 && ContrabandHelper.IsSeriousContraband(item))
                        reply.offerSeriousContrabandItem = item.GetDisplayName(true);
                }
            }
            reply.canReportCustomer = ready && customer != null && !reply.shotgunEquipped && reply.securityAlarmAvailable &&
                store.lockAllFlag <= 0 && customer.CanReport();
        }

        internal bool Act(BridgeRequest request, BridgeReply reply, PlayerStore store)
        {
            if (request.command != "holster_shotgun" && (!reply.hasCustomer || request.customerToken != reply.customerToken))
            { reply.message = "The current customer changed or left. Read the live shop again."; return false; }

            var ui = StoreUIManager.Instance;
            switch (request.command)
            {
                case "report_customer":
                    bool matchesReason = string.IsNullOrEmpty(request.reportReason) ||
                        (request.reportReason == "stolen_goods" && reply.offerStolenItem.Length > 0) ||
                        (request.reportReason == "contraband" && reply.offerSeriousContrabandItem.Length > 0);
                    if (!matchesReason)
                    { reply.message = "The current offer has no item that qualifies for that report."; return false; }
                    if (!reply.canReportCustomer)
                    { reply.message = "The game's alarm is unavailable for this customer right now."; return false; }
                    var customer = store.currentClientInstance.GetClientBlueprint();
                    StoreSecButton.Instance.OnClick();
                    reply.message = customer.reported ? "Pressed the alarm and reported the customer." :
                        "Pressed the alarm. The customer may respond before the report proceeds.";
                    return true;

                case "equip_shotgun":
                    if (!reply.canEquipShotgun)
                    { reply.message = "The shotgun cannot be equipped for the current customer."; return false; }
                    GetShotgun(ui).OnClick();
                    equippedCustomerToken = reply.customerToken;
                    transitionUntil = Time.unscaledTime + 0.8f;
                    reply.message = "Requested equipping the shotgun. Read the live shop before firing or holstering.";
                    return true;

                case "fire_shotgun":
                    if (!reply.canFireShotgun)
                    { reply.message = "Equip the shotgun for this customer and wait for the game to enable firing."; return false; }
                    ui.Shoot();
                    equippedCustomerToken = "";
                    reply.message = "Fired the in-game shotgun. The game will resolve the shot.";
                    return true;

                case "holster_shotgun":
                    if (!reply.canHolsterShotgun)
                    { reply.message = "The shotgun is not in a state where it can be holstered."; return false; }
                    ui.ExitShootingMode();
                    equippedCustomerToken = "";
                    transitionUntil = Time.unscaledTime + 0.8f;
                    reply.message = "Requested holstering the shotgun.";
                    return true;
            }
            return false;
        }

        private static Shotgun GetShotgun(StoreUIManager ui)
        {
            return ui == null || ui.shotgun == null || !ui.shotgun.activeInHierarchy ? null :
                ui.shotgun.GetComponentInChildren<Shotgun>();
        }
    }
}
