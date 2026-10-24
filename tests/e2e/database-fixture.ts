import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { startPostgres } from "../../apps/api/src/test-databases.ts";

/** A real, disposable database and least-privilege login; never an existing user's database. */
export async function startSqlFixture() {
  const server = await startPostgres();
  if (!server)
    throw new Error("SQL browser tests require PostgreSQL binaries or EVERYOS_TEST_POSTGRES");
  const name = `sdk_browser_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  const options = {
    host: "127.0.0.1",
    port: server.port,
    user: server.user,
    password: server.password,
  };
  const admin = new Client({ ...options, database: "postgres" });
  let created = false;
  let role = false;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}'`);
    role = true;
    const seed = new Client({ ...options, database: name });
    try {
      await seed.connect();
      await seed.query(
        `CREATE TABLE contacts (id integer PRIMARY KEY, name text NOT NULL); INSERT INTO contacts VALUES (1, 'Ada'), (2, 'Grace'); GRANT USAGE ON SCHEMA public TO "${name}"; GRANT SELECT, UPDATE ON contacts TO "${name}"`,
      );
    } finally {
      await seed.end();
    }
    return {
      connection: {
        name: "SQL browser fixture",
        engine: "postgres",
        host: "127.0.0.1",
        port: server.port,
        database: name,
        username: name,
        password,
        tls: "disable",
        access: "write",
        audience: "admins",
        appId: "dev.everyos.sql",
      },
      close: async () => {
        try {
          await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
          await admin.query(`DROP ROLE "${name}"`);
        } finally {
          await admin.end();
          await server.stop();
        }
      },
    };
  } catch (cause) {
    try {
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      if (role) await admin.query(`DROP ROLE "${name}"`);
    } finally {
      await admin.end();
      await server.stop();
    }
    throw cause;
  }
}
