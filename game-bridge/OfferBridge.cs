using System;
using System.Collections.Generic;

namespace ProbablyStolenMcpBridge
{
    internal sealed class OfferBridge
    {
        private List<Offer> previous = new List<Offer>();
        private string previousCustomer;
        private string token;

        internal void Reset()
        {
            previous.Clear();
            previousCustomer = null;
            token = "";
        }

        internal void FillStatus(BridgeReply reply, PlayerStore store, StoreClient customer, bool counterReady)
        {
            var entry = EmporiumEntry.Instance;
            var offers = new List<Offer>();
            if (counterReady && customer != null && customer.IsClientSelling() && entry != null &&
                entry.frontInvinvElement != null && entry.backInvinvElement != null)
            {
                foreach (var item in entry.GetAllNonOwnedItem())
                    if (item != null && item.unitCount > 0) offers.Add(new Offer(item));
            }

            if (reply.customerToken != previousCustomer || !SameItems(previous, offers))
            {
                previous = offers;
                previousCustomer = reply.customerToken;
                token = offers.Count == 0 ? "" : Guid.NewGuid().ToString("N");
            }

            reply.offerToken = token;
            reply.customerOffers = new CustomerOfferRow[offers.Count];
            bool canSelect = store.lockAllFlag <= 0 && store.lockAllInventoryFlag <= 0 &&
                (ItemMouseDragHandler.current == null || !ItemMouseDragHandler.current.IsDraggingItem);
            for (int i = 0; i < offers.Count; i++)
            {
                var offer = offers[i];
                bool onScale = ReferenceEquals(offer.Source, entry.backInvinvElement);
                bool selected = ReferenceEquals(offer.Item, store.currentNegociatedItem);
                reply.customerOffers[i] = new CustomerOfferRow
                {
                    offerId = i + 1,
                    name = offer.Item.GetDisplayName(true),
                    quantity = offer.Quantity,
                    location = onScale ? "scale" : "front_counter",
                    selected = selected,
                    canSelect = canSelect && (onScale || offer.Item.MayRemove())
                };
            }
        }

        internal bool Select(BridgeRequest request, BridgeReply reply, PlayerStore store)
        {
            if (reply.offerToken.Length == 0 || request.offerToken != reply.offerToken || request.customerToken != reply.customerToken ||
                request.offerId < 1 || request.offerId > previous.Count)
            { reply.message = "The customer or their offer changed. Read the live shop again."; return false; }
            int index = request.offerId - 1;
            var offer = previous[index];
            if (!reply.customerOffers[index].canSelect)
            { reply.message = "The game does not allow selecting this offer right now."; return false; }
            if (ReferenceEquals(offer.Item, store.currentNegociatedItem))
            { reply.message = "The offered item is already selected."; return true; }

            var scale = EmporiumEntry.Instance.backInvinvElement;
            if (ReferenceEquals(offer.Source, scale)) store.AddedItemToWeightedArea(offer.Item);
            else
            {
                var slot = scale.TryFindOneValidInventorySlot(offer.Item);
                if (scale.IsInsertLocked() || slot == null || slot.targetItem != null ||
                    !ReferenceEquals(slot.inventory, scale) || slot.numTransfer < offer.Quantity ||
                    offer.Item.MaxNumRemove() < offer.Quantity)
                { reply.message = "The scale has no legal slot for this offer."; return false; }
                reply.movedQuantity = slot.TryAcceptOnce(offer.Quantity);
                if (reply.movedQuantity != offer.Quantity)
                { reply.message = "The game did not move the full offer. Read the live shop again."; return false; }
            }
            bool selected = ReferenceEquals(store.currentNegociatedItem, offer.Item);
            reply.message = selected ? "Selected the offer on the scale." : "The game did not select the offer. Read the live shop again.";
            return selected;
        }

        private static bool SameItems(List<Offer> left, List<Offer> right)
        {
            if (left.Count != right.Count) return false;
            for (int i = 0; i < left.Count; i++)
                if (!ReferenceEquals(left[i].Item, right[i].Item) || !ReferenceEquals(left[i].Source, right[i].Source) ||
                    left[i].Quantity != right[i].Quantity) return false;
            return true;
        }

        private sealed class Offer
        {
            internal readonly GameItem Item;
            internal readonly GameInventory Source;
            internal readonly int Quantity;

            internal Offer(GameItem item)
            {
                Item = item;
                Source = item.parentInventory;
                Quantity = item.unitCount;
            }
        }
    }

    [Serializable]
    internal sealed class CustomerOfferRow
    {
        public int offerId;
        public string name;
        public int quantity;
        public string location;
        public bool selected;
        public bool canSelect;
    }
}
