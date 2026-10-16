/** Presentation-only controls installed after native document.open but BEFORE
 * website scripts. The existing guard is reused with risk sampling disabled:
 * dynamic/game detection remains paused, and no body content is inspected. */
import { installDocumentGuard } from "./site-compatibility.ts";
import {
  cleanPageCommand,
  type PageCommand,
  type PageTelemetry,
} from "./page-controls-protocol.ts";

export function installDocumentControls(options: {
  window: Window & typeof globalThis;
  documentId: string;
  documentURL: string;
  liveDocument: () => boolean;
  report: (event: PageTelemetry) => void;
}) {
  const owner = options.window;
  let live = true,
    activated = false,
    metadata = false,
    diagnostics = false;
  const pending = new Map<string, PageTelemetry>();
  function emit(event: PageTelemetry) {
    if (!live || !options.liveDocument()) return;
    if (!activated) {
      pending.set(event.type, event);
      return;
    }
    options.report(event);
  }
  const guard = installDocumentGuard(owner, {
    id: options.documentId,
    pageUrl: () => options.documentURL,
    enabled: () => metadata,
    sampleRisk: false,
    onTitle: (title) => emit({ type: "title", title }),
    report: ({ id: _id, ...status }) =>
      emit({ type: "compatibility-status", ...status }),
  });
  return {
    activate() {
      if (!live || activated || !options.liveDocument()) return;
      activated = true;
      for (const event of pending.values()) options.report(event);
      pending.clear();
    },
    command(input: PageCommand) {
      if (!live || !activated || !options.liveDocument()) return false;
      const command = cleanPageCommand(input);
      if (!command) return false;
      if (command.type === "compatibility-config") {
        metadata = command.metadata;
        diagnostics = command.diagnostics;
        guard.update(metadata);
      } else
        emit({
          type: "compatibility-diagnostics",
          report: { version: 1, active: diagnostics, entries: [] },
        });
      return true;
    },
    dispose() {
      if (!live) return;
      live = false;
      pending.clear();
      guard.dispose();
    },
  };
}
