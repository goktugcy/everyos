import { createServer, type Server } from "node:https";
import type { Server as HttpServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type { Logger } from "@everyos/logger";
import type { LanListener } from "./https-service.ts";

/**
 * The local-network HTTPS listener: started, re-keyed in place (`setSecureContext`) and stopped
 * while EveryOS runs, on the same address as the HTTP listener.
 */
export function createLanListener(options: {
  fetch: Parameters<typeof getRequestListener>[0];
  hostname: string;
  /** Adds the terminal's WebSocket upgrades; returns how to remove them again. */
  attach: (server: HttpServer) => () => void;
  logger: Logger;
}): LanListener & { close: () => Promise<void> } {
  let current: { server: Server; port: number; detach: () => void } | null = null;

  const stop = async () => {
    const running = current;
    current = null;
    if (!running) return;
    running.detach();
    await new Promise<void>((resolve) => {
      running.server.close(() => resolve());
      running.server.closeAllConnections();
    });
  };

  return {
    async apply(next) {
      if (current && (!next || next.port !== current.port)) await stop();
      if (!next) return null;
      if (current) {
        current.server.setSecureContext({ cert: next.cert, key: next.key });
        return null;
      }
      const listener = getRequestListener(options.fetch);
      const server = createServer(
        { cert: next.cert, key: next.key, minVersion: "TLSv1.2" },
        (request, response) => void listener(request, response),
      );
      const error = await new Promise<string | null>((resolve) => {
        server.once("listening", () => resolve(null));
        server.once("error", (failure: NodeJS.ErrnoException) =>
          resolve(
            failure.code === "EADDRINUSE"
              ? "port-in-use"
              : failure.code === "EACCES"
                ? "permission-denied"
                : "failed",
          ),
        );
        server.listen(next.port, options.hostname);
      });
      if (error) {
        server.close();
        return error;
      }
      server.on("error", (failure) =>
        options.logger.error("HTTPS listener error", { error: failure }),
      );
      current = {
        server,
        port: next.port,
        detach: options.attach(server),
      };
      options.logger.info("EveryOS HTTPS listening", { port: next.port });
      return null;
    },
    close: stop,
  };
}
