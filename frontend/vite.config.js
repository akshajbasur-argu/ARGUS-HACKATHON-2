import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
// https://vite.dev/config/
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    server: {
        port: 5173,
        proxy: {
            // Proxy API + SSE to the FastAPI backend during development.
            "/api": {
                target: "http://localhost:8000",
                changeOrigin: true,
            },
        },
    },
});
