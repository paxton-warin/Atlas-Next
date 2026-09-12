import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Globe2, Search } from "lucide-react";
import { api } from "./model";
import { searchShortcutLabel } from "../../runtime/browser-shortcuts";

// Atlas's existing suggestions provider is called through the current frontend origin.
export default function SearchBox({
  value,
  change,
  submit,
  enabled,
  toolbar = false,
}: {
  value: string;
  change: (value: string) => void;
  submit: (value: string) => void;
  enabled: boolean;
  toolbar?: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [result, setResult] = useState<{ query: string; values: string[] }>({
    query: "",
    values: [],
  });
  const [active, setActive] = useState(-1);
  const query = value.trim();
  const eligible =
    enabled &&
    focused &&
    !composing &&
    !dismissed &&
    query.length >= 2 &&
    query.length <= 120 &&
    !/[\/\\@?#=]|^[a-z][a-z0-9+.-]*:|^\S+\.\S+$|[\x00-\x1f]/i.test(query);
  const suggestions = eligible && result.query === query ? result.values : [];
  const open = suggestions.length > 0;
  useEffect(() => {
    setActive(-1);
    setResult({ query: "", values: [] });
    if (!eligible) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const body = await api<{ suggestions: unknown }>(
          "/search/suggestions",
          {
            method: "POST",
            body: JSON.stringify({ q: query }),
            signal: controller.signal,
          },
        );
        if (!controller.signal.aborted && Array.isArray(body.suggestions))
          setResult({
            query,
            values: [
              ...new Set(
                body.suggestions
                  .filter((v): v is string => typeof v === "string")
                  .map((v) => v.trim().slice(0, 160))
                  .filter(Boolean),
              ),
            ].slice(0, 5),
          });
      } catch {
        /* Suggestion failure never interrupts navigation. */
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, eligible]);
  function choose(text: string) {
    setDismissed(true);
    setActive(-1);
    input.current?.blur();
    submit(text);
  }
  return (
    <form
      className={(toolbar ? "address-bar" : "hero-search") + " search-combobox"}
      onSubmit={(e) => {
        e.preventDefault();
        if (!composing)
          choose(open && active >= 0 ? suggestions[active] : value);
      }}
    >
      {toolbar ? <Globe2 size={14} /> : <Search size={21} />}
      <input
        ref={input}
        id={toolbar ? "omnibox" : undefined}
        aria-label={toolbar ? "Address bar" : "Search the web"}
        aria-keyshortcuts="Meta+K Control+K"
        role="combobox"
        aria-autocomplete={enabled ? "list" : "none"}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={
          open && active >= 0 ? `${id}-${active}` : undefined
        }
        autoComplete="off"
        spellCheck={false}
        placeholder="Search or enter a URL"
        value={value}
        onChange={(e) => {
          change(e.target.value);
          setActive(-1);
          setDismissed(false);
        }}
        onFocus={() => {
          setFocused(true);
          setDismissed(false);
        }}
        onBlur={() => setFocused(false)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || composing || e.keyCode === 229) {
            if (e.key === "Enter") e.preventDefault();
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setDismissed(true);
            setActive(-1);
          }
          if (open && ["ArrowDown", "ArrowUp"].includes(e.key)) {
            e.preventDefault();
            setActive((i) =>
              e.key === "ArrowDown"
                ? (i + 1) % suggestions.length
                : i <= 0
                  ? suggestions.length - 1
                  : i - 1,
            );
          }
        }}
      />
      {toolbar ? (
        <kbd>{searchShortcutLabel()}</kbd>
      ) : (
        <button aria-label="Search" type="submit">
          <ArrowUpRight size={20} />
        </button>
      )}
      {open && (
        <div
          className="search-suggestions"
          id={id}
          role="listbox"
          aria-label="Search suggestions"
        >
          {suggestions.map((suggestion, i) => (
            <button
              type="button"
              role="option"
              tabIndex={-1}
              id={`${id}-${i}`}
              key={suggestion}
              aria-selected={active === i}
              onPointerDown={(e) => e.preventDefault()}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(suggestion)}
            >
              <Search size={15} />
              <span>{suggestion}</span>
              <ArrowUpRight size={14} />
            </button>
          ))}
        </div>
      )}
    </form>
  );
}
