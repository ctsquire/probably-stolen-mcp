using System;
using System.Collections.Generic;

namespace ProbablyStolenMcpBridge
{
    internal static class PhoneBridge
    {
        internal static void FillStatus(BridgeReply reply, PlayerStore store)
        {
            var phone = PhoneUIManager.Instance;
            reply.phoneOpen = phone != null && phone.phonePanel != null && phone.phonePanel.activeInHierarchy;
            string status = reply.phoneOpen && phone.statusDisplay != null ? phone.statusDisplay.text : "";
            reply.phoneInCall = status == LocHelper.GetLocalizedUI("ui_phone_calling") || status == LocHelper.GetLocalizedUI("ui_phone_in_call");
            long number;
            reply.phoneNumber = reply.phoneInCall && phone.numberDisplay != null && long.TryParse(phone.numberDisplay.text, out number) ? number : 0;
            reply.wildNetworkOpen = WildNetworkUI.IsOpen;
            reply.wildFavor = store.wildFavor;
            reply.canDialPhone = phone != null && reply.day > 0 && !ModHelper.IsOutsideStore() &&
                !reply.hasCustomer && !reply.phoneInCall && !reply.securityResponding && !reply.wildNetworkOpen &&
                string.IsNullOrEmpty(reply.dialogueToken) && store.lockAllFlag <= 0 && store.lockStorePhysicalFlag <= 0;
        }

        internal static bool Act(BridgeRequest request, BridgeReply reply, PlayerStore store)
        {
            var phone = PhoneUIManager.Instance;
            switch (request.command)
            {
                case "list_phone_contacts":
                    var contacts = new List<PhoneContactRow>();
                    if (phone != null && store.PhoneClientDict != null)
                    {
                        foreach (var pair in store.PhoneClientDict)
                        {
                            var contact = pair.Value;
                            if (contact == null) continue;
                            bool willAnswer = PhoneUIManager.WillAnswerCall(pair.Key);
                            if (!contact.ShownInPhoneBook() && !willAnswer) continue;
                            contacts.Add(new PhoneContactRow
                            {
                                number = pair.Key,
                                name = contact.GetLocalizedDisplayName(),
                                state = contact.phoneState.ToString(),
                                willAnswer = willAnswer
                            });
                        }
                    }
                    reply.phoneContacts = contacts.ToArray();
                    return true;

                case "dial_phone":
                    if (!reply.canDialPhone)
                    { reply.message = "Finish the current shop interaction before dialing."; return false; }
                    if (!PhoneUIManager.WillAnswerCall(request.phoneNumber))
                    { reply.message = "That number is not answering in the current game state."; return false; }
                    if (!reply.phoneOpen) phone.OpenUI();
                    phone.AutoCall(request.phoneNumber);
                    reply.message = "Called the in-game contact. Read the live dialogue for options.";
                    return true;

                case "hang_up_phone":
                    if (!reply.phoneOpen && !reply.phoneInCall)
                    { reply.message = "There is no open phone call or panel."; return false; }
                    phone.CloseUI();
                    reply.message = "Closed the phone.";
                    return true;

                case "list_wild_upgrades":
                    if (!reply.wildNetworkOpen)
                    { reply.message = "Open Wild's Network through his visit or the phone first."; return false; }
                    var upgrades = new List<WildUpgradeRow>();
                    foreach (var pair in store.networkUpgrade)
                    {
                        var upgrade = pair.Value;
                        if (!IsShownUpgrade(pair.Key, upgrade)) continue;
                        upgrades.Add(new WildUpgradeRow
                        {
                            upgradeId = pair.Key,
                            name = upgrade.GetLocalizedTitle(),
                            description = upgrade.GetLocalizedDescription(),
                            price = upgrade.GetCost(),
                            unlocked = upgrade.IsUnlocked(),
                            canPurchase = CanPurchase(upgrade, store)
                        });
                    }
                    reply.wildUpgrades = upgrades.ToArray();
                    return true;

                case "buy_wild_upgrade":
                    NetworkUpgrade selected;
                    if (!reply.wildNetworkOpen || string.IsNullOrEmpty(request.upgradeId) ||
                        !store.networkUpgrade.TryGetValue(request.upgradeId, out selected) ||
                        !IsShownUpgrade(request.upgradeId, selected) || !CanPurchase(selected, store) ||
                        selected.GetCost() != request.expectedPrice)
                    { reply.message = "That Network upgrade is not available at the expected price."; return false; }
                    int price = selected.GetCost();
                    int favorPayment = Math.Min(store.wildFavor, price);
                    int cashPayment = price - favorPayment;
                    store.wildFavor -= favorPayment;
                    store.playerCash -= cashPayment;
                    RunStats.OnWildUpgradeBought(cashPayment);
                    selected.Unlock();
                    EmporiumAnalytics.TrackWildUpgradePurchased(request.upgradeId);
                    if (EmporiumAudioPlayer.Instance != null) EmporiumAudioPlayer.Instance.PlayRegister();
                    WildNetworkUI.RefreshAll();
                    reply.message = "Purchased " + selected.GetLocalizedTitle() + " through Wild's Network.";
                    return true;

                case "close_wild_network":
                    if (!reply.wildNetworkOpen)
                    { reply.message = "Wild's Network is already closed."; return false; }
                    WildNetworkUI.Close();
                    reply.message = "Closed Wild's Network.";
                    return true;
            }
            return false;
        }

        private static bool IsShownUpgrade(string id, NetworkUpgrade upgrade)
        {
            return upgrade != null && !NetworkUpgrade.IsHiddenForRun(id) && !NetworkUpgrade.IsLockedInDemo(id);
        }

        private static bool CanPurchase(NetworkUpgrade upgrade, PlayerStore store)
        {
            return upgrade.IsReady() && !upgrade.IsUnlocked() && upgrade.GetCost() <= (long)store.GetCash() + store.wildFavor;
        }
    }

    [Serializable]
    internal sealed class PhoneContactRow
    {
        public long number;
        public string name;
        public string state;
        public bool willAnswer;
    }

    [Serializable]
    internal sealed class WildUpgradeRow
    {
        public string upgradeId;
        public string name;
        public string description;
        public int price;
        public bool unlocked;
        public bool canPurchase;
    }
}
