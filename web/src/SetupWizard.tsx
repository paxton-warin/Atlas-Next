import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Leaf } from "lucide-react";
import { Settings } from "./Settings";
import { tabAppearance } from "./tab-presets";
import { formatShortcut } from "../../runtime/panic-shortcut";
import type { Settings as Preferences } from "./model";
const steps = [
  {
    name: "Welcome",
    title: "Welcome to Atlas",
    description:
      "Set up your appearance, browsing preferences, and browser tab.",
  },
  {
    name: "Appearance",
    title: "Appearance",
    description: "Choose your theme, background, and layout density.",
    section: "Appearance",
  },
  {
    name: "Browser",
    title: "Browser preferences",
    description: "Choose your tabs, search, and autocomplete.",
    section: "Browser",
  },
  {
    name: "Tab & icon",
    title: "Tab title & icon",
    description: "Use a preset or upload your own icon and choose a title.",
    section: "Tab & icon",
  },
  {
    name: "Privacy & data",
    title: "Panic key & data",
    description: "Set a panic key and manage your local data.",
    section: "Privacy & data",
  },
  {
    name: "Finish",
    title: "Setup complete",
    description:
      "Review your choices. Everything can be changed later in Settings.",
  },
] as const;
export default function SetupWizard({
  settings,
  update,
  toast,
  notice,
  clear,
  finish,
}: {
  settings: Preferences;
  update: (patch: Partial<Preferences>) => void;
  toast: (message: string) => void;
  notice: string;
  clear: () => void;
  finish: () => void;
}) {
  const [step, setStep] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null),
    body = useRef<HTMLDivElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  const current = steps[step],
    appearance = tabAppearance(settings);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const el = dialog.current!;
    el.showModal();
    heading.current?.focus();
    return () => {
      el.close();
      if (prior?.isConnected) prior.focus();
    };
  }, []);
  useEffect(() => {
    body.current?.scrollTo(0, 0);
    heading.current?.focus();
  }, [step]);
  return (
    <dialog
      ref={dialog}
      className="setup-wizard"
      aria-labelledby="wizard-title"
      onCancel={(e) => e.preventDefault()}
    >
      <div className="setup-header">
        <span className="brand-mark">A</span>
        <strong>Atlas setup</strong>
        <span className="step-count">
          {step + 1} / {steps.length}
        </span>
      </div>
      <nav className="setup-steps" aria-label="Setup steps">
        {steps.map((item, i) => (
          <button
            type="button"
            key={item.name}
            aria-current={i === step ? "step" : undefined}
            onClick={() => setStep(i)}
          >
            <span>{i < step ? <Check size={12} /> : i + 1}</span>
            {item.name}
          </button>
        ))}
      </nav>
      <div ref={body} className="setup-body">
        {step === 0 && (
          <div className="wizard-art">
            <div className="wizard-orbit" />
            <Leaf size={44} />
          </div>
        )}
        <h1 ref={heading} tabIndex={-1} id="wizard-title">
          {current.title}
        </h1>
        <p className="setup-description">{current.description}</p>
        {"section" in current && (
          <Settings
            key={current.section}
            settings={settings}
            update={update}
            toast={toast}
            embeddedSection={current.section}
            clear={clear}
            wizard={() => setStep(0)}
          />
        )}
        {step === 0 && (
          <div className="setup-intro">
            <p>
              Choose light or dark mode, personalize the background, and use
              your browsing preferences.
            </p>
            <p>
              All settings are available in this setup. You can also start with
              defaults and change them later.
            </p>
          </div>
        )}
        {step === steps.length - 1 && (
          <div className="setup-summary">
            <div className="tab-appearance-preview">
              <img src={appearance.icon} width={20} height={20} alt="" />
              <strong>{appearance.title}</strong>
            </div>
            <dl>
              <div>
                <dt>Browsing engine</dt>
                <dd>Atlas</dd>
              </div>
              <div>
                <dt>Tabs</dt>
                <dd>{settings.tabs === "top" ? "Top" : "Sidebar"}</dd>
              </div>
              <div>
                <dt>Autocomplete</dt>
                <dd>{settings.autocomplete ? "On" : "Off"}</dd>
              </div>
              <div>
                <dt>Panic key</dt>
                <dd>{formatShortcut(settings.exitKey) || "Not set"}</dd>
              </div>
              <div>
                <dt>Color mode</dt>
                <dd>{settings.mode}</dd>
              </div>
              <div>
                <dt>Restore tabs</dt>
                <dd>{settings.restore ? "On" : "Off"}</dd>
              </div>
            </dl>
            <p className="muted">Preferences are saved on this device.</p>
          </div>
        )}
      </div>
      {notice && (
        <p className="setup-notice" role="status">
          {notice}
        </p>
      )}
      <footer className="setup-actions">
        <button
          type="button"
          className="text-button"
          onClick={() => (step ? setStep(step - 1) : finish())}
        >
          {step ? (
            <>
              <ArrowLeft size={15} />
              Back
            </>
          ) : (
            "Use defaults"
          )}
        </button>
        {step > 0 && step < steps.length - 1 && (
          <button
            type="button"
            className="text-button setup-skip"
            onClick={finish}
          >
            Finish later
          </button>
        )}
        <button
          type="button"
          className="button primary"
          onClick={() =>
            step === steps.length - 1 ? finish() : setStep(step + 1)
          }
        >
          {step === steps.length - 1 ? "Open Atlas" : "Continue"}
          <ArrowRight size={16} />
        </button>
      </footer>
    </dialog>
  );
}
