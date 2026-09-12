import { defineConfig } from "vite";
export default defineConfig({
  root: "runtime",
  build: { outDir: "../dist/runtime", emptyOutDir: true },
  optimizeDeps: { exclude: ["@mercuryworkshop/libcurl-transport"] },
});
