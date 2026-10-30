/** Private runtime protocol v1. Embedded into each exact pinned copy at build
 * time. No AbortSignal crosses a structured-clone boundary. A transferred port
 * is the request capability; IDs additionally fence late/duplicate messages.
 * Readable JS intentionally remains source-distributed with its adaptation. */
export function createAtlasRequestCancellation(g = globalThis) {
  const Apply = Reflect.apply, Request = g.Request, Response = g.Response, Headers = g.Headers,
    Stream = g.ReadableStream, Channel = g.MessageChannel, Controller = g.AbortController,
    Exception = g.DOMException, TypeError = g.TypeError, NativeURL = g.URL, Promise = g.Promise,
    get = Object.getOwnPropertyDescriptor, post = g.MessagePort.prototype.postMessage,
    start = g.MessagePort.prototype.start, close = g.MessagePort.prototype.close,
    add = g.EventTarget.prototype.addEventListener, remove = g.EventTarget.prototype.removeEventListener,
    schedule = g.setTimeout.bind(g), unschedule = g.clearTimeout.bind(g),
    uuid = g.crypto.randomUUID.bind(g.crypto), iterator = Symbol.iterator, arrayMap = Array.prototype.map,
    physicalLocation = g.location, locationHref = g.location && get(g.location, 'href')?.get,
    requestURL = get(Request.prototype, 'url').get,
    requestSignal = get(Request.prototype, 'signal').get,
    requestKeepalive = get(Request.prototype, 'keepalive').get, requestHeaders = get(Request.prototype, 'headers').get, requestBody = get(Request.prototype, 'body').get, streamCancel = Stream.prototype.cancel,
    headerForEach = Headers.prototype.forEach, headerGet = Headers.prototype.get,
    swContainer = g.navigator?.serviceWorker, swController = g.ServiceWorkerContainer && get(g.ServiceWorkerContainer.prototype, 'controller')?.get,
    swPost = g.ServiceWorker?.prototype.postMessage,
    signalAborted = get(g.AbortSignal.prototype, 'aborted').get,
    signalReason = get(g.AbortSignal.prototype, 'reason').get,
    prefixKey = '$atlasCancellation', version = 1, generation = uuid();
  const controllers = new WeakMap(), registrations = new Map(), frontend = new Map();
  const stats = { registered: 0, claimed: 0, canceled: 0, finished: 0 };
  let serial = 0;
  const abortError = () => new Exception('Request canceled', 'AbortError');
  const message = (port, data, transfer = []) => Apply(post, port, [data, transfer]);
  const shut = port => { if (port) { try { Apply(close, port, []); } catch {} } };
  const listen = (target, kind, callback) => Apply(add, target, [kind, callback]);
  const unlisten = (target, kind, callback) => Apply(remove, target, [kind, callback]);
  const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
  const validCapability = value => value && value.version === version && validId(value.generation) &&
    typeof value.id === 'string' && value.id.length <= 128 && value.port instanceof g.MessagePort;
  const aborted = signal => Apply(signalAborted, signal, []);
  const reason = signal => Apply(signalReason, signal, []) ?? abortError();
  const dataMatches = (data, identity) => data && data.version === version &&
    data.id === identity.id && data.generation === identity.generation;

  function wrapBody(body, finished, canceled, failed) {
    if (!(body instanceof Stream)) { finished(); return body; }
    const reader = body.getReader(); let ended = false, sink;
    const finish = () => { if (ended) return false; ended = true; finished(); return true; };
    const wrapped = new Stream({
      start(controller) { sink = controller; },
      async pull(controller) {
        try {
          const next = await reader.read();
          if (ended) return;
          if (next.done) { finish(); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) { if (finish()) { failed?.(error); controller.error(error); } }
      },
      cancel(error) {
        if (!finish()) return;
        canceled?.(error);
        return reader.cancel(error).catch(() => {});
      },
    }, { highWaterMark: 0 });
    return { body: wrapped, abort(error) {
      if (!finish()) return;
      try { sink.error(error); } catch {}
      void reader.cancel(error).catch(() => {});
    } };
  }

  async function controllerRequest(owner, raw, frame, run) {
    const identity = raw.atlasCancellation;
    if (!validCapability(identity)) throw new TypeError('Request cancellation protocol mismatch');
    let owners = controllers.get(owner);
    if (!owners) controllers.set(owner, owners = new Set());
    if (owners.size >= 512) { shut(identity.port); throw new TypeError('Request capacity exceeded'); }
    const ac = new Controller(); let live = true, wrapped, upload;
    const record = { prefix: frame?.prefix, cancel() {
      if (!live) return;
      ac.abort(abortError()); wrapped?.abort(abortError()); upload?.abort(abortError()); finish();
    } };
    function finish() {
      if (!live) return;
      live = false; owners.delete(record); identity.port.onmessage = null;
      try { message(identity.port, { version, id: identity.id, generation: identity.generation, type: 'finished' }); } catch {}
      shut(identity.port);
    }
    identity.port.onmessage = event => {
      if (dataMatches(event.data, identity) && event.data.type === 'cancel') record.cancel();
    };
    identity.port.onmessageerror = () => record.cancel();
    Apply(start, identity.port, []); owners.add(record); raw.atlasSignal = ac.signal;
    if (raw.body instanceof Stream) { upload = wrapBody(raw.body, () => {}); raw.body = upload.body; }
    try {
      if (identity.aborted) record.cancel();
      if (aborted(ac.signal)) throw reason(ac.signal);
      let rejectAbort;
      const canceled = new Promise((_, reject) => { rejectAbort = () => reject(reason(ac.signal)); });
      listen(ac.signal, 'abort', rejectAbort);
      const work = Promise.resolve().then(run);
      void work.then(late => {
        if (aborted(ac.signal) && late?.[0]?.body instanceof Stream)
          void late[0].body.cancel(reason(ac.signal)).catch(() => {});
      }, () => {});
      let result;
      try { result = await Promise.race([work, canceled]); }
      finally { unlisten(ac.signal, 'abort', rejectAbort); }
      if (aborted(ac.signal)) throw reason(ac.signal);
      const data = result[0], originalBody = data.body;
      wrapped = wrapBody(originalBody, finish, () => ac.abort(abortError()));
      if (wrapped?.body) {
        data.body = wrapped.body;
        result[1] = (result[1] || []).filter(value => value !== originalBody).concat(wrapped.body);
      }
      return result;
    } catch (error) { upload?.abort(error); finish(); throw error; }
  }

  function abortRequests(owner, prefix) {
    for (const record of [...(controllers.get(owner) || [])])
      if (prefix === undefined || record.prefix === prefix) record.cancel();
  }

  function endRegistration(record) {
    if (!record || registrations.get(record.key) !== record) return;
    registrations.delete(record.key); stats.finished++;
    if (record.timer) unschedule(record.timer);
    record.port.onmessage = null;
    try { message(record.port, { version, id: record.id, generation, type: 'finished' }); } catch {}
    shut(record.port);
  }
  function cancelRegistration(record) {
    if (registrations.get(record.key) !== record) return;
    record.aborted = true; stats.canceled++;
    record.current?.cancel();
    if (!record.current) endRegistration(record);
  }
  function expireRegistration(record) {
    if (record.timer) unschedule(record.timer);
    record.timer = schedule(() => cancelRegistration(record), 10000);
  }

  async function register(event, tabs) {
    const input = event.data?.$atlas$registerFetch;
    if (!input || input.version !== version || !validId(input.id) ||
      !(input.headerOriginal === undefined || input.headerOriginal === null || (typeof input.headerOriginal === 'string' && input.headerOriginal.length <= 16384)) ||
      typeof input.prefix !== 'string' || input.prefix.length > 2048 || !event.ports?.[0]) return;
    const port = event.ports[0], clientId = event.source?.id;
    if (typeof clientId !== 'string') { shut(port); return; }
    const client = await g.clients.get(clientId);
    let prefix, url;
    try { prefix = new NativeURL(input.prefix); url = new NativeURL(client?.url); } catch { shut(port); return; }
    const tab = tabs.find(tab => prefix.pathname.startsWith(tab.prefix) && prefix.pathname !== tab.prefix);
    const suffix = tab && url.pathname.slice(tab.prefix.length), slash = suffix?.indexOf('/'),
      exactPrefix = slash >= 0 ? tab.prefix + suffix.slice(0, slash + 1) : null;
    const key = clientId + ':' + input.id;
    if (!tab || prefix.pathname !== exactPrefix || url.origin !== prefix.origin || !url.pathname.startsWith(prefix.pathname) ||
      registrations.has(key) || registrations.size >= 1024 ||
      [...registrations.values()].filter(record => record.clientId === clientId).length >= 128) {
      try { message(port, { version, id: input.id, generation, type: 'rejected' }); } catch {}
      shut(port); return;
    }
    const record = { key, id: input.id, port, clientId, prefix: prefix.href, headerOriginal: input.headerOriginal, tab, aborted: false, current: null, timer: null };
    registrations.set(key, record); stats.registered++; expireRegistration(record);
    port.onmessage = event => {
      if (!dataMatches(event.data, { id: record.id, generation })) return;
      if (event.data.type === 'cancel') cancelRegistration(record);
      else if (event.data.type === 'settled' && !record.current) endRegistration(record);
    };
    port.onmessageerror = () => cancelRegistration(record);
    Apply(start, port, []);
    message(port, { version, id: record.id, generation, type: 'ready' });
  }

  async function route(event, tab, client) {
    await tab.atlasReady;
    const url = new NativeURL(event.request.url), tag = url.searchParams.get(prefixKey),
      marker = /^text\/plain;atlas-cancel-v1=([a-f0-9-]{36})$/.exec(event.request.headers.get('content-type') || '');
    let registration;
    if (tag?.startsWith('v1.') || marker) {
      if (tag?.startsWith('v1.')) url.searchParams.delete(prefixKey);
      const id = marker?.[1] || tag.slice(3);
      if (marker && tag?.startsWith('v1.') && marker[1] !== tag.slice(3)) return Response.error();
      registration = registrations.get(event.clientId + ':' + id);
      if (!registration || registration.tab !== tab || !url.href.startsWith(registration.prefix) || registration.current)
        return Response.error();
      if (marker && registration.headerOriginal === undefined) return Response.error();
      if (marker && event.request.mode === 'no-cors' && registration.headerOriginal !== null) {
        const value = registration.headerOriginal;
        if (value.length > 128 || /[\x00-\x08\x0a-\x1f\x7f"():<>?@\[\]{}]/.test(value) ||
          !['text/plain','application/x-www-form-urlencoded','multipart/form-data'].includes(value.split(';',1)[0].trim().toLowerCase())) return Response.error();
      }
      if (registration.timer) { unschedule(registration.timer); registration.timer = null; }
    }
    const cleanHeaders = [...event.request.headers];
    if (marker) {
      const index = cleanHeaders.findIndex(([name]) => name.toLowerCase() === 'content-type');
      if (index >= 0) cleanHeaders.splice(index,1);
      if (registration.headerOriginal !== null) cleanHeaders.push(['content-type', registration.headerOriginal]);
    }
    const channel = new Channel(), identity = { version, generation, id: String(++serial), port: channel.port2,
      aborted: registration?.aborted || event.request.signal.aborted };
    let live = true, bodyWrapper;
    const link = { cancel() {
      if (!live) return;
      try { message(channel.port1, { version, generation, id: identity.id, type: 'cancel' }); } catch {}
      bodyWrapper?.abort(abortError()); finish(true);
    } };
    function finish(terminal) {
      if (!live) return;
      live = false; unlisten(event.request.signal, 'abort', link.cancel); shut(channel.port1);
      if (registration?.current === link) { registration.current = null; if (terminal) endRegistration(registration); }
    }
    if (registration) { registration.current = link; stats.claimed++; }
    listen(event.request.signal, 'abort', link.cancel);
    try {
      const body = event.request.body, transfers = [channel.port2];
      if (body instanceof Stream || body instanceof ArrayBuffer) transfers.push(body);
      const response = await tab.rpc.call('request', {
        rawUrl: url.href, rawReferrer: event.request.referrer, destination: event.request.destination,
        mode: event.request.mode, referrer: event.request.referrer, method: event.request.method,
        body, cache: event.request.cache, forceCrossOriginIsolated: false,
        initialHeaders: cleanHeaders, rawClientUrl: client?.url,
        clientId: event.clientId || event.resultingClientId, atlasCancellation: identity,
      }, transfers);
      if (registration?.aborted || event.request.signal.aborted) { link.cancel(); return Response.error(); }
      const headers = response.headers.map(pair => [...pair]);
      const location = headers.find(pair => pair[0].toLowerCase() === 'location');
      const redirect = registration && [301,302,303,307,308].includes(response.status) && location;
      let carriesRegistration = false;
      if (redirect) {
        const target = new NativeURL(location[1], url);
        if (target.href.startsWith(registration.prefix)) {
          target.searchParams.set(prefixKey, 'v1.' + registration.id); location[1] = target.href;
          carriesRegistration = true;
        }
      }
      if (carriesRegistration) {
        finish(false); expireRegistration(registration);
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }
      bodyWrapper = wrapBody(response.body, () => finish(true), () => link.cancel());
      return new Response(bodyWrapper?.body ?? bodyWrapper, { status: response.status, statusText: response.statusText, headers });
    } catch (error) { link.cancel(); throw error; }
  }

  function resetRPC(rpc) {
    for (const callback of rpc?.promiseCallbacks?.values() || []) {
      try { callback.reject(new TypeError('Controller connection replaced')); } catch {}
    }
    rpc?.promiseCallbacks?.clear();
  }
  function cleanupReference(tab) {
    for (const record of [...registrations.values()]) if (record.tab === tab) cancelRegistration(record);
    resetRPC(tab.rpc); shut(tab.atlasPort);
  }
  function acceptControllerInit(event, tabs) {
    const input = event.data?.$controller$init, sourceId = event.source?.id;
    if (!input || typeof sourceId !== 'string' || typeof input.id !== 'string' || !input.id || input.id.length > 128 ||
        typeof input.prefix !== 'string' || input.prefix.length > 2048 || !validId(input.generation) || !event.ports?.[0]) return false;
    let prefix, source;
    try { prefix = new NativeURL(input.prefix, g.location.href); source = new NativeURL(event.source.url); } catch { return false; }
    if (prefix.origin !== g.location.origin || source.origin !== prefix.origin || prefix.search || prefix.hash ||
        !prefix.pathname.endsWith('/' + input.id + '/')) return false;
    const base = prefix.pathname.slice(0, -input.id.length - 1);
    // Controller hosts sit outside the rewritten website subtree. A website in
    // one root cannot replace another root's reference by copying visible IDs.
    if (base !== '/' && source.pathname.startsWith(base)) return false;
    const prior = tabs.find(tab => tab.id === input.id);
    return !prior || prior.atlasSourceClient === sourceId;
  }
  function disposeReference(event, tabs) {
    const input = event.data?.$controller$dispose;
    if (!input || !validId(input.generation)) return;
    const index = tabs.findIndex(tab => tab.id === input.id && tab.atlasGeneration === input.generation &&
      tab.atlasSourceClient === event.source?.id);
    if (index < 0) return;
    cleanupReference(tabs[index]); tabs.splice(index, 1);
  }

  function clientFetch(ctx, prefix) {
    // A URL-only call has no caller AbortSignal. Body cancel and frame disposal
    // still have the independent SW/controller request capability.
    const input = ctx.args[0], init = ctx.args[1];
    // Inherited blank/srcdoc contexts need a delegated frame capability. Keep
    // their existing native path until that boundary is qualified, rather than
    // accepting a website-supplied prefix as ownership proof.
    if (physicalLocation && !(locationHref ? Apply(locationHref, physicalLocation, []) : physicalLocation.href).startsWith(prefix)) return;
    if (typeof input === 'string' && init == null) return;
    const id = uuid(); let request, signal, url, keepalive, headerOriginal;
    try {
      if (typeof input === 'string') {
        url = new NativeURL(input);
        if (!url.href.startsWith(prefix)) return;
        url.searchParams.set(prefixKey, 'v1.' + id);
        // Only ONE RequestInit dictionary conversion. Native fetch subsequently
        // consumes this Request's internal body/source/keepalive slots normally.
        request = new Request(url.href, init);
      } else {
        url = new NativeURL(Apply(requestURL, input, []));
        if (!url.href.startsWith(prefix)) return;
        const headers = Apply(requestHeaders, input, []), pairs = [];
        headerOriginal = Apply(headerGet, headers, ['content-type']);
        if (headerOriginal !== null && headerOriginal.length > 16384)
          throw new TypeError('Request metadata exceeds its allowance');
        Apply(headerForEach, headers, [(value, name) => {
          if (name.toLowerCase() !== 'content-type') pairs.push([name, value]);
        }]);
        pairs.push(['content-type', 'text/plain;atlas-cancel-v1=' + id]);
        // Private iterators avoid invoking website-overridden collection
        // prototypes during this extra, otherwise script-free native clone.
        const sequence = values => ({ [iterator]() {
          let index = 0; return { next() { return index < values.length
            ? { done: false, value: values[index++] } : { done: true }; } };
        } });
        request = new Request(input, { headers: sequence(Apply(arrayMap, pairs, [sequence])) });
      }
      signal = Apply(requestSignal, request, []);
      keepalive = Apply(requestKeepalive, request, []);
      if (aborted(signal)) { ctx.args = [request]; ctx.return(ctx.call()); return; }
    } catch (error) { ctx.return(Promise.reject(error)); return; }
    if (frontend.size >= 128) { ctx.return(Promise.reject(new TypeError('Request capacity exceeded'))); return; }
    const worker = swContainer && (swController ? Apply(swController, swContainer, []) : swContainer.controller);
    if (!worker) { ctx.return(Promise.reject(new TypeError('Request cancellation protocol unavailable'))); return; }
    const channel = new Channel(), port = channel.port1;
    let swGeneration, live = true, timer, readyResolve, readyReject, invokeStarted = false;
    ctx.args = [request];
    const invoke = () => { invokeStarted = true; return ctx.call(); };
    const cancelUnstartedBody = error => {
      if (invokeStarted) return;
      const body = Apply(requestBody, request, []);
      if (body) void Apply(streamCancel, body, [error]).catch(() => {});
    };
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const record = { keepalive, cancel(error) {
      if (!live) return;
      if (aborted(signal) && !invokeStarted) {
        // Run native fetch's already-aborted algorithm so its own producer/body
        // cancellation and exact caller reason stay native, without a request.
        try { void Promise.resolve(invoke()).catch(() => {}); } catch {}
      } else if (error !== undefined) cancelUnstartedBody(error);
      if (swGeneration) { try { message(port, { version, id, generation: swGeneration, type: 'cancel' }); } catch {} }
      readyReject(error === undefined ? reason(signal) : error);
    } };
    const onAbort = () => record.cancel();
    function finish(error) {
      if (!live) return;
      if (error !== undefined) { cancelUnstartedBody(error); readyReject(error); }
      live = false; frontend.delete(id);
      if (timer) unschedule(timer); unlisten(signal, 'abort', onAbort); port.onmessage = null; shut(port);
    }
    frontend.set(id, record); listen(signal, 'abort', onAbort);
    port.onmessage = event => {
      const data = event.data;
      if (!data || data.version !== version || data.id !== id || !validId(data.generation)) return;
      if (data.type === 'ready') {
        swGeneration = data.generation; if (timer) { unschedule(timer); timer = null; }
        if (aborted(signal)) { record.cancel(); finish(); } else readyResolve();
      } else if (data.type === 'rejected') { finish(new TypeError('Request capacity exceeded')); }
      else if (data.type === 'finished') finish();
    };
    port.onmessageerror = () => { finish(new TypeError('Request cancellation channel failed')); };
    Apply(start, port, []);
    timer = schedule(() => { record.cancel(new TypeError('Request cancellation protocol unavailable')); finish(); }, 5000);
    try { Apply(swPost, worker, [{ $atlas$registerFetch: { version, id, prefix, headerOriginal } }, [channel.port2]]); }
    catch (error) { finish(error); }
    ctx.return((async () => {
      try {
        await ready;
        if (aborted(signal)) throw reason(signal);
        const response = await invoke();
        if (live && swGeneration) message(port, { version, id, generation: swGeneration, type: 'settled' });
        return response;
      } catch (error) { record.cancel(); if (swGeneration) finish(); throw error; }
    })());
  }

  return { controllerRequest, abortRequests, register, route, cleanupReference, acceptControllerInit, disposeReference, resetRPC, clientFetch,
    channelGeneration: () => uuid(),
    fork: target => createAtlasRequestCancellation(target),
    controllerCount: owner => controllers.get(owner)?.size || 0,
    swStats: () => ({ ...stats, live: registrations.size }), frontendCount: () => frontend.size };
}
