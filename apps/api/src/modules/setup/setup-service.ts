import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "@otuken/logger";
import { randomToken, safeEqual } from "@otuken/security";
import type { UserRepository } from "../users/user-repository.ts";

/**
 * First-run setup is gated by a one-time token stored in a file that only the
 * otuken user (and root) can read. This prevents anyone else on the network
 * from claiming a freshly installed instance before its owner does.
 */
export class SetupService {
  readonly #users: UserRepository;
  readonly #tokenFile: string;
  readonly #logger: Logger;
  readonly #revealToken: boolean;
  #completed = false;

  constructor(options: {
    users: UserRepository;
    tokenFile: string;
    logger: Logger;
    revealTokenInLogs: boolean;
  }) {
    this.#users = options.users;
    this.#tokenFile = options.tokenFile;
    this.#logger = options.logger.child({ component: "setup" });
    this.#revealToken = options.revealTokenInLogs;
  }

  isSetupRequired(): boolean {
    if (this.#completed) return false;
    if (this.#users.count() > 0) {
      this.#completed = true;
      return false;
    }
    return true;
  }

  /** Ensures a token exists while setup is pending; removes it afterwards. */
  initialize(): void {
    if (!this.isSetupRequired()) {
      rmSync(this.#tokenFile, { force: true });
      return;
    }
    let token = this.#readToken();
    if (!token) {
      token = randomToken(24);
      mkdirSync(dirname(this.#tokenFile), { recursive: true, mode: 0o750 });
      writeFileSync(this.#tokenFile, `${token}\n`, { mode: 0o600 });
    }
    if (this.#revealToken) {
      this.#logger.warn("First-run setup pending. Setup token (development only)", {
        setupCode: token,
      });
    } else {
      this.#logger.warn("First-run setup pending. Read the setup token from the server", {
        file: this.#tokenFile,
      });
    }
  }

  verifyToken(candidate: string): boolean {
    const token = this.#readToken();
    return token !== null && safeEqual(token, candidate.trim());
  }

  markCompleted(): void {
    this.#completed = true;
    rmSync(this.#tokenFile, { force: true });
  }

  #readToken(): string | null {
    try {
      const token = readFileSync(this.#tokenFile, "utf8").trim();
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }
}
