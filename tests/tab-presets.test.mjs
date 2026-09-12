import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  tabPresets,
  tabAppearance,
  validCustomIcon,
} from "../web/src/tab-presets.ts";

test("tab presets use distinct, locally bundled official logos with recorded hashes", () => {
  const assets = JSON.parse(
    readFileSync("web/public/tab-icons/origins.json", "utf8"),
  );
  assert.equal(tabPresets.length, 7);
  assert.equal(assets.length, 6);
  for (const asset of assets) {
    assert.ok(
      ["www.google.com", "ssl.gstatic.com"].includes(
        new URL(asset.url).hostname,
      ),
    );
    const bytes = readFileSync("web/public/tab-icons/" + asset.file);
    assert.equal(bytes.length, asset.bytes);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      asset.sha256,
    );
  }
  assert.equal(new Set(assets.map((a) => a.sha256)).size, 6);
  for (const preset of tabPresets) {
    assert.ok(readFileSync("web/public" + preset.icon).length > 0);
    assert.equal(
      tabAppearance({
        tabPreset: preset.id,
        title: "custom draft",
        tabIcon: "",
      }).title,
      preset.title,
    );
  }
});

test("custom tab identity uses local bounded PNG data and a stable fallback", () => {
  const png =
    "data:image/png;base64," +
    readFileSync("web/public/tab-icons/drive.png").toString("base64");
  assert.ok(validCustomIcon(png));
  for (const icon of [
    "https://example.com/icon.png",
    "data:image/svg+xml,<svg/>",
    png + "A".repeat(50000),
    null,
  ])
    assert.equal(validCustomIcon(icon), false);
  assert.deepEqual(
    tabAppearance({
      tabPreset: "custom",
      title: "  Study desk  ",
      tabIcon: png,
    }),
    { title: "Study desk", icon: png },
  );
  assert.deepEqual(
    tabAppearance({
      tabPreset: "custom",
      title: "",
      tabIcon: "https://example.com",
    }),
    { title: "Atlas", icon: "/favicon.svg" },
  );
});
