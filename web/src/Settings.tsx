import { useState } from "react";
import {
  Palette,
  PanelTop,
  Globe2,
  Database,
  Download,
  Upload,
  RotateCcw,
  ArrowUpRight,
  Check,
  Monitor,
  Sun,
  Moon,
  SlidersHorizontal,
} from "lucide-react";
import {
  defaults,
  sanitizeSettings,
  themes,
  type Settings as Preferences,
} from "./model";
type Props = {
  settings: Preferences;
  update: (s: Partial<Preferences>) => void;
  toast: (s: string) => void;
  wizard: () => void;
  clear: () => void;
};
export function Toggle({
  on,
  change,
  label,
}: {
  on: boolean;
  change: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={"toggle " + (on ? "on" : "")}
      role="switch"
      aria-label={label}
      aria-checked={on}
      onClick={change}
    >
      <span />
    </button>
  );
}
export function Settings({ settings: s, update, toast, wizard, clear }: Props) {
  const [section, setSection] = useState("Appearance");
  const [query, setQuery] = useState("");
  const sections = [
    ["Appearance", Palette],
    ["Browser", PanelTop],
    ["Privacy & data", Database],
  ] as const;
  const show = (v: string) => section === v || !!query;
  const exportSettings = () => {
    const blob = new Blob(
      [JSON.stringify({ version: 1, settings: s }, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "atlas-settings.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="page settings-page">
      <div className="page-heading">
        <div>
          <h1>Settings</h1>
          <p>Appearance, browsing, and stored data.</p>
        </div>
        <SlidersHorizontal size={30} />
      </div>
      <div className="settings-layout">
        <aside className="settings-nav">
          <input
            aria-label="Search settings"
            placeholder="Find a setting…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {sections.map(([label, Icon]) => (
            <button
              key={label}
              className={section === label ? "selected" : ""}
              onClick={() => {
                setSection(label);
                setQuery("");
              }}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
          <button onClick={wizard}>
            <RotateCcw size={16} />
            Reopen welcome wizard
          </button>
        </aside>
        <div className="settings-sections">
          {show("Appearance") &&
            (!query ||
              /theme|appearance|color|background|wallpaper|motion|blur|dark|light/.test(
                query.toLowerCase(),
              )) && (
              <>
                <section className="setting-card">
                  <div className="section-title">
                    <Palette size={18} />
                    <h2>Theme</h2>
                  </div>
                  <p>Choose a preset or use a custom accent.</p>
                  <div className="theme-grid">
                    {themes.map((t) => (
                      <button
                        key={t.id}
                        aria-label={"Theme " + t.name}
                        className={
                          "theme-choice " + (s.theme === t.id ? "chosen" : "")
                        }
                        onClick={() =>
                          update({ theme: t.id, accent: t.accent })
                        }
                      >
                        <div
                          className="theme-preview"
                          style={{ background: t.bg }}
                        >
                          <span style={{ background: t.surface }} />
                          <i style={{ background: t.accent }} />
                          <i style={{ background: t.accent, opacity: 0.35 }} />
                          {s.theme === t.id && (
                            <Check size={15} style={{ color: t.accent }} />
                          )}
                        </div>
                        <span>{t.name}</span>
                      </button>
                    ))}
                  </div>
                  <div className="setting-row">
                    <div>
                      <h3>Color mode</h3>
                      <p>Choose light, dark, or system appearance.</p>
                    </div>
                    <div className="segmented">
                      {[
                        ["light", Sun],
                        ["dark", Moon],
                        ["system", Monitor],
                      ].map(([mode, Icon]: any) => (
                        <button
                          aria-label={"Mode " + mode}
                          className={s.mode === mode ? "selected" : ""}
                          key={mode}
                          onClick={() => update({ mode })}
                        >
                          <Icon size={15} />
                          {mode}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="setting-row">
                    <div>
                      <h3>Custom accent</h3>
                      <p>Used for selected controls and highlights.</p>
                    </div>
                    <label className="color-control">
                      <input
                        type="color"
                        value={s.accent}
                        onChange={(e) => update({ accent: e.target.value })}
                      />
                      {s.accent.toUpperCase()}
                    </label>
                  </div>
                </section>
                <section className="setting-card">
                  <div className="section-title">
                    <Sun size={18} />
                    <h2>Background</h2>
                  </div>
                  <div className="background-grid">
                    {["aurora", "contour", "solid", "wallpaper"].map((bg) => (
                      <button
                        className={
                          "background-choice " +
                          (s.background === bg ? "chosen" : "")
                        }
                        key={bg}
                        onClick={() => update({ background: bg as any })}
                      >
                        <span className={"background-sample " + bg} />
                        {bg === "aurora"
                          ? "Soft glow"
                          : bg === "contour"
                            ? "Contour"
                            : bg === "solid"
                              ? "Minimal"
                              : "Your photo"}
                      </button>
                    ))}
                  </div>
                  {s.background === "wallpaper" && (
                    <label className="file-button">
                      <Upload size={16} />
                      Upload an image
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          if (file.size > 2_000_000) {
                            toast("Choose an image smaller than 2 MB.");
                            return;
                          }
                          const reader = new FileReader();
                          reader.onload = () =>
                            update({ wallpaper: String(reader.result) });
                          reader.readAsDataURL(file);
                        }}
                      />
                    </label>
                  )}
                  <div className="setting-row">
                    <span>Background dimming</span>
                    <input
                      aria-label="Background dimming"
                      type="range"
                      min="0"
                      max="85"
                      value={s.dim}
                      onChange={(e) => update({ dim: +e.target.value })}
                    />
                  </div>
                  <div className="setting-row">
                    <span>Wallpaper blur</span>
                    <input
                      aria-label="Wallpaper blur"
                      type="range"
                      min="0"
                      max="30"
                      value={s.blur}
                      onChange={(e) => update({ blur: +e.target.value })}
                    />
                  </div>
                  <div className="setting-row">
                    <div>
                      <h3>Animations</h3>
                      <p>Enable interface transitions.</p>
                    </div>
                    <Toggle
                      label="Animations"
                      on={s.motion}
                      change={() => update({ motion: !s.motion })}
                    />
                  </div>
                </section>
              </>
            )}
          {show("Browser") &&
            (!query ||
              /tab|browser|engine|search|restore|compact/.test(
                query.toLowerCase(),
              )) && (
              <>
                <section className="setting-card">
                  <div className="section-title">
                    <PanelTop size={18} />
                    <h2>Tabs and layout</h2>
                  </div>
                  <div className="layout-choices">
                    {["sidebar", "top"].map((t) => (
                      <button
                        className={s.tabs === t ? "chosen" : ""}
                        key={t}
                        onClick={() => update({ tabs: t as any })}
                      >
                        <div className={"layout-diagram " + t}>
                          <span />
                          <i />
                          <i />
                        </div>
                        <strong>
                          {t === "sidebar" ? "Sidebar tabs" : "Top tabs"}
                        </strong>
                        <small>
                          {t === "sidebar"
                            ? "Vertical tabs"
                            : "Horizontal tabs"}
                        </small>
                      </button>
                    ))}
                  </div>
                  <div className="setting-row">
                    <div>
                      <h3>Compact spacing</h3>
                      <p>Use denser controls and smaller gaps.</p>
                    </div>
                    <Toggle
                      label="Compact spacing"
                      on={s.compact}
                      change={() => update({ compact: !s.compact })}
                    />
                  </div>
                  <div className="setting-row">
                    <div>
                      <h3>Restore tabs</h3>
                      <p>Restore tab addresses. Pages load only when opened.</p>
                    </div>
                    <Toggle
                      label="Restore tabs"
                      on={s.restore}
                      change={() => update({ restore: !s.restore })}
                    />
                  </div>
                </section>
                <section className="setting-card">
                  <div className="section-title">
                    <Globe2 size={18} />
                    <h2>Search & browsing</h2>
                  </div>
                  <label className="form-field">
                    Search engine
                    <select
                      value={
                        [
                          "https://www.google.com/search?q=%s",
                          "https://duckduckgo.com/?q=%s",
                          "https://www.bing.com/search?q=%s",
                        ].includes(s.search)
                          ? s.search
                          : "custom"
                      }
                      onChange={(e) =>
                        e.target.value !== "custom" &&
                        update({ search: e.target.value })
                      }
                    >
                      <option value="https://www.google.com/search?q=%s">
                        Google
                      </option>
                      <option value="https://duckduckgo.com/?q=%s">
                        DuckDuckGo
                      </option>
                      <option value="https://www.bing.com/search?q=%s">
                        Bing
                      </option>
                      <option value="custom">Custom</option>
                    </select>
                  </label>
                  <label className="form-field">
                    Search URL (%s is your search)
                    <input
                      defaultValue={s.search}
                      key={s.search}
                      onBlur={(e) => {
                        if (
                          e.target.value.startsWith("https://") &&
                          e.target.value.includes("%s")
                        )
                          update({ search: e.target.value });
                        else toast("Use an HTTPS search URL containing %s.");
                      }}
                    />
                  </label>
                  <div className="setting-row">
                    <div>
                      <h3>Default browsing engine</h3>
                      <p>
                        Applies to new tabs. Existing sessions stay in their
                        engine.
                      </p>
                    </div>
                    <select
                      aria-label="Default browsing engine"
                      value={s.engine}
                      onChange={(e) =>
                        update({ engine: e.target.value as any })
                      }
                    >
                      <option value="scramjet">Scramjet · Recommended</option>
                      <option value="ultraviolet">Ultraviolet</option>
                    </select>
                  </div>
                </section>
              </>
            )}
          {show("Privacy & data") &&
            (!query ||
              /privacy|data|history|title|export|import|clear|exit/.test(
                query.toLowerCase(),
              )) && (
              <>
                <section className="setting-card">
                  <div className="section-title">
                    <Database size={18} />
                    <h2>Local data</h2>
                  </div>
                  <p>
                    Your preferences and browsing history stay in this browser.
                    No Atlas account.
                  </p>
                  <div className="setting-row">
                    <div>
                      <h3>Remember browsing history</h3>
                      <p>Keep the last 100 destinations on this device.</p>
                    </div>
                    <Toggle
                      label="Remember history"
                      on={s.history}
                      change={() => update({ history: !s.history })}
                    />
                  </div>
                  <label className="form-field">
                    Browser tab title
                    <input
                      maxLength={60}
                      value={s.title}
                      placeholder="Atlas"
                      onChange={(e) => update({ title: e.target.value })}
                    />
                  </label>
                  <label className="form-field">
                    Quick-exit key
                    <input
                      value={s.exitKey}
                      placeholder="Click and press a key"
                      onKeyDown={(e) => {
                        e.preventDefault();
                        update({ exitKey: e.key === "Backspace" ? "" : e.key });
                      }}
                      readOnly
                    />
                  </label>
                  <label className="form-field">
                    Quick-exit destination
                    <input
                      value={s.exitUrl}
                      onChange={(e) => update({ exitUrl: e.target.value })}
                    />
                  </label>
                  <div className="button-row">
                    <button className="button" onClick={exportSettings}>
                      <Download size={16} />
                      Export settings
                    </button>
                    <label className="file-button">
                      <Upload size={16} />
                      Import settings
                      <input
                        type="file"
                        accept="application/json"
                        onChange={async (e) => {
                          try {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            if (f.size > 3_000_000) throw Error();
                            const data = JSON.parse(await f.text());
                            if (data.version !== 1 || !data.settings)
                              throw Error();
                            update(sanitizeSettings(data.settings));
                            toast("Settings imported.");
                          } catch {
                            toast("Choose a valid Atlas settings export.");
                          }
                        }}
                      />
                    </label>
                  </div>
                </section>
                <section className="setting-card">
                  <h2>Reset and clear data</h2>
                  <div className="setting-row">
                    <div>
                      <h3>Clear browsing history</h3>
                      <p>This leaves your website logins untouched.</p>
                    </div>
                    <button
                      className="button"
                      onClick={() => {
                        localStorage.removeItem("atlas.history");
                        toast("Browsing history cleared.");
                      }}
                    >
                      Clear history
                    </button>
                  </div>
                  <div className="setting-row">
                    <div>
                      <h3>Clear website data</h3>
                      <p>Closes browsing tabs and signs you out of websites.</p>
                    </div>
                    <button
                      className="button"
                      onClick={() => {
                        if (
                          confirm(
                            "Close browsing tabs and clear cookies and website storage?",
                          )
                        )
                          clear();
                      }}
                    >
                      Clear website data
                    </button>
                  </div>
                  <div className="setting-row">
                    <span>Reset appearance and preferences</span>
                    <button
                      className="button"
                      onClick={() => {
                        if (confirm("Reset your Atlas preferences?")) {
                          update(defaults);
                          toast("Settings reset.");
                        }
                      }}
                    >
                      Reset settings
                    </button>
                  </div>
                </section>
              </>
            )}
          {query &&
            !/theme|appearance|color|background|wallpaper|motion|blur|dark|light|tab|browser|engine|search|restore|compact|privacy|data|history|title|export|import|clear|exit/.test(
              query.toLowerCase(),
            ) && (
              <div className="empty-state">
                <h2>No settings found</h2>
                <p>Try “theme”, “tabs”, or “history”.</p>
              </div>
            )}
        </div>
      </div>
      <footer className="page-footer">
        Preferences are saved on this device.
        <span>
          <a href="/source/atlas-source.tar.gz" download>
            Source code <ArrowUpRight size={12} />
          </a>
        </span>
      </footer>
    </div>
  );
}
