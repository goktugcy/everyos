import { parseArgs, promisify } from "node:util";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  CSRF_HEADER,
  type LoginResponse,
  type BackupJobView,
  type SelfUpdateStatus,
} from "@everyos/shared";
import { installedVersion, releaseConfig } from "./config.ts";

const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
const CredentialsSchema = z.strictObject({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
  otp: z.string().max(128).optional(),
});
async function credentials(stdin: boolean): Promise<z.infer<typeof CredentialsSchema>> {
  if (stdin) {
    let data = "";
    for await (const chunk of process.stdin) {
      data += String(chunk);
      if (data.length > 4096) throw new Error("Credentials input is too large");
    }
    return CredentialsSchema.parse(JSON.parse(data));
  }
  if (!process.stdin.isTTY)
    throw new Error(
      "Use --credentials-stdin with JSON username/password, or an interactive terminal",
    );
  let muted = false;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stderr.write(String(chunk));
      callback();
    },
  });
  const prompt = createInterface({ input: process.stdin, output: sink, terminal: true });
  try {
    const username = await prompt.question("Username: ");
    process.stderr.write("Password: ");
    muted = true;
    const password = await prompt.question("");
    muted = false;
    process.stderr.write("\n");
    const otp = await prompt.question("TOTP/recovery code (empty if disabled): ");
    return CredentialsSchema.parse({ username, password, ...(otp ? { otp } : {}) });
  } finally {
    prompt.close();
  }
}
async function main(): Promise<void> {
  const args = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string", default: "http://127.0.0.1:7470" },
      "credentials-stdin": { type: "boolean", default: false },
      confirm: { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  const [action, id] = args.positionals;
  if (!action || args.values.help) {
    process.stdout.write(
      "EveryOS CLI\n  everyos version|status|doctor\n  everyos backup\n  everyos restore BACKUP_ID --confirm\n  everyos update [--apply --confirm]\nOptions: --url ORIGIN, --credentials-stdin (JSON username/password/optional otp)\n",
    );
    return;
  }
  if (action === "version") {
    process.stdout.write(installedVersion() + "\n");
    return;
  }
  const base = new URL(args.values.url);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    (base.protocol !== "https:" &&
      !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)))
  )
    throw new Error("Use an HTTPS origin or a loopback HTTP origin");
  let cookie = "",
    csrf = "";
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(new URL(`/api${path}`, base), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        origin: base.origin,
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
      redirect: "error",
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) cookie = cookies.map((value) => value.split(";")[0]).join("; ");
    const data = (await response.json()) as T;
    if (!response.ok) throw new Error(`API request failed (${response.status})`);
    return data;
  };
  if (action === "status") {
    output(await request("/health"));
    return;
  }
  if (action === "doctor") {
    const checks: Record<string, unknown> = {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      version: installedVersion(),
      packaged: existsSync("/usr/lib/everyos/VERSION"),
      root: process.getuid?.() === 0,
    };
    try {
      checks.health = await request("/health");
    } catch {
      checks.health = "unavailable";
    }
    try {
      checks.releaseConfigured = releaseConfig() !== null;
    } catch {
      checks.releaseConfigured = "unreadable-or-untrusted";
    }
    if (process.platform === "linux") {
      const result = await promisify(execFile)(
        "/usr/bin/systemctl",
        [
          "show",
          "everyos-api.service",
          "everyos-agent.service",
          "--property=Id,ActiveState,User,NoNewPrivileges,ProtectSystem",
          "--no-pager",
        ],
        { timeout: 10_000 },
      );
      checks.units = result.stdout.trim();
    }
    output(checks);
    return;
  }
  if (!["backup", "restore", "update"].includes(action))
    throw new Error("Unknown command; use --help");
  if ((action === "restore" || (action === "update" && args.values.apply)) && !args.values.confirm)
    throw new Error("This action requires --confirm");
  const account = await credentials(args.values["credentials-stdin"]);
  let login = await request<LoginResponse>("/auth/login", {
    username: account.username,
    password: account.password,
  });
  if (login.status === "totp_required") {
    if (!account.otp) throw new Error("A TOTP or recovery code is required");
    login = await request<LoginResponse>("/auth/login/totp", {
      challengeId: login.challengeId,
      code: account.otp,
    });
  }
  if (login.status !== "authenticated") throw new Error("Login did not complete");
  csrf = login.session.csrfToken;
  const waitBackup = async (job: BackupJobView): Promise<BackupJobView> => {
    while (job.status === "running") {
      await delay(action === "restore" ? 500 : 1500);
      const current = await request<{ job: BackupJobView | null; lastJob: BackupJobView | null }>(
        "/backups/job",
      );
      const next =
        current.job?.id === job.id
          ? current.job
          : current.lastJob?.id === job.id
            ? current.lastJob
            : null;
      if (!next) throw new Error("Backup job interrupted");
      job = next;
    }
    if (job.status !== "succeeded") throw new Error("Backup/restore failed; inspect the API job");
    return job;
  };
  if (action === "backup") {
    output(await waitBackup(await request<BackupJobView>("/backups", { apps: [] })));
    return;
  }
  if (action === "restore") {
    if (!id || !/^\d{8}-\d{6}-[a-f0-9]{6}$/.test(id))
      throw new Error("A valid backup id is required");
    output(
      await waitBackup(
        await request<BackupJobView>(`/backups/${id}/restore`, {
          settings: "database",
          homes: true,
          apps: [],
          password: account.password,
          confirm: true,
        }),
      ),
    );
    return;
  }
  let status = await request<SelfUpdateStatus>("/self-update/check", {});
  if (!args.values.apply || !status.available) {
    output(status);
    return;
  }
  const backup = await waitBackup(await request<BackupJobView>("/self-update/prepare", {}));
  await request("/self-update/install", {
    version: status.available.version,
    backupId: backup.backupId,
    password: account.password,
    confirm: true,
  });
  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    await delay(2000);
    try {
      status = await request<SelfUpdateStatus>("/self-update");
    } catch {
      continue;
    }
    if (status.job && status.job.finishedAt !== null) {
      output(status);
      if (status.job.state !== "succeeded") process.exitCode = 1;
      return;
    }
  }
  throw new Error("Update is still running; use the web update view or journal");
}
main().catch(() => {
  process.stderr.write(
    "EveryOS command failed. Check arguments, credentials, service health and journal; use --help.\n",
  );
  process.exitCode = 1;
});
