/** Transpile-only controller fixtures serve their REAL local dependency closure.
 * New runtime imports must not silently become404s in otherwise valid tests. */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const { buildSync } = createRequire(import.meta.resolve("vite"))("esbuild");
let cipherFixture;
export function compileRuntimeFixture(entries, { externalSpecifiers = [] } = {}) {
  if (!Array.isArray(externalSpecifiers) || externalSpecifiers.length > 16 ||
      externalSpecifiers.some(value => typeof value !== "string" || value.length > 128 ||
        !/^[a-z@][a-z0-9@._/-]*$/i.test(value) || value.split("/").some(part => !part || part === "." || part === "..")))
    throw new TypeError("Invalid explicit fixture external");
  const externals = new Set(externalSpecifiers);
  const modules = new Map(),
    queue = [...entries];
  for (let index = 0; index < queue.length; index++) {
    const name = queue[index];
    if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,80}$/.test(name))
      throw new TypeError("Invalid fixture module");
    if (modules.has(name)) continue;
    if (modules.size >= 64) throw new RangeError("Fixture module limit");
    const raw = readFileSync(
      new URL(`../runtime/${name}.ts`, import.meta.url),
      "utf8",
    );
    const output = ts.transpileModule(raw, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const parsed = ts.createSourceFile(
      name + ".js",
      output,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.JS,
    );
    const edits=[];
    function dependency(value, literal) {
      if(value==='tldts'){
        // A fixed, already-pinned local PSL bundle, never an arbitrary external.
        modules.set('fixture-tldts',readFileSync(new URL('../node_modules/tldts/dist/index.esm.min.js',import.meta.url),'utf8'));
        edits.push({start:literal.getStart(parsed)+1,end:literal.getEnd()-1,text:'./fixture-tldts.js'});
        return;
      }
      if (value === "@noble/ciphers/chacha.js") {
        // Bundle this one already-pinned browser crypto dependency. Do not
        // silently serve arbitrary packages or node_modules traversal paths.
        cipherFixture ??= buildSync({
          entryPoints: [fileURLToPath(import.meta.resolve(value))], bundle: true,
          write: false, format: "esm", platform: "browser", target: "es2022",
          logLevel: "silent",
        }).outputFiles[0].text;
        modules.set("fixture-chacha", cipherFixture);
        edits.push({start:literal.getStart(parsed)+1,end:literal.getEnd()-1,text:"./fixture-chacha.js"});
        return;
      }
      if (externals.has(value)) return;
      if (!/^\.\/[a-z][a-z0-9-]{0,80}\.ts$/.test(value))
        throw new TypeError("Unsupported fixture dependency: " + value);
      queue.push(value.slice(2, -3));
      edits.push({start:literal.getStart(parsed)+1,end:literal.getEnd()-1,text:value.slice(0,-3)+'.js'});
    }
    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        dependency(node.moduleSpecifier.text,node.moduleSpecifier);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      )
        dependency(node.arguments[0].text,node.arguments[0]);
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    let rewritten=output;
    for(const edit of edits.sort((a,b)=>b.start-a.start))
      rewritten=rewritten.slice(0,edit.start)+edit.text+rewritten.slice(edit.end);
    modules.set(name, rewritten);
  }
  return modules;
}
