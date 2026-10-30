import { createHash } from "node:crypto";
import { HTTP_ENGINE_ROTATION_SHA256 } from "./runtime-relay-rotation.mjs";

export const HTTP_ENGINE_LIFECYCLE_SHA256 =
  "d6d093c97f48da92a5aca3b045472439765eda7e6c68be59a21edfc420139191";

/** Source-distributed adaptation of the exact, already-rotated transport COPY.
 * Upstream/vendor bytes remain unchanged. Request identity, not a recycled C
 * pointer or timer, owns cleanup. The HTTP wire protocol/pool is unchanged. */
export function adaptHttpEngineLifecycle(bytes) {
  if (createHash("sha256").update(bytes).digest("hex") !== HTTP_ENGINE_ROTATION_SHA256)
    throw Error("HTTP lifecycle requires the qualified post-rotation artifact.");
  let source = bytes.toString();
  const replace = (before, after) => {
    if (source.split(before).length !== 2)
      throw Error("HTTP lifecycle adaptation anchor changed.");
    source = source.replace(before, after);
  };
  replace("      this.to_remove = [];", `      this.to_remove = [];
      this.atlasRequests = new Map();
      this.atlasClosed = false;
      this.atlasCloseScheduled = false;`);
  replace(`      if (!this.session_ptr) {
        throw new Error("session has been removed");
      }`, `      if (!this.session_ptr || this.atlasClosed || this.atlasCloseScheduled) {
        throw new Error("session has been removed");
      }`);
  const callbacksStart = source.indexOf("    end_callback(request_id, error) {");
  const callbacksEnd = source.indexOf("    create_request(url,", callbacksStart);
  if (callbacksStart < 0 || callbacksEnd < 0) throw Error("HTTP callback seam missing.");
  replace(source.slice(callbacksStart, callbacksEnd), `    end_callback(request_id, error) {
      const callbacks = this.request_callbacks[request_id];
      if (!callbacks) return;
      delete this.request_callbacks[request_id];
      const owner = callbacks.atlasOwner;
      if (owner && owner.active) { owner.active = false; this.active_requests--; }
      callbacks.end(error);
    }
    data_callback(request_id, chunk_ptr, chunk_size) {
      const callbacks = this.request_callbacks[request_id];
      if (!callbacks || callbacks.atlasTerminal?.()) return;
      const chunk = new Uint8Array(Module.HEAPU8.subarray(chunk_ptr, chunk_ptr + chunk_size));
      callbacks.data(chunk);
    }
    headers_callback(request_id, chunk_ptr, chunk_size) {
      const callbacks = this.request_callbacks[request_id];
      if (!callbacks || callbacks.atlasTerminal?.()) return;
      const chunk = new Uint8Array(Module.HEAPU8.subarray(chunk_ptr, chunk_ptr + chunk_size));
      callbacks.headers(chunk);
    }
`);
  replace(`      return request_ptr;
    }
    remove_request_now(request_ptr) {`, `      const callbacks = this.request_callbacks[request_id];
      const owner = { handle: request_ptr, id: request_id, callbacks, active: false, scheduled: false };
      callbacks.atlasOwner = owner;
      this.atlasRequests.set(request_ptr, owner);
      return request_ptr;
    }
    remove_request_now(request_ptr) {`);
  const lifecycleStart = source.indexOf("    remove_request_now(request_ptr) {");
  const lifecycleEnd = source.indexOf("    //wrap request callbacks", lifecycleStart);
  if (lifecycleStart < 0 || lifecycleEnd < 0) throw Error("HTTP removal seam missing.");
  replace(source.slice(lifecycleStart, lifecycleEnd), `    remove_request_now(request_ptr) {
      const owner = this.atlasRequests.get(request_ptr);
      if (!owner) return;
      // Remove ownership BEFORE native callbacks can reenter removal. A later
      // timer checks this exact object, never just the malloc-reused pointer.
      this.atlasRequests.delete(request_ptr);
      const index = this.requests_list.indexOf(request_ptr);
      if (index !== -1) this.requests_list.splice(index, 1);
      try {
        if (this.session_ptr) _session_remove_request(this.session_ptr, request_ptr);
        _request_cleanup(request_ptr);
      } finally {
        if (this.request_callbacks[owner.id] === owner.callbacks)
          delete this.request_callbacks[owner.id];
        if (owner.active) { owner.active = false; this.active_requests--; }
        if (!this.active_requests && !this.requests_list.length) {
          clearInterval(this.event_loop); this.event_loop = null;
        }
      }
    }
    remove_request(request_ptr) {
      const owner = this.atlasRequests.get(request_ptr);
      if (!owner || owner.scheduled) return;
      owner.scheduled = true;
      setTimeout(() => {
        if (this.atlasRequests.get(request_ptr) === owner)
          this.remove_request_now(request_ptr);
      }, 1);
    }
    start_request(request_ptr) {
      this.assert_ready();
      const owner = this.atlasRequests.get(request_ptr);
      if (!owner || owner.active) throw new Error("request is not pending");
      // Native perform can finish synchronously. Publish accounting first.
      owner.active = true;
      this.active_requests++;
      this.requests_list.push(request_ptr);
      _session_add_request(this.session_ptr, request_ptr);
      _session_perform(this.session_ptr);
      if (this.event_loop || this.atlasClosed) return;
      this.event_loop = setInterval(() => this.event_loop_func(), 0);
    }
    event_loop_func() {
      if (!this.session_ptr || this.atlasClosed) {
        clearInterval(this.event_loop); this.event_loop = null; return;
      }
      if (_session_get_active(this.session_ptr) || this.active_requests)
        _session_perform(this.session_ptr);
      else { clearInterval(this.event_loop); this.event_loop = null; }
    }
    close_now() {
      if (!this.session_ptr || this.atlasClosed) return;
      this.atlasClosed = true;
      clearInterval(this.event_loop); this.event_loop = null;
      // A mutating for-of over requests_list skips every second request.
      for (const owner of [...this.atlasRequests.values()]) {
        owner.callbacks.atlasCancel?.();
        if (this.atlasRequests.get(owner.handle) === owner)
          this.remove_request_now(owner.handle);
      }
      _session_cleanup(this.session_ptr);
      this.session_ptr = null;
      Module.removeFunction(this.end_callback_ptr);
      Module.removeFunction(this.headers_callback_ptr);
      Module.removeFunction(this.data_callback_ptr);
    }
    close() {
      if (!this.session_ptr || this.atlasClosed || this.atlasCloseScheduled) return;
      this.atlasCloseScheduled = true;
      const pointer = this.session_ptr;
      setTimeout(() => { if (this.session_ptr === pointer) this.close_now(); }, 1);
    }
`);
  const streamStart = source.indexOf("    stream_response(url, headers_callback, end_callback, abort_signal) {");
  const streamEnd = source.indexOf("\n  class HTTPSession", streamStart);
  if (streamStart < 0 || streamEnd < 0) throw Error("HTTP stream seam missing.");
  // Keep the class closing brace in the replacement. Early final-header delivery
  // is deliberately separate: changing it requires interim/redirect policy.
  replace(source.slice(streamStart, streamEnd), `    stream_response(url, headers_callback, end_callback, abort_signal) {
      let output, terminal = false, headersReceived = false;
      const detach = () => abort_signal?.removeEventListener("abort", abort);
      const finish = (code) => {
        if (terminal) return;
        terminal = true;
        detach();
        if (code === 0) {
          if (!headersReceived) { headersReceived = true; headers_callback(stream); }
          try { output.close(); } catch {}
        } else {
          const error = code === -1
            ? new DOMException("The operation was aborted.", "AbortError")
            : new TypeError("HTTP transport failed: " + code);
          try { output.error(error); } catch {}
        }
        end_callback(code);
      };
      const abort = () => finish(-1);
      const stream = new ReadableStream({
        start(controller) { output = controller; },
        cancel() { finish(-1); }
      });
      const requestId = this.last_request_id;
      const handle = this.create_request(url, (chunk) => {
        if (terminal) return;
        if (!headersReceived) {
          headersReceived = true;
          headers_callback(stream);
        }
        if (terminal) return;
        try { output.enqueue(chunk); } catch { finish(-1); }
      }, finish, () => {});
      const callbacks = this.request_callbacks[requestId];
      callbacks.atlasCancel = abort;
      callbacks.atlasTerminal = () => terminal;
      abort_signal?.addEventListener("abort", abort, { once: true });
      // request_async assigns/options/starts handle after this method returns.
      // An already-aborted signal must not finalize against its null handle.
      if (abort_signal?.aborted) queueMicrotask(abort);
      return handle;
    }
  }`);
  replace(`reject(new DOMException("The operation was aborted."));`, `reject(new DOMException("The operation was aborted.", "AbortError"));`);
  const headersStart = source.indexOf("        let headers_callback = (stream) => {");
  const headersEnd = source.indexOf("        let finish_callback = (error) => {", headersStart);
  if (headersStart < 0 || headersEnd < 0) throw Error("HTTP response seam missing.");
  replace(source.slice(headersStart, headersEnd), `        let headers_callback = (stream) => {
          if (http_handle === null) return false;
          try {
            const response_json = c_func_str(_http_get_info, [http_handle]);
            const response = this.constructor.create_response(stream, JSON.parse(response_json));
            if (params.redirect === "error" && response.status >= 300 && response.status < 400) {
              finish_callback(-2); return false;
            }
            resolve(response);
            return true;
          } catch (error) {
            // Reject the original metadata/construction failure, then dispose.
            // It must not escape a native callback or leave a pending promise.
            reject(error); finish_callback(-1); return false;
          }
        };
`);
  replace(`if (response_info.status === 204 || response_info.status === 205) {`,
    `if (response_info.status === 204 || response_info.status === 205 || response_info.status === 304) {`);
  const result = Buffer.from(source);
  if (createHash("sha256").update(result).digest("hex") !== HTTP_ENGINE_LIFECYCLE_SHA256)
    throw Error("Adapted HTTP lifecycle hash differs from the qualified artifact: " + createHash("sha256").update(result).digest("hex"));
  return result;
}
