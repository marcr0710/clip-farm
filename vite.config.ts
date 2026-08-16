import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { appbuilderApiDevServer } from "./vite-plugins/appbuilder-api-dev-server";

function aiProxyPlugin(): Plugin {
  let env: Record<string, string> = {};

  return {
    name: "ai-proxy",
    configureServer(server) {
      env = loadEnv("development", process.cwd(), "");

      server.middlewares.use("/api/ai/chat", async (req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type",
          });
          res.end();
          return;
        }

        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");

          const apiKey = env.AI_API_KEY;
          const platformUrl = env.AI_PLATFORM_URL || "https://devs.ai";
          const model = body.model || env.AI_AGENT_ID;

          const upstream = await fetch(`${platformUrl}/api/v2/responses`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              input: body.input,
              previous_response_id: body.previous_response_id || undefined,
              stream: true,
            }),
          });

          res.writeHead(upstream.status, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          if (!upstream.body) {
            res.end();
            return;
          }

          const reader = upstream.body.getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
            res.end();
          };

          pump().catch(() => res.end());
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : "AI proxy error" }));
        }
      });
    },
  };
}

export default defineConfig({
  // pglite + ffmpeg.wasm ship their own workers/wasm and break if Vite
  // prebundles them into the dep optimizer.
  optimizeDeps: { exclude: ["@electric-sql/pglite", "@ffmpeg/ffmpeg", "@ffmpeg/util"] },
  worker: { format: "es" },
  // `aiProxyPlugin` stays because it streams Server-Sent Events directly
  // (res.write per chunk) — the generic api router below buffers full
  // responses via ssrLoadModule + res.json()/res.send(), which doesn't fit a
  // stream. `appbuilderApiDevServer` auto-resolves every other api/*.ts file
  // (clip/render, clip/render-upload, youtube/transcript, and any future
  // route) without hand-writing a middleware block per endpoint.
  plugins: [react(), tailwindcss(), aiProxyPlugin(), appbuilderApiDevServer()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    // strictPort: a stale "npm run dev" leaves Vite drifting to 5174/5175 and the
    // saved app.url (which routes to the bare host = primary port) intermittently
    // 502s. Crash on conflict instead so the wake handler sees a real error.
    strictPort: true,
    // allowedHosts must be true: sandboxes are accessed via dynamic Vercel-assigned hostnames
    allowedHosts: true,
    // The preview iframe loads the app through the vercel.run edge proxy on
    // 443 (wss), not directly on 5173. Without this, Vite's HMR client opens
    // its WebSocket against :5173 (the dev-server port), which the proxy does
    // not expose — the socket drops, the client logs "server connection lost.
    // Polling for restart...", and forces a full page reload on reconnect, so
    // the preview appears to refresh even though nothing changed.
    hmr: { clientPort: 443, protocol: "wss" },
  },
});
