import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), localPluginsManifest()],
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
    // Dev HMR: change TS/TSX and refresh in ~seconds. Do NOT use `build` for day-to-day UI work.
    // When browsing via 盒子 frpc (e.g. :22300), set VITE_HMR_HOST / VITE_HMR_CLIENT_PORT so WS matches.
    server: {
        host: process.env.VITE_DEV_HOST || "0.0.0.0",
        port: Number(process.env.VITE_DEV_PORT || 3000),
        strictPort: true,
        hmr: process.env.VITE_HMR_CLIENT_PORT
            ? {
                  host: process.env.VITE_HMR_HOST || undefined,
                  clientPort: Number(process.env.VITE_HMR_CLIENT_PORT),
                  protocol: (process.env.VITE_HMR_PROTOCOL as "ws" | "wss" | undefined) || "ws",
              }
            : undefined,
    },
    preview: {
        host: process.env.VITE_DEV_HOST || "0.0.0.0",
        port: Number(process.env.VITE_PREVIEW_PORT || 3000),
        strictPort: true,
    },
});
