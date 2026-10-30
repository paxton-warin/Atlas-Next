import {
  forwardRef,
  memo,
  useImperativeHandle,
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
} from "react";
import { ArrowUp, Paperclip, Square } from "lucide-react";
import { readAiComposerState, saveAiComposerState } from "./ai-composer-state";
export type AiComposerHandle = {
  getDraft(): string;
  setDraft(value: string): void;
  focus(): void;
  flushDraft(): boolean;
};
/** Transient typing does not rerender the transcript. The small per-tab draft is
 * account/replica scoped, generation guarded and distinct from the archive. */
export const AiComposer = memo(
  forwardRef<
    AiComposerHandle,
    {
      configured: boolean;
      reading: boolean;
      busy: boolean;
      attachmentCount: number;
      draftKey: string;
      selected: string;
      current(): boolean;
      onDraftFailure(): void;
      onSubmit(): void;
      onAttach(): void;
      onStop(): void;
    }
  >(function AiComposer(
    {
      configured,
      reading,
      busy,
      attachmentCount,
      draftKey,
      selected,
      current,
      onDraftFailure,
      onSubmit,
      onAttach,
      onStop,
    },
    ref,
  ) {
    const [draft, setDraftState] = useState(() => {
      const stored = readAiComposerState(undefined, draftKey);
      return stored.selected === selected ? stored.draft : "";
    });
    const draftRef = useRef(draft),
      selectedRef = useRef(selected),
      input = useRef<HTMLTextAreaElement>(null);
    selectedRef.current = selected;
    const setDraft = (value: string) => {
      draftRef.current = value;
      setDraftState(value);
    };
    const save = () => {
      if (!current()) return false;
      const result = saveAiComposerState(undefined, draftKey, {
        version: 1,
        selected: selectedRef.current,
        draft: draftRef.current,
      });
      if (!result) onDraftFailure();
      return result;
    };
    const saveRef = useRef(save);
    saveRef.current = save;
    useImperativeHandle(
      ref,
      () => ({
        getDraft: () => draftRef.current,
        setDraft,
        focus: () => input.current?.focus(),
        flushDraft: () => saveRef.current(),
      }),
      [],
    );
    useLayoutEffect(() => {
      saveRef.current();
    }, [selected]);
    useEffect(() => {
      const timer = setTimeout(() => saveRef.current(), 250);
      return () => clearTimeout(timer);
    }, [draft]);
    useEffect(() => {
      const flush = () => {
        saveRef.current();
      };
      window.addEventListener("pagehide", flush);
      return () => {
        window.removeEventListener("pagehide", flush);
        flush();
      };
    }, []);
    return (
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <button
          type="button"
          className="chat-attach"
          aria-label="Attach files"
          title="Attach text, code, PDF or DOCX · up to 3 files, 2 MB each"
          disabled={busy || reading}
          onClick={onAttach}
        >
          <Paperclip size={19} />
        </button>
        <textarea
          ref={input}
          aria-label="Message Atlas AI"
          placeholder="Message Atlas AI"
          value={draft}
          maxLength={12000}
          rows={2}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        {busy ? (
          <button type="button" aria-label="Stop reply" onClick={onStop}>
            <Square size={16} />
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send AI message"
            disabled={
              !configured || reading || (!draft.trim() && !attachmentCount)
            }
          >
            <ArrowUp size={18} />
          </button>
        )}
      </form>
    );
  }),
);
