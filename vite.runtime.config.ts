import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
export default defineConfig({
  root: "runtime",
  define: {
    __RUNTIME_REVISION__: JSON.stringify(
      JSON.parse(readFileSync("scripts/runtime-fork.json", "utf8")).commit,
    ),
  },
  build: { outDir: "../dist/runtime", emptyOutDir: true },
  optimizeDeps: { exclude: ["@mercuryworkshop/libcurl-transport"] },
});
