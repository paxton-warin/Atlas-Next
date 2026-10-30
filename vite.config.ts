import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "web",
  // Native local storage is mandatory; retired replication cannot be re-enabled by environment.
  define: { __ATLAS_LOCAL_FIRST_V2__: "true" },
  plugins: [react()],
  // The restartable backup actor lazily loads its bounded capture/resume codec.
  // Its Worker already uses type:"module"; emit real ES worker chunks rather
  // than Vite's IIFE default, which cannot represent that lazy import.
  worker: { format: "es" },
  build: { outDir: "../dist/web", emptyOutDir: true },
});
