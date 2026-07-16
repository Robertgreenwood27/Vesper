import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        // The showcase is the product: a spider on a web, nothing else on screen.
        main: resolve(__dirname, "index.html"),
        // The Phase 8 instrument survives at /lab.html. It is not on the path to
        // the illusion, but it is the only place the internals are visible.
        lab: resolve(__dirname, "lab.html"),
      },
    },
  },
});
