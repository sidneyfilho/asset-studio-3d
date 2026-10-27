import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Porta fixa: o Tauri espera o servidor de desenvolvimento sempre em 1430
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
