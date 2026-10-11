import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { ROLE_PERMISSIONS } from "@otuken/shared";
import { TerminalConnectQuerySchema } from "@otuken/shared/schemas";
import { WebSocketServer } from "ws";
import { resolveClientInfo } from "../../http/client-info.ts";
import { SECURE_SESSION_COOKIE, SESSION_COOKIE } from "../auth/session-cookie.ts";
import type { Services } from "../../services.ts";
import type { TerminalViewer } from "./terminal-service.ts";

export const TERMINAL_PATH = "/api/terminal/ws";
const ACCESS_CHECK_MS = 15_000;

function cookies(header: string | undefined): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) {
      try {
        jar.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
      } catch {
        // Upgrade callbacks bypass the HTTP error middleware. Ignore malformed cookies.
      }
    }
  }
  return jar;
}

/**
 * Decides whether a WebSocket upgrade may open a terminal. Upgrades bypass the
 * HTTP middleware, so this repeats its checks: a valid session cookie, an
 * enabled account with `terminal:access`, an unlocked session, and an Origin
 * matching the host (or a configured public origin) against cross-site
 * WebSocket hijacking.
 */
export function authorizeUpgrade(
  services: Services,
  request: Pick<IncomingMessage, "headers" | "socket">,
): { viewer: TerminalViewer } | { status: 401 | 403 | 423 } {
  const header = (name: string) => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const client = resolveClientInfo(
    {
      remoteAddress: request.socket.remoteAddress,
      encrypted: (request.socket as { encrypted?: boolean }).encrypted === true,
    },
    header,
    services.isTrustedProxy,
  );
  const origin = header("origin");
  const expected = client.host ? `${client.secure ? "https" : "http"}://${client.host}` : null;
  if (!origin || (origin !== expected && !services.config.server.publicOrigins.includes(origin))) {
    services.logger.warn("Rejected terminal connection with foreign origin", { origin, expected });
    return { status: 403 };
  }
  const jar = cookies(header("cookie"));
  const token = jar.get(SECURE_SESSION_COOKIE) ?? jar.get(SESSION_COOKIE);
  const session = token ? services.sessions.validate(token) : null;
  const user = session ? services.users.findById(session.userId) : null;
  if (!session || !user || user.disabled) return { status: 401 };
  if (session.lockedAt !== null) return { status: 423 };
  if (!ROLE_PERMISSIONS[user.role].has("terminal:access")) return { status: 403 };
  return {
    viewer: {
      userId: user.id,
      username: user.username,
      role: user.role,
      sessionId: session.id,
      ip: client.ip,
    },
  };
}

/** Whether a terminal's browser session may still use it (locked, revoked or demoted ends it). */
function stillAllowed(services: Services, viewer: TerminalViewer): boolean {
  const session = services.sessions.peek(viewer.sessionId);
  const user = services.users.findById(viewer.userId);
  return Boolean(
    session &&
    session.lockedAt === null &&
    user &&
    !user.disabled &&
    ROLE_PERMISSIONS[user.role].has("terminal:access"),
  );
}

/** Serves `GET /api/terminal/ws` upgrades on the API's HTTP server. */
export function attachTerminalGateway(server: Server, services: Services): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const reject = (socket: Duplex, status: number) => {
    const text =
      status === 401
        ? "Unauthorized"
        : status === 423
          ? "Locked"
          : status === 404
            ? "Not Found"
            : "Forbidden";
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      return reject(socket, 403);
    }
    if (url.pathname !== TERMINAL_PATH) return reject(socket, 404);
    const decision = authorizeUpgrade(services, request);
    if ("status" in decision) return reject(socket, decision.status);
    const query = TerminalConnectQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) return reject(socket, 403);
    wss.handleUpgrade(request, socket, head, (ws) => {
      void services.terminals.connect(ws, decision.viewer, {
        resume: query.data.session,
        cols: query.data.cols,
        rows: query.data.rows,
      });
    });
  };
  server.on("upgrade", onUpgrade);
  const timer = setInterval(
    () => services.terminals.revalidate((viewer) => stillAllowed(services, viewer)),
    ACCESS_CHECK_MS,
  );
  timer.unref();
  return () => {
    clearInterval(timer);
    server.off("upgrade", onUpgrade);
    wss.close();
  };
}
