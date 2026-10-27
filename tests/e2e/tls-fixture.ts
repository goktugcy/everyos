import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A real loopback TLS service with a short-lived, self-signed test certificate. */
export async function startTlsFixture() {
  const dir = await mkdtemp(join(tmpdir(), "everyos-e2e-tls-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "2",
        "-subj",
        "/CN=everyos-ssl-test.home.arpa",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:everyos-ssl-test.home.arpa",
      ],
      { stdio: "ignore" },
    );
    const server = createServer(
      { key: await readFile(join(dir, "key.pem")), cert: await readFile(join(dir, "cert.pem")) },
      (_request, response) => response.end("TLS fixture"),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
      port: (server.address() as AddressInfo).port,
      async close() {
        server.close();
        await once(server, "close");
        await rm(dir, { recursive: true });
      },
    };
  } catch (error) {
    await rm(dir, { recursive: true });
    throw error;
  }
}
