import { once } from "node:events";
import { createServer } from "node:http";

/** An actual loopback HTTP endpoint whose health can change while an app is closed. */
export async function startHttpFixture() {
  let status = 200;
  const checks: { method: string; status: number }[] = [];
  const server = createServer((request, response) => {
    checks.push({ method: request.method ?? "", status });
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(status === 200 ? "ready" : "unavailable");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}/health`,
    checks,
    setStatus(value: number) {
      status = value;
    },
    async close() {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    },
  };
}
