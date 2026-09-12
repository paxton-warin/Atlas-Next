import { useEffect, useId, useRef, useState } from "react";
import {
  captureShortcut,
  formatShortcut,
  mainKeys,
  modifiers,
  normalizeShortcut,
  shortcutWarnings,
} from "../../runtime/panic-shortcut";

export default function PanicShortcut({
  value,
  change,
}: {
  value: string;
  change: (value: string) => void;
}) {
  const [pending, setPending] = useState("");
  const id = useId();
  const [selected, setSelected] = useState<string[]>([]);
  const [mainKey, setMainKey] = useState("Escape");
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const request = (candidate: string) => {
    const key = normalizeShortcut(candidate);
    if (!key || key === value) return;
    if (shortcutWarnings(key).length) setPending(key);
    else change(key);
  };
  useEffect(() => {
    if (!pending) return;
    const prior = document.activeElement as HTMLElement | null;
    const el = dialog.current!;
    el.showModal();
    cancel.current?.focus();
    return () => {
      el.close();
      if (prior?.isConnected) prior.focus();
    };
  }, [pending]);
  return (
    <div className="panic-editor" data-panic-editor>
      <label className="form-field">
        Panic key
        <input
          readOnly
          value={formatShortcut(value)}
          placeholder="Click and press keys, e.g. Cmd + Esc"
          onKeyDown={(e) => {
            if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey)
              return;
            e.preventDefault();
            e.stopPropagation();
            if (
              ["Backspace", "Delete"].includes(e.key) &&
              !e.metaKey &&
              !e.ctrlKey &&
              !e.altKey &&
              !e.shiftKey
            ) {
              change("");
              return;
            }
            const key = captureShortcut(e.nativeEvent);
            if (key) request(key);
          }}
        />
      </label>
      <p className="small muted">
        Hold Cmd, Ctrl, Alt, or Shift and press another key. Panic runs outside
        text fields. Backspace or Delete clears this field.
      </p>
      <details className="panic-picker">
        <summary>Choose keys manually</summary>
        <p className="small muted">
          Use this if a browser shortcut opens a tab or menu instead of being
          recorded.
        </p>
        <div
          className="panic-modifiers"
          role="group"
          aria-label="Shortcut modifiers"
        >
          {modifiers.map((mod) => (
            <button
              key={mod}
              type="button"
              className="button"
              aria-label={`Modifier ${mod === "Meta" ? "Cmd" : mod}`}
              aria-pressed={selected.includes(mod)}
              onClick={() =>
                setSelected((old) =>
                  old.includes(mod)
                    ? old.filter((m) => m !== mod)
                    : [...old, mod],
                )
              }
            >
              {mod === "Meta" ? "Cmd" : mod === "Alt" ? "Alt / Option" : mod}
            </button>
          ))}
        </div>
        <label className="form-field">
          Main key
          <select
            aria-label="Shortcut main key"
            value={mainKey}
            onChange={(e) => setMainKey(e.target.value)}
          >
            {mainKeys.map((key) => (
              <option key={key} value={key}>
                {formatShortcut(key)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button"
          onClick={() => request([...selected, mainKey].join("+"))}
        >
          Use shortcut
        </button>
      </details>
      <p className="small muted">
        Browser, system, and custom keyboard shortcuts can take priority. Test
        your choice on this device; function keys may also need Fn.
      </p>
      <button
        type="button"
        className="text-button"
        disabled={!value}
        onClick={() => change("")}
      >
        Clear panic key
      </button>
      <dialog
        ref={dialog}
        className="panic-confirmation"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-reasons`}
        onCancel={(e) => {
          e.preventDefault();
          setPending("");
        }}
      >
        <h2 id={`${id}-title`}>Use this panic shortcut?</h2>
        <p>
          <strong>{formatShortcut(pending)}</strong>
        </p>
        <div id={`${id}-reasons`}>
          {shortcutWarnings(pending).map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
        </div>
        <p>Your current shortcut stays unchanged unless you confirm.</p>
        <div className="button-row">
          <button
            ref={cancel}
            type="button"
            className="button"
            onClick={() => setPending("")}
          >
            Choose another
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => {
              change(pending);
              setPending("");
            }}
          >
            Use anyway
          </button>
        </div>
      </dialog>
    </div>
  );
}
