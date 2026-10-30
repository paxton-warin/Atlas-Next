import { useEffect, useLayoutEffect, useState } from "react";

const legacyAccents: Record<string, string> = {
  forest: "#bce39b", sand: "#e0b787", violet: "#c8b9ff",
  ocean: "#9bd9e3", rose: "#f1b4bf", ink: "#d4d4d4",
};

/** Presentation only: never persists, changes account settings or touches a frame. */
export function contrastInk(hex: string): "#0b100d" | "#ffffff" {
  const value = /^#[\da-f]{6}$/i.test(hex) ? hex : "#9fd37a";
  const channels = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255)
    .map((n) => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
  const luminance = channels.reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
  const dark = 0.0043;
  return (luminance + 0.05) / (dark + 0.05) >= 1.05 / (luminance + 0.05) ? "#0b100d" : "#ffffff";
}

export function useV21Theme(theme: string, mode: string, accent: string): "light" | "dark" {
  const [systemLight, setSystemLight] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const change = () => setSystemLight(query.matches);
    query.addEventListener("change", change);
    change();
    return () => query.removeEventListener("change", change);
  }, []);
  const resolved = mode === "light" || (mode === "system" && systemLight) ? "light" : "dark";
  useLayoutEffect(() => {
    const body = document.body;
    body.dataset.v21Theme = Object.hasOwn(legacyAccents, theme) ? theme : "forest";
    body.dataset.v21Mode = resolved;
    document.documentElement.dataset.mode = resolved;
    const custom = /^#[\da-f]{6}$/i.test(accent) && accent.toLowerCase() !== legacyAccents[theme];
    if (custom) {
      body.style.setProperty("--v21-custom-accent", accent);
      body.style.setProperty("--v21-custom-accent-ink", contrastInk(accent));
      // Keep custom fills, but use the readable primary foreground for tiny labels.
      body.style.setProperty("--v21-custom-accent-text", "var(--v21-text)");
    } else {
      body.style.removeProperty("--v21-custom-accent");
      body.style.removeProperty("--v21-custom-accent-ink");
      body.style.removeProperty("--v21-custom-accent-text");
    }
  }, [theme, resolved, accent]);
  return resolved;
}
