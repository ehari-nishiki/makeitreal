import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/makeitreal/",
  build: {
    outDir: "dist/makeitreal",
    emptyOutDir: true,
  },
});