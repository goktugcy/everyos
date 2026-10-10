import type { Database } from "@otuken/database";

export interface ImportedProject {
  name: string;
  workingDir: string;
  configFiles: string[];
  importedBy: string | null;
  importedByUsername: string | null;
  importedAt: number;
}

interface ProjectRow {
  name: string;
  working_dir: string;
  config_files: string;
  imported_by: string | null;
  username: string | null;
  imported_at: number;
}

function toProject(row: ProjectRow): ImportedProject {
  let configFiles: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.config_files);
    if (Array.isArray(parsed))
      configFiles = parsed.filter((f): f is string => typeof f === "string");
  } catch {
    // A corrupt row yields no files; actions then fail validation instead of guessing.
  }
  return {
    name: row.name,
    workingDir: row.working_dir,
    configFiles,
    importedBy: row.imported_by,
    importedByUsername: row.username,
    importedAt: row.imported_at,
  };
}

/** Compose projects the owner imported into Otuken (the only source of "imported" ownership). */
export class DockerProjectRepository {
  readonly #db: Database;
  readonly #now: () => number;

  constructor(db: Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  list(): ImportedProject[] {
    return this.#db
      .all<ProjectRow>(
        `SELECT p.*, u.username FROM docker_projects p LEFT JOIN users u ON u.id = p.imported_by ORDER BY p.name`,
      )
      .map(toProject);
  }

  get(name: string): ImportedProject | null {
    const row = this.#db.get<ProjectRow>(
      `SELECT p.*, u.username FROM docker_projects p LEFT JOIN users u ON u.id = p.imported_by WHERE p.name = ?`,
      name,
    );
    return row ? toProject(row) : null;
  }

  importProject(
    project: { name: string; workingDir: string; configFiles: string[] },
    userId: string,
  ): void {
    this.#db.run(
      `INSERT INTO docker_projects (name, working_dir, config_files, imported_by, imported_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET working_dir = excluded.working_dir,
         config_files = excluded.config_files, imported_by = excluded.imported_by,
         imported_at = excluded.imported_at`,
      project.name,
      project.workingDir,
      JSON.stringify(project.configFiles),
      userId,
      this.#now(),
    );
  }

  /** Forgets an import. Never touches containers, volumes or files. */
  remove(name: string): boolean {
    return this.#db.run("DELETE FROM docker_projects WHERE name = ?", name).changes > 0;
  }
}
