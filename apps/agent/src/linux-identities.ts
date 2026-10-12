import { spawn } from "node:child_process";
import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { OperationError, type Actor } from "@everyos/agent-protocol";
import type { LinuxAccount, LinuxAccountStatus, LinuxBinding } from "@everyos/shared";
import { LinuxBindingSchema } from "@everyos/shared/schemas";
import { z } from "zod";

/** PAM receives credentials on stdin; neither argv nor logs contain passwords. */
const AUTHENTICATE = String.raw`
import ctypes as c, ctypes.util, json, os, sys
cfg = json.load(sys.stdin)
pam = c.CDLL(ctypes.util.find_library("pam"))
libc = c.CDLL(None)
class Message(c.Structure):
    _fields_ = [("style", c.c_int), ("msg", c.c_char_p)]
class Response(c.Structure):
    _fields_ = [("resp", c.c_void_p), ("retcode", c.c_int)]
Conversation = c.CFUNCTYPE(c.c_int, c.c_int, c.POINTER(c.POINTER(Message)), c.POINTER(c.POINTER(Response)), c.c_void_p)
libc.calloc.argtypes = [c.c_size_t, c.c_size_t]
libc.calloc.restype = c.c_void_p
libc.strdup.argtypes = [c.c_char_p]
libc.strdup.restype = c.c_void_p
@Conversation
def converse(n, messages, result, _):
    if n < 1 or n > 16:
        return 19
    responses = c.cast(libc.calloc(n, c.sizeof(Response)), c.POINTER(Response))
    if not responses:
        return 5
    for i in range(n):
        style = messages[i].contents.style
        if style in (1, 2):
            value = cfg["password"] if style == 1 else cfg["user"]
            responses[i].resp = libc.strdup(value.encode())
        elif style not in (3, 4):
            return 19
    result[0] = responses
    return 0
class Conv(c.Structure):
    _fields_ = [("conv", Conversation), ("data", c.c_void_p)]
conv, handle = Conv(converse, None), c.c_void_p()
pam.pam_start.argtypes = [c.c_char_p, c.c_char_p, c.POINTER(Conv), c.POINTER(c.c_void_p)]
pam.pam_authenticate.argtypes = [c.c_void_p, c.c_int]
pam.pam_acct_mgmt.argtypes = [c.c_void_p, c.c_int]
pam.pam_end.argtypes = [c.c_void_p, c.c_int]
status = pam.pam_start(b"everyos", cfg["user"].encode(), c.byref(conv), c.byref(handle))
if status == 0:
    status = pam.pam_authenticate(handle, 0x8000)
if status == 0:
    status = pam.pam_acct_mgmt(handle, 0)
if handle:
    pam.pam_end(handle, status)
sys.exit(0 if status == 0 else 1)
`;

/** Runs the fixed privilege witness as the account, letting sudoers make the decision. */
const AUTHORIZE = String.raw`
import json, os, subprocess, sys
cfg = json.load(sys.stdin)
os.initgroups(cfg["name"], cfg["gid"])
os.setgid(cfg["gid"])
os.setuid(cfg["uid"])
env = {"PATH": "/usr/bin:/bin", "HOME": cfg["home"], "USER": cfg["name"], "LOGNAME": cfg["name"]}
password = cfg.get("password")
args = ["/usr/bin/sudo", "-k", "-p", "", "-S" if password else "-n", "--", cfg["node"], cfg["witness"]]
r = subprocess.run(args, input=(password + "\n").encode() if password else b"", stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, timeout=10)
sys.exit(0 if r.returncode == 0 and r.stdout == b"EVERYOS_AUTHORIZED\n" else 1)
`;

export function localAccounts(): LinuxAccount[] {
  const minimum = Number(
    /^UID_MIN\s+(\d+)/m.exec(readFileSync("/etc/login.defs", "utf8"))?.[1] ?? 1000,
  );
  const shells = new Set(
    readFileSync("/etc/shells", "utf8")
      .split("\n")
      .map((s) => s.trim()),
  );
  return readFileSync("/etc/passwd", "utf8")
    .split("\n")
    .flatMap((line) => {
      const [name, , uid, gid, , home, shell] = line.split(":");
      if (
        !name ||
        !uid ||
        !gid ||
        !home?.startsWith("/") ||
        !shell ||
        !shells.has(shell) ||
        Number(uid) < minimum ||
        Number(uid) === 65534
      )
        return [];
      return [{ name, uid: Number(uid), gid: Number(gid), home, shell }];
    });
}

