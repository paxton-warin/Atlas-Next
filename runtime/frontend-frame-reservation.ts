/** Trusted-only physical frame policy reservation. Neither the assignment
 * credential nor this API object crosses an opaque document MessagePort. */
import type { FrontendAssignment } from "./frontend-assignment.ts";
export function createFrontendFrameReservations(options: {
  assignment: () => FrontendAssignment;
  window?: Window & typeof globalThis;
  timeoutMs?: number;
}) {
  const owner = options.window ?? window,
    frontend = owner.location.origin,
    nativeFetch = owner.fetch.bind(owner),
    timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new TypeError("Invalid frame reservation deadline");
  const active = new Map<string, () => void>();
  let live = true;
  return {
    async reserve(input: {
      documentId: string;
      website: string;
      signal: AbortSignal;
    }) {
      if (
        !live ||
        input.signal.aborted ||
        !/^doc_[a-f0-9]{32}$/.test(input.documentId) ||
        active.has(input.documentId)
      )
        throw new TypeError("Invalid frame reservation");
      const assignment = options.assignment();
      if (assignment.frontendOrigin !== frontend || assignment.protocol !== 2)
        throw new TypeError("Frame assignment changed frontend origin");
      const identity = [
        assignment.session,
        assignment.sessionHash,
        assignment.generation,
        assignment.node.id,
        assignment.relayOrigin,
      ].join("\0");
      const payload = JSON.stringify({
        session: assignment.session,
        generation: assignment.generation,
        documentId: input.documentId,
      });
      const controller = new AbortController(),
        abort = () => controller.abort();
      input.signal.addEventListener("abort", abort, { once: true });
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        controller.abort();
        active.delete(input.documentId);
        void nativeFetch("/api/browse/controller/document", {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      };
      active.set(input.documentId, dispose);
      const timer = owner.setTimeout(abort, timeoutMs);
      try {
        const response = await nativeFetch("/api/browse/controller/document", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: payload,
          signal: controller.signal,
          redirect: "error",
          cache: "no-store",
        });
        if (!response.ok) throw new TypeError("Frame reservation failed");
        const text = await response.text();
        if (text.length > 16384)
          throw new TypeError("Invalid frame reservation response");
        const grant = JSON.parse(text),
          current = options.assignment();
        if (
          !live ||
          disposed ||
          input.signal.aborted ||
          identity !==
            [
              current.session,
              current.sessionHash,
              current.generation,
              current.node.id,
              current.relayOrigin,
            ].join("\0") ||
          grant.documentId !== input.documentId ||
          grant.frameURL !== frontend + "/browse/frame/" + input.documentId ||
          grant.resourceOrigin !== assignment.relayOrigin ||
          !/^https:\/\//.test(grant.resourceOrigin) ||
          !Number.isFinite(grant.expiresAt) ||
          grant.expiresAt <= Date.now()
        )
          throw new TypeError("Frame reservation identity changed");
        return {
          frameURL: grant.frameURL as string,
          resourceOrigin: grant.resourceOrigin as string,
          dispose,
        };
      } catch (error) {
        dispose();
        throw error;
      } finally {
        owner.clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
      }
    },
    async reserveRenderer(input: {parentDocumentId:string;scriptHashes:readonly string[]}) {
      if (!live || !active.has(input.parentDocumentId)) throw new TypeError("Renderer parent reservation is stale");
      const assignment = options.assignment(), payload = {session:assignment.session,generation:assignment.generation,documentId:input.parentDocumentId};
      // Refresh the short physical-policy reservation without recreating the
      // document, changing its assignment, or recovering legacy website data.
      const refresh=await nativeFetch("/api/browse/controller/document",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(payload),redirect:"error",cache:"no-store",signal:owner.AbortSignal.timeout(timeoutMs)});
      if(!refresh.ok)throw new TypeError("Renderer parent reservation expired");
      const response=await nativeFetch("/api/browse/controller/renderer",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json","x-atlas-browse-session":assignment.session,"x-atlas-browse-generation":String(assignment.generation)},body:JSON.stringify(input),redirect:"error",cache:"no-store",signal:owner.AbortSignal.timeout(timeoutMs)});
      const text=await response.text(), current=options.assignment();
      if(!response.ok||text.length>16384||!live||!active.has(input.parentDocumentId)||current.sessionHash!==assignment.sessionHash||current.generation!==assignment.generation||current.node.id!==assignment.node.id)throw new TypeError("Renderer parent assignment changed");
      const result=JSON.parse(text);
      if(Object.keys(result).length!==3||typeof result.helperURL!=="string"||typeof result.childId!=="string"||typeof result.secret!=="string")throw new TypeError("Invalid renderer reservation");
      return result as {helperURL:string;childId:string;secret:string};
    },
    dispose() {
      if (!live) return;
      live = false;
      for (const cancel of [...active.values()]) cancel();
    },
  };
}
