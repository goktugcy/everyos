import { randomUUID } from "node:crypto";
import type { Database } from "@otuken/database";
import {
  isLocale,
  type AdminUserView,
  type Locale,
  type PublicUser,
  type Role,
} from "@otuken/shared";

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  locale: string;
  disabled: number;
  totp_enabled: number;
  totp_secret_enc: string | null;
  totp_pending_secret_enc: string | null;
  totp_last_step: number | null;
  password_changed_at: number;
  last_login_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  role: Role;
  locale: Locale;
  disabled: boolean;
  totpEnabled: boolean;
  totpSecretEnc: string | null;
  totpPendingSecretEnc: string | null;
  totpLastStep: number | null;
  passwordChangedAt: number;
  lastLoginAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    role: row.role,
    locale: isLocale(row.locale) ? row.locale : "tr",
    disabled: row.disabled === 1,
    totpEnabled: row.totp_enabled === 1,
    totpSecretEnc: row.totp_secret_enc,
    totpPendingSecretEnc: row.totp_pending_secret_enc,
    totpLastStep: row.totp_last_step,
    passwordChangedAt: row.password_changed_at,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    locale: user.locale,
    totpEnabled: user.totpEnabled,
    createdAt: user.createdAt,
  };
}

export function toAdminUserView(user: User): AdminUserView {
  return { ...toPublicUser(user), disabled: user.disabled, lastLoginAt: user.lastLoginAt };
}

export interface NewUser {
  username: string;
  displayName: string;
  passwordHash: string;
  role: Role;
  locale: Locale;
}

export class UserRepository {
  readonly #db: Database;
  readonly #now: () => number;

  constructor(db: Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  count(): number {
    return this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users")?.n ?? 0;
  }

  countActiveAdmins(): number {
    return (
      this.#db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0",
      )?.n ?? 0
    );
  }

  findById(id: string): User | null {
    const row = this.#db.get<UserRow>("SELECT * FROM users WHERE id = ?", id);
    return row ? toUser(row) : null;
  }

  findByUsername(username: string): User | null {
    const row = this.#db.get<UserRow>("SELECT * FROM users WHERE username = ?", username);
    return row ? toUser(row) : null;
  }

  list(): User[] {
    return this.#db.all<UserRow>("SELECT * FROM users ORDER BY created_at ASC").map(toUser);
  }

  create(input: NewUser): User {
    const now = this.#now();
    const id = randomUUID();
    this.#db.run(
      `INSERT INTO users (id, username, display_name, password_hash, role, locale, password_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.username,
      input.displayName,
      input.passwordHash,
      input.role,
      input.locale,
      now,
      now,
      now,
    );
    return this.findById(id)!;
  }

  update(
    id: string,
    fields: { displayName?: string; role?: Role; disabled?: boolean; locale?: Locale },
  ): void {
    const sets: string[] = [];
    const params: Array<string | number> = [];
    if (fields.displayName !== undefined) {
      sets.push("display_name = ?");
      params.push(fields.displayName);
    }
    if (fields.role !== undefined) {
      sets.push("role = ?");
      params.push(fields.role);
    }
    if (fields.disabled !== undefined) {
      sets.push("disabled = ?");
      params.push(fields.disabled ? 1 : 0);
    }
    if (fields.locale !== undefined) {
      sets.push("locale = ?");
      params.push(fields.locale);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    params.push(this.#now());
    this.#db.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
  }

  setPasswordHash(id: string, passwordHash: string, options: { rehashOnly?: boolean } = {}): void {
    const now = this.#now();
    if (options.rehashOnly) {
      this.#db.run("UPDATE users SET password_hash = ? WHERE id = ?", passwordHash, id);
      return;
    }
    this.#db.run(
      "UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?",
      passwordHash,
      now,
      now,
      id,
    );
  }

  recordLogin(id: string): void {
    this.#db.run("UPDATE users SET last_login_at = ? WHERE id = ?", this.#now(), id);
  }

  setPendingTotpSecret(id: string, sealedSecret: string | null): void {
    this.#db.run(
      "UPDATE users SET totp_pending_secret_enc = ?, updated_at = ? WHERE id = ?",
      sealedSecret,
      this.#now(),
      id,
    );
  }

  enableTotp(id: string, sealedSecret: string, acceptedStep: number): void {
    this.#db.run(
      `UPDATE users SET totp_enabled = 1, totp_secret_enc = ?, totp_pending_secret_enc = NULL,
         totp_last_step = ?, updated_at = ? WHERE id = ?`,
      sealedSecret,
      acceptedStep,
      this.#now(),
      id,
    );
  }

  disableTotp(id: string): void {
    this.#db.transaction(() => {
      this.#db.run(
        `UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_pending_secret_enc = NULL,
           totp_last_step = NULL, updated_at = ? WHERE id = ?`,
        this.#now(),
        id,
      );
      this.#db.run("DELETE FROM recovery_codes WHERE user_id = ?", id);
    });
  }

  setTotpLastStep(id: string, step: number): void {
    this.#db.run("UPDATE users SET totp_last_step = ? WHERE id = ?", step, id);
  }

  replaceRecoveryCodes(userId: string, codeHashes: readonly string[]): void {
    const now = this.#now();
    this.#db.transaction(() => {
      this.#db.run("DELETE FROM recovery_codes WHERE user_id = ?", userId);
      for (const hash of codeHashes) {
        this.#db.run(
          "INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)",
          userId,
          hash,
          now,
        );
      }
    });
  }

  /** Marks an unused recovery code as used; returns false if none matched. */
  consumeRecoveryCode(userId: string, codeHash: string): boolean {
    return (
      this.#db.run(
        "UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
        this.#now(),
        userId,
        codeHash,
      ).changes === 1
    );
  }

  remainingRecoveryCodes(userId: string): number {
    return (
      this.#db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL",
        userId,
      )?.n ?? 0
    );
  }

  delete(id: string): void {
    this.#db.run("DELETE FROM users WHERE id = ?", id);
  }
}
