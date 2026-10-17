import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = process.env.ARENA_PORT ?? process.env.CHESS_API_PORT ?? "8780";

export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
