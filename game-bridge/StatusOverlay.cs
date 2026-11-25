using UnityEngine;
using UnityEngine.UI;

namespace ProbablyStolenMcpBridge
{
    internal sealed class StatusOverlay
    {
        private GameObject display;
        private Text text;
        private float expiresAt;

        internal string Message
        {
            get { return IsVisible ? text.text : ""; }
        }

        internal bool IsVisible
        {
            get { return display != null && display.activeInHierarchy && text != null && text.isActiveAndEnabled; }
        }

        internal void Tick()
        {
            if (IsVisible && Time.unscaledTime >= expiresAt) Clear();
        }

        internal void Clear()
        {
            if (display != null) display.SetActive(false);
        }

        internal bool Show(Transform parent, string message, int seconds)
        {
            if (string.IsNullOrWhiteSpace(message))
            {
                Clear();
                return true;
            }
            if (display == null && !CreateDisplay(parent)) return false;
            text.text = message;
            expiresAt = Time.unscaledTime + seconds;
            display.SetActive(true);
            return IsVisible;
        }

        private bool CreateDisplay(Transform parent)
        {
            var font = Resources.GetBuiltinResource<Font>("Arial.ttf");
            if (font == null) return false;
            display = new GameObject("MCP Status", typeof(RectTransform), typeof(Canvas), typeof(CanvasScaler));
            display.transform.SetParent(parent, false);
            var canvas = display.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            canvas.sortingOrder = 120;
            var scaler = display.GetComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1280, 720);
            scaler.matchWidthOrHeight = 0.5f;

            RectTransform panel = AddRect(display.transform, "Status panel");
            panel.anchorMin = new Vector2(0.5f, 1);
            panel.anchorMax = panel.anchorMin;
            panel.pivot = panel.anchorMin;
            panel.anchoredPosition = new Vector2(0, -6);
            panel.sizeDelta = new Vector2(346, 90);
            var background = panel.gameObject.AddComponent<Image>();
            background.color = new Color32(27, 24, 37, 244);
            background.raycastTarget = false;

            Text heading = AddText(panel, "Heading", font, 13, new Color32(159, 219, 201, 255));
            heading.text = "MCP status";
            heading.fontStyle = FontStyle.Bold;
            PlaceText(heading.rectTransform, -8, 17);

            text = AddText(panel, "Message", font, 15, new Color32(242, 228, 203, 255));
            text.resizeTextForBestFit = true;
            text.resizeTextMinSize = 11;
            text.resizeTextMaxSize = 15;
            PlaceText(text.rectTransform, -27, 55);
            return true;
        }

        private static RectTransform AddRect(Transform parent, string name)
        {
            var node = new GameObject(name, typeof(RectTransform));
            node.transform.SetParent(parent, false);
            return node.GetComponent<RectTransform>();
        }

        private static Text AddText(Transform parent, string name, Font font, int fontSize, Color color)
        {
            var label = AddRect(parent, name).gameObject.AddComponent<Text>();
            label.font = font;
            label.fontSize = fontSize;
            label.color = color;
            label.raycastTarget = false;
            label.supportRichText = false;
            label.alignment = TextAnchor.UpperLeft;
            return label;
        }

        private static void PlaceText(RectTransform label, float top, float height)
        {
            label.anchorMin = new Vector2(0, 1);
            label.anchorMax = new Vector2(1, 1);
            label.pivot = new Vector2(0.5f, 1);
            label.sizeDelta = new Vector2(-24, height);
            label.anchoredPosition = new Vector2(0, top);
        }
    }
}
