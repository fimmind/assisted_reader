import { defineConfig } from "vite";
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { inspectWsdAssets } from "./scripts/wsd-assets.mjs";

const rawPort = process.env.PORT;
const portFromEnv = rawPort ? Number(rawPort) : 5173;
const port = Number.isNaN(portFromEnv) || portFromEnv <= 0 ? 5173 : portFromEnv;

const basePath = process.env.BASE_PATH;
const resolvedBasePath = basePath && basePath.length > 0 ? basePath : "/";

function wsdAvailabilityMiddleware(root: string, endpoint: string) {
  return (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    if (request.url?.split('?')[0] !== endpoint) {
      next();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    void inspectWsdAssets(root).then((availability) => {
      response.end(JSON.stringify(availability));
    }).catch((error: unknown) => {
      console.error('wsd-availability-check-failed', { root, error });
      response.statusCode = 500;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  };
}

function wsdAvailabilityPlugin(): Plugin {
  return {
    name: 'wsd-asset-availability',
    configureServer(server) {
      server.middlewares.use(wsdAvailabilityMiddleware(path.join(server.config.publicDir, 'wsd'),
        `${server.config.base}wsd/availability.json`));
    },
    configurePreviewServer(server) {
      server.middlewares.use(wsdAvailabilityMiddleware(path.resolve(server.config.root, server.config.build.outDir, 'wsd'),
        `${server.config.base}wsd/availability.json`));
    },
    async generateBundle() {
      const availability = await inspectWsdAssets(path.resolve('public/wsd'));
      if (Object.values(availability).some((status) => !status.available)) {
        this.error(`WSD assets are incomplete. Run pnpm ensure:wsd. ${JSON.stringify(availability)}`);
      }
      this.emitFile({ type: 'asset', fileName: 'wsd/availability.json', source: JSON.stringify(availability) });
    },
  };
}

export default defineConfig({
  base: resolvedBasePath,
  plugins: [
    react(),
    tailwindcss(),
    wsdAvailabilityPlugin(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
