using System;
using System.Collections.Generic;
using UnityEngine;

namespace ProbablyStolenMcpBridge
{
    internal sealed class DialogueBridge
    {
        private const string RentChoice = "pay rent choice";
        private const string BuyoutChoice = "buyout choice";
        private Dialogue previousLine;
        private string previousCustomer;
        private string token;

        internal void Reset()
        {
            previousLine = null;
            previousCustomer = null;
            token = "";
        }

        internal void FillStatus(BridgeReply reply, PlayerStore store, StoreClient customer)
        {
            var ui = DialogUIManager.Instance;
            var phone = DialoguePhoneUIManager.Instance;
            var phoneLine = phone == null ? null : phone.GetCurrentDialog();
            var line = phoneLine ?? (ui == null ? null : ui.GetCurrentDialog());
            if (!ReferenceEquals(line, previousLine) || previousCustomer != reply.customerToken)
            {
                previousLine = line;
                previousCustomer = reply.customerToken;
                token = line == null ? "" : Guid.NewGuid().ToString("N");
            }
            reply.dialogueToken = line == null ? "" : token;
            reply.dialogueChannel = line == null ? "" : phoneLine != null ? "phone" : "counter";
            reply.dialogueSpeaker = line == null ? "" : line.title;
            reply.dialogueLine = line == null ? "" : line.plainText;
            reply.dialogueChoices = null;
            reply.canAdvanceDialogue = false;

            reply.rentIsActive = store.IsPayingRent();
            reply.daysUntilRent = store.IsPropertyPaid ? 0 : store.dayUntilRent;
            reply.rentAmount = reply.rentIsActive ? store.GetRentValue() : 0;
            reply.mortgageActive = store.isPayingMortgage;
            reply.mortgagePaymentsLeft = store.isPayingMortgage ? store.mortgageWeekLeft : 0;
            reply.mortgagePayment = store.isPayingMortgage ? store.mortgageWeeklyPayment : 0;
            reply.canPayRentNow = false;
            reply.canBuyProperty = false;

            if (line == null || reply.outingInTransit) return;
            var choices = GetVisibleChoices(phoneLine != null ? phone.dialogChoiceBubbles : ui.dialogChoiceBubbles, line);
            reply.dialogueChoices = choices;
            reply.canAdvanceDialogue = choices.Length == 0;
            if (!IsLandlordAtCounter(reply, customer)) return;
            reply.canPayRentNow = store.CanPayRent() && FindEnabledChoice(choices, RentChoice) != null;
            reply.canBuyProperty = store.CanBuyOutStore() && FindEnabledChoice(choices, BuyoutChoice) != null;
        }

        internal bool Act(BridgeRequest request, BridgeReply reply, PlayerStore store)
        {
            var ui = DialogUIManager.Instance;
            var phone = DialoguePhoneUIManager.Instance;
            bool phoneDialogue = reply.dialogueChannel == "phone";
            if ((phoneDialogue ? phone == null : ui == null) || reply.dialogueToken.Length == 0 ||
                (request.command != "buy_property" && request.dialogueToken != reply.dialogueToken))
            { reply.message = "Read the current dialogue again before acting."; return false; }

            if (request.command == "advance_dialogue")
            {
                if (!reply.canAdvanceDialogue)
                { reply.message = "Choose one of the displayed responses to continue."; return false; }
                if (phoneDialogue) phone.OnAdvancePressed();
                else ui.OnAdvancePressed();
                reply.message = "Requested advancing the current dialogue.";
                return true;
            }

            DialogueChoiceRow choice;
            if (request.command == "pay_rent" || request.command == "buy_property")
            {
                bool payingRent = request.command == "pay_rent";
                bool available = payingRent ? reply.canPayRentNow : reply.canBuyProperty;
                long amount = payingRent ? reply.rentAmount : reply.propertyPrice;
                choice = available && request.expectedPrice == amount ?
                    FindEnabledChoice(reply.dialogueChoices, payingRent ? RentChoice : BuyoutChoice) : null;
                if (choice == null)
                { reply.message = "The Landlord is not offering that payment at the expected price."; return false; }
            }
            else
            {
                choice = Array.Find(reply.dialogueChoices, row => row.choiceId == request.choiceId && row.enabled);
                if (choice == null)
                { reply.message = "That response is no longer available."; return false; }
                if ((choice.actionName == RentChoice && !reply.canPayRentNow) ||
                    (choice.actionName == BuyoutChoice && !reply.canBuyProperty))
                { reply.message = "That property payment is no longer available."; return false; }
            }

            if (phoneDialogue) phone.SelectChoice(choice.choiceId - 1);
            else ui.SelectChoice(choice.choiceId - 1);
            reply.message = "Selected the game response: " + choice.label;
            return true;
        }

        private static DialogueChoiceRow[] GetVisibleChoices(List<DialogChoiceBubble> bubbles, Dialogue line)
        {
            var rows = new List<DialogueChoiceRow>();
            for (int i = 0; i < line.choices.Count && i < bubbles.Count; i++)
            {
                var bubble = bubbles[i];
                if (bubble == null || !bubble.gameObject.activeInHierarchy) continue;
                var choice = line.choices[i];
                string action = choice.Item1 == null ? "" : choice.Item1.name;
                string label = bubble.TMP != null ? bubble.TMP.text : "";
                rows.Add(new DialogueChoiceRow
                {
                    choiceId = i + 1,
                    label = string.IsNullOrWhiteSpace(label) ? action : label,
                    actionName = action,
                    enabled = bubble.IsInteractable() && line.IsChoiceEnabledAt(i)
                });
            }
            return rows.ToArray();
        }

        private static bool IsLandlordAtCounter(BridgeReply reply, StoreClient customer)
        {
            return reply.dialogueChannel == "counter" && reply.shopState == "OPEN" && !ModHelper.IsOutsideStore() &&
                customer != null && customer.identifier == "landlord";
        }

        private static DialogueChoiceRow FindEnabledChoice(DialogueChoiceRow[] choices, string action)
        {
            return Array.Find(choices, choice => choice.enabled && choice.actionName == action);
        }
    }

    [Serializable]
    internal sealed class DialogueChoiceRow
    {
        public int choiceId;
        public string label;
        public string actionName;
        public bool enabled;
    }
}
