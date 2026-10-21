import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * Throwaway database servers for the database connector's tests: real PostgreSQL and MariaDB
 * started from their binaries in a temporary directory. When a server is not installed the tests
 * that need it are skipped, unless EVERYOS_REQUIRE_DB_TESTS=1 (CI), where that is a failure.
 */

export const REQUIRE_DB_TESTS = process.env.EVERYOS_REQUIRE_DB_TESTS === "1";

const SEARCH = [
  "/usr/lib/postgresql/*/bin",
  "/usr/local/opt/postgresql@*/bin",
  "/opt/homebrew/opt/postgresql@*/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/usr/sbin",
];

/** The first executable named `name` on PATH or in the usual install directories. */
function findBinary(name: string): string | null {
  const directories = [...(process.env.PATH ?? "").split(":"), ...SEARCH].flatMap((entry) => {
    if (!entry.includes("*")) return [entry];
    const [base, rest] = entry.split("*") as [string, string];
    const parent = base.slice(0, base.lastIndexOf("/"));
    const prefix = base.slice(base.lastIndexOf("/") + 1);
    if (!existsSync(parent)) return [];
    return readdirSync(parent)
      .filter((child) => child.startsWith(prefix))
      .sort()
      .reverse()
      .map((child) => `${parent}/${child}${rest}`);
  });
  for (const directory of directories) {
    const candidate = join(directory, name);
    if (directory && existsSync(candidate)) return candidate;
  }
  return null;
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check: () => Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${what} did not start`);
}

export interface TestDatabaseServer {
  port: number;
  /** The administrator account created with the server. */
  user: string;
  password: string;
  stop(): Promise<void>;
}

/**
 * A PostgreSQL server: EVERYOS_TEST_POSTGRES ("host:port:user:password", e.g. a CI service
 * container) when set, otherwise a cluster started from initdb with password (SCRAM)
 * authentication on 127.0.0.1, or null.
 */
export async function startPostgres(): Promise<TestDatabaseServer | null> {
  const external = process.env.EVERYOS_TEST_POSTGRES;
  if (external) {
    const [, port = "5432", user = "postgres", password = ""] = external.split(":");
    return { port: Number(port), user, password, stop: () => Promise.resolve() };
  }
  const initdb = findBinary("initdb");
  const pgCtl = findBinary("pg_ctl");
  if (!initdb || !pgCtl) return null;
  const dir = await mkdtemp(join(tmpdir(), "everyos-pg-"));
  const data = join(dir, "data");
  const password = "admin-secret-1";
  await writeFile(join(dir, "pw"), password);
  execFileSync(
    initdb,
    [
      "-D",
      data,
      "-U",
      "admin",
      `--pwfile=${join(dir, "pw")}`,
      "--auth=scram-sha-256",
      "-E",
      "UTF8",
      "--no-locale",
    ],
    { stdio: "ignore" },
  );
  const port = await freePort();
  execFileSync(
    pgCtl,
    ["-D", data, "-l", join(dir, "log"), "-o", `-p ${port} -k ${dir} -h 127.0.0.1`, "-w", "start"],
    { stdio: "ignore" },
  );
  return {
    port,
    user: "admin",
    password,
    stop: async () => {
      try {
        execFileSync(pgCtl, ["-D", data, "-m", "immediate", "stop"], { stdio: "ignore" });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * A MariaDB (or MySQL) server: EVERYOS_TEST_MYSQL ("host:port:user:password", e.g. a container)
 * when set, otherwise one started from mariadbd, or null.
 */
export async function startMysql(): Promise<(TestDatabaseServer & { host: string }) | null> {
  const external = process.env.EVERYOS_TEST_MYSQL;
  if (external) {
    const [host = "127.0.0.1", port = "3306", user = "root", password = ""] = external.split(":");
    return { host, port: Number(port), user, password, stop: () => Promise.resolve() };
  }
  const server = findBinary("mariadbd") ?? findBinary("mysqld");
  const install = findBinary("mariadb-install-db") ?? findBinary("mysql_install_db");
  if (!server || !install) return null;
  const dir = await mkdtemp(join(tmpdir(), "everyos-mysql-"));
  const data = join(dir, "data");
  execFileSync(
    install,
    [
      "--no-defaults",
      `--datadir=${data}`,
      "--auth-root-authentication-method=normal",
      "--skip-test-db",
    ],
    { stdio: "ignore" },
  );
  const port = await freePort();
  const child: ChildProcess = spawn(
    server,
    [
      "--no-defaults",
      `--datadir=${data}`,
      `--socket=${join(dir, "sock")}`,
      `--port=${port}`,
      "--bind-address=127.0.0.1",
      "--skip-name-resolve",
      `--pid-file=${join(dir, "pid")}`,
    ],
    { stdio: "ignore" },
  );
  const mysql = await import("mysql2/promise");
  await waitFor(async () => {
    const connection = await mysql.createConnection({ host: "127.0.0.1", port, user: "root" });
    await connection.query("CREATE USER IF NOT EXISTS 'admin'@'%' IDENTIFIED BY 'admin-secret-1'");
    await connection.query("GRANT ALL PRIVILEGES ON *.* TO 'admin'@'%' WITH GRANT OPTION");
    await connection.end();
    return true;
  }, "MariaDB");
  return {
    host: "127.0.0.1",
    port,
    user: "admin",
    password: "admin-secret-1",
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