function helper(script: string, input: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/python3", ["-I", "-c", script], {
      stdio: ["pipe", "ignore", "ignore"],
      env: { PATH: "/usr/bin:/bin" },
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(input));
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

const StoreSchema = z.array(LinuxBindingSchema).max(10_000);
const GRANT_MS = 5 * 60_000;

export class LinuxIdentities {
  readonly #path: string;
  readonly #grants = new Map<string, { userId: string; uid: number; until: number }>();
  readonly #onChange: (userId: string) => void;
  readonly #readAccounts: () => LinuxAccount[];
  readonly #authenticate: (account: LinuxAccount, password: string) => Promise<boolean>;
  readonly #authorize: (account: LinuxAccount, password?: string) => Promise<boolean>;
  #bindings: LinuxBinding[];
  readonly #revisions = new Map<string, number>();
  #pending = Promise.resolve();
  readonly #attempts = new Map<string, { count: number; until: number }>();

  constructor(options: {
    path: string;
    onChange: (userId: string) => void;
    accounts?: () => LinuxAccount[];
    authenticate?: (account: LinuxAccount, password: string) => Promise<boolean>;
    authorize?: (account: LinuxAccount, password?: string) => Promise<boolean>;
  }) {
    this.#path = options.path;
    this.#onChange = options.onChange;
    this.#readAccounts = options.accounts ?? localAccounts;
    this.#authenticate =
      options.authenticate ??
      ((account, password) => helper(AUTHENTICATE, { user: account.name, password }));
    this.#authorize =
      options.authorize ??
      ((account, password) =>
        helper(AUTHORIZE, {
          ...account,
          password,
          node: process.execPath,
          witness: join(dirname(process.argv[1]!), "sudo-witness.mjs"),
        }));
    const directory = dirname(this.#path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#trusted(directory, true);
    if (process.getuid?.() === 0) {
      for (let parent = dirname(directory); ; parent = dirname(parent)) {
        const info = lstatSync(parent);
        if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0)
          throw new Error("Unsafe Linux identity store parent");
        if (parent === "/") break;
      }
    }
    if (existsSync(this.#path)) {
      this.#trusted(this.#path, false);
      this.#bindings = StoreSchema.parse(JSON.parse(readFileSync(this.#path, "utf8")));
    } else this.#bindings = [];
  }

  accounts(): LinuxAccount[] {
    return this.#readAccounts();
  }
  bindings(): LinuxBinding[] {
    return this.#bindings.map((binding) => ({ ...binding }));
  }

  resolve(actor: Actor): LinuxAccount {
    if (actor.kind !== "user") throw new OperationError("forbidden", "LINUX_ACCOUNT_REQUIRED");
    const binding = this.#bindings.find((b) => b.userId === actor.userId);
    const account =
      binding && this.accounts().find((a) => a.name === binding.account && a.uid === binding.uid);
    if (!account) throw new OperationError("policy_denied", "LINUX_ACCOUNT_REQUIRED");
    return account;
  }

  status(actor: Actor): LinuxAccountStatus {
    let account: LinuxAccount | null = null;
    try {
      account = this.resolve(actor);
    } catch {
      /* Missing or replaced accounts remain unlinked. */
    }
    const grant =
      actor.kind === "user" && actor.sessionId ? this.#grants.get(actor.sessionId) : undefined;
    const privilegedUntil =
      account &&
      grant &&
      grant.userId === (actor.kind === "user" ? actor.userId : "") &&
      grant.uid === account.uid &&
      grant.until > Date.now()
        ? grant.until
        : null;
    return { account, privilegedUntil };
  }

  async bind(userId: string, name: string, password: string): Promise<LinuxBinding> {
    this.#attempt(name);
    const account = this.accounts().find((a) => a.name === name);
    if (!account || !(await this.#authenticate(account, password)))
      throw new OperationError("policy_denied", "LINUX_AUTH_FAILED");
    const run = this.#pending.then(() => {
      // Recheck after PAM and pin the UID: account replacement must not inherit access.
      if (!this.accounts().some((a) => a.name === name && a.uid === account.uid))
        throw new OperationError("policy_denied", "LINUX_AUTH_FAILED");
      const binding = { userId, account: name, uid: account.uid };
      const bindings = this.#bindings.filter((b) => b.userId !== userId).concat(binding);
      this.#save(bindings);
      this.#invalidate(userId);
      return binding;
    });
    this.#pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  unbind(userId: string): Promise<void> {
    const run = this.#pending.then(() => {
      this.#save(this.#bindings.filter((b) => b.userId !== userId));
      this.#invalidate(userId);
    });
    this.#pending = run.catch(() => undefined);
    return run;
  }

  async unlock(actor: Actor, password: string): Promise<LinuxAccountStatus> {
    const account = this.resolve(actor);
    const revision = actor.kind === "user" ? this.#revisions.get(actor.userId) : undefined;
    this.#attempt(account.name);
    if (
      actor.kind !== "user" ||
      !actor.sessionId ||
      !(await this.#authenticate(account, password)) ||
      !(await this.#authorize(account, password))
    )
      throw new OperationError("policy_denied", "LINUX_SUDO_REQUIRED");
    if (
      this.resolve(actor).uid !== account.uid ||
      this.resolve(actor).name !== account.name ||
      this.#revisions.get(actor.userId) !== revision
    )
      throw new OperationError("policy_denied", "LINUX_ACCOUNT_REQUIRED");
    for (const [id, grant] of this.#grants) if (grant.until <= Date.now()) this.#grants.delete(id);
    this.#grants.set(actor.sessionId, {
      userId: actor.userId,
      uid: account.uid,
      until: Date.now() + GRANT_MS,
    });
    return this.status(actor);
  }

  lock(actor: Actor): void {
    if (actor.kind === "user" && actor.sessionId) this.#grants.delete(actor.sessionId);
  }

  async requirePrivilege(actor: Actor): Promise<void> {
    const account = this.resolve(actor);
    if (this.status(actor).privilegedUntil !== null) return;
    const revision = actor.kind === "user" ? this.#revisions.get(actor.userId) : undefined;
    // Passwordless sudo is also evaluated by sudo itself, never inferred from group names.
    if (!(await this.#authorize(account)))
      throw new OperationError("policy_denied", "LINUX_SUDO_REQUIRED");
    if (
      actor.kind !== "user" ||
      this.resolve(actor).uid !== account.uid ||
      this.resolve(actor).name !== account.name ||
      this.#revisions.get(actor.userId) !== revision
    )
      throw new OperationError("policy_denied", "LINUX_ACCOUNT_REQUIRED");
  }

  #attempt(name: string): void {
    const now = Date.now();
    for (const [id, attempt] of this.#attempts) if (attempt.until <= now) this.#attempts.delete(id);
    const attempt = this.#attempts.get(name) ?? { count: 0, until: now + 60_000 };
    if (attempt.count >= 5) throw new OperationError("policy_denied", "LINUX_AUTH_RATE_LIMITED");
    attempt.count++;
    this.#attempts.set(name, attempt);
  }

  #invalidate(userId: string): void {
    this.#revisions.set(userId, (this.#revisions.get(userId) ?? 0) + 1);
    for (const [id, grant] of this.#grants) if (grant.userId === userId) this.#grants.delete(id);
    this.#onChange(userId);
  }

  #trusted(path: string, directory: boolean): void {
    const info = lstatSync(path);
    if (
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.isSymbolicLink() ||
      (directory ? !info.isDirectory() : !info.isFile())
    )
      throw new Error("Unsafe Linux identity store");
  }

  #save(bindings: LinuxBinding[]): void {
    const temp = `${this.#path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, JSON.stringify(StoreSchema.parse(bindings)));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.#path);
      const dir = openSync(dirname(this.#path), constants.O_RDONLY);
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
      this.#bindings = bindings;
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        /* Rename has consumed it. */
      }
    }
  }
}
