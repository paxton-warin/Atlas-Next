import { useEffect, useRef, useState } from "react";
import { Check, ImagePlus, Upload } from "lucide-react";
import { tabPresets, tabAppearance, readTabIcon } from "./tab-presets";
import type { Settings } from "./model";

export default function TabAppearance({
  settings: s,
  update,
  toast,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  toast: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const appearance = tabAppearance(s);
  return (
    <section className="setting-card tab-appearance">
      <div className="section-title">
        <ImagePlus size={18} />
        <h2>Browser tab title & icon</h2>
      </div>
      <p>
        Choose a preset or customize the Atlas tab. Preset logos are stored with
        Atlas, so selecting one makes no third-party request.
      </p>
      <div className="tab-preset-grid" role="group" aria-label="Tab presets">
        {tabPresets.map((p) => (
          <button
            type="button"
            key={p.id}
            className={"tab-preset " + (s.tabPreset === p.id ? "chosen" : "")}
            aria-label={"Tab preset " + p.name}
            aria-pressed={s.tabPreset === p.id}
            onClick={() => update({ tabPreset: p.id })}
          >
            <img src={p.icon} width={24} height={24} alt="" />
            <span>{p.name}</span>
            {s.tabPreset === p.id && <Check size={13} />}
          </button>
        ))}
        <button
          type="button"
          className={
            "tab-preset custom-preset " +
            (s.tabPreset === "custom" ? "chosen" : "")
          }
          aria-label="Tab preset Custom"
          aria-pressed={s.tabPreset === "custom"}
          onClick={() => update({ tabPreset: "custom" })}
        >
          <ImagePlus size={24} />
          <span>Custom</span>
          {s.tabPreset === "custom" && <Check size={13} />}
        </button>
      </div>
      <div className="tab-appearance-preview" aria-label="Browser tab preview">
        <img src={appearance.icon} alt="" width={18} height={18} />
        <span>{appearance.title}</span>
        <span aria-hidden="true">×</span>
      </div>
      {s.tabPreset === "custom" && (
        <div className="custom-tab-fields">
          <label className="form-field">
            Custom tab title
            <input
              maxLength={60}
              value={s.title}
              placeholder="Atlas"
              onChange={(e) => update({ title: e.target.value })}
            />
          </label>
          <div className="button-row">
            <label className="file-button">
              <Upload size={16} />
              {busy ? "Preparing icon…" : "Upload icon"}
              <input
                type="file"
                aria-label="Upload custom tab icon"
                disabled={busy}
                accept="image/png,image/jpeg,image/webp,image/gif,image/x-icon,image/vnd.microsoft.icon,.ico"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  const request = ++sequence.current;
                  setBusy(true);
                  try {
                    const tabIcon = await readTabIcon(file);
                    if (request === sequence.current) update({ tabIcon });
                  } catch (error) {
                    if (request === sequence.current)
                      toast(
                        error instanceof Error
                          ? error.message
                          : "Choose a valid image.",
                      );
                  } finally {
                    if (request === sequence.current) setBusy(false);
                  }
                }}
              />
            </label>
            <button
              type="button"
              className="button"
              disabled={!s.tabIcon || busy}
              onClick={() => update({ tabIcon: "" })}
            >
              Reset icon
            </button>
          </div>
          <p className="small muted">
            PNG, JPEG, WebP, GIF or ICO · up to 1 MB. Your custom icon stays on
            this device.
          </p>
        </div>
      )}
    </section>
  );
}
