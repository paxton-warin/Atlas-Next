/** Compiler operands belong to the executing script's lexical environment, not
 * the website's ambient capability namespace. A worker may legitimately remove
 * its browser globals and freeze globalThis (e.g. an expression evaluator).
 * These bindings do not restore a removed browser API or bypass that cleanup. */
export const compilerBindingNames = [
  "$runtimekit$wrap", "$runtimekit$prop", "$runtimekit$clean",
  "$runtimekit$import", "$runtimekit$rewrite", "$runtimekit$meta",
  "$runtimekit$wrappostmessage", "$runtimekit$pushsourcemap", "$runtimekit$tryset",
] as const;

const bindings = compilerBindingNames.map(name => `${name}=globalThis[${JSON.stringify(name)}]`).join(",");
export const compilerBindingModule = "data:text/javascript;charset=utf-8," +
  encodeURIComponent(`export const ${bindings};`);
export const compilerBindingImport = `import {${compilerBindingNames.join(",")}} from ${JSON.stringify(compilerBindingModule)};\n`;
export const compilerBindingClassic = `let ${bindings};\n`;

/** Insert a compiler prelude after the program's directive prologue, preserving
 * strict eval semantics and the native completion value. No source executes
 * during this scan. Comments, escaped literals, ASI and hashbangs are retained. */
export function afterDirectives(source: string, prelude: string) {
  let position = source.startsWith("#!") ? (source.indexOf("\n") < 0 ? source.length : source.indexOf("\n") + 1) : 0;
  const trivia = (start: number) => {
    let i = start, newline = false;
    while (i < source.length) {
      if (/\s/.test(source[i])) { newline ||= /[\r\n\u2028\u2029]/.test(source[i]); i++; }
      else if (source.startsWith("//", i)) { const end = source.indexOf("\n", i + 2); i = end < 0 ? source.length : end; }
      else if (source.startsWith("/*", i)) { const end = source.indexOf("*/", i + 2); if (end < 0) return { i: source.length, newline }; newline ||= /[\r\n\u2028\u2029]/.test(source.slice(i, end)); i = end + 2; }
      else break;
    }
    return { i, newline };
  };
  while (true) {
    const start = trivia(position).i, quote = source[start];
    if (quote !== '"' && quote !== "'") break;
    let end = start + 1;
    for (; end < source.length; end++) {
      if (source[end] === "\\") end++;
      else if (source[end] === quote) break;
      else if (/[\r\n\u2028\u2029]/.test(source[end])) break;
    }
    if (source[end] !== quote) break;
    const next = trivia(end + 1);
    const tail = source.slice(next.i);
    const continues = /^(?:[([.`*/%<>=&|^?:,]|\+(?!\+)|-(?!-)|!=|in\b|instanceof\b)/.test(tail);
    if (source[next.i] === ";") position = next.i + 1;
    else if (next.i === source.length || (next.newline && !continues)) position = end + 1;
    else break;
  }
  return source.slice(0, position) + "\n" + prelude + "\n" + source.slice(position);
}

/** Dynamic Function has no caller lexical scope. Capture the same compiler
 * operands in an outer factory, while preserving the native constructor's
 * parameter parsing and the returned function's own parameters/strictness.
 * This is worker-only. Native imports still pass through the logical-origin
 * rewriter; no raw Function constructor is returned to website code. */
export function installWorkerFunctionBindings(owner: any, core: any, client: any) {
  const NativeFunction = client.natives.store.Function;
  const NativeString = client.natives.store["Function.prototype.toString"];
  // Worker locations cannot navigate. Runtime bookkeeping must not repeatedly
  // consult a browser global that the worker is entitled to delete.
  const NativeURL = owner.URL, workerURL = client.url.href;
  Object.defineProperty(client, "url", { configurable: true, get: () => new NativeURL(workerURL) });
  const apply = Reflect.apply, construct = Reflect.construct, define = Object.defineProperty;
  const prototype = Object.getPrototypeOf, setPrototype = Object.setPrototypeOf;
  const values = compilerBindingNames.map(name => owner[name]);
  const meta = { origin: client.meta.origin, base: client.meta.base };
  const context = client.context;
  // Compile the pinned rewriter in trusted bootstrap, not during arbitrary
  // website callbacks after a worker has removed its WebAssembly capability.
  const [, release] = core.getRewriter(context, meta);
  release();
  const originalIndirect = client.indirectEval, NativeEval = client.natives.store.eval;
  const indirectPrelude = `const [${compilerBindingNames.join(",")}]=this.Function(${JSON.stringify("return [" + compilerBindingNames.join(",") + "]")})();`;
  client.indirectEval = new Proxy(NativeEval, { apply(_target, _that, args) {
    if (typeof args[0] !== "string" || owner[compilerBindingNames[0]] === values[0])
      return apply(originalIndirect, undefined, args);
    const rewritten = core.transformJs(args[0], "(worker indirect eval)", context, meta);
    // This remains a native INDIRECT eval, not an eval inside a function:
    // global var declarations, strictness and completion values stay native.
    return apply(NativeEval, undefined, [afterDirectives(rewritten, indirectPrelude)]);
  } });
  const constructors = [
    NativeFunction,
    NativeFunction("return async function(){}")(),
    NativeFunction("return function*(){}")(),
    NativeFunction("return async function*(){}")(),
  ].map((value, index) => index ? Object.getPrototypeOf(value).constructor : value)
    .map(value => client.box.unproxy.get(value) ?? value);
  for (const native of constructors) {
    const create = (args: any[], newTarget?: any) => {
      const parsed = newTarget ? construct(native, args, newTarget) : apply(native, undefined, args);
      const source = apply(NativeString, parsed, []);
      const rewritten = core.transformJs(`return ${source}`, "(worker function proxy)", context, meta);
      const result = apply(apply(NativeFunction, undefined, [...compilerBindingNames, rewritten]), undefined, values);
      if (prototype(result) !== prototype(parsed)) setPrototype(result, prototype(parsed));
      return result;
    };
    const proxy: any = new Proxy(native, {
      apply(_target, _this, args) { return create(args); },
      construct(_target, args, newTarget) { return create(args, newTarget === proxy ? native : newTarget); },
    });
    client.box.unproxy.set(proxy, native);
    define(native.prototype, "constructor", { configurable: true, writable: true, value: proxy });
    if (native === NativeFunction) define(owner, "Function", { configurable: true, writable: true, value: proxy });
  }
}
