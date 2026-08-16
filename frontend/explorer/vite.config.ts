import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The explorer is served from the site root (Firebase Hosting), so assets resolve
// against "/". `dev` proxies the /kg API to a locally running MCP server so the
// app talks same-origin in development just as it does in production.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/kg": {
        target: process.env.KG_API || "http://localhost:8791",
        changeOrigin: true,
      },
    },
  },
});
