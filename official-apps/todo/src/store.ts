import type { EveryOSApp } from "@everyos/app-sdk";
import { newId, parseTask, PROJECT_COLORS, type Project, type Task } from "./model.ts";

/*
 * Tasks in the app's per-person storage, spread over shards (each storage value holds at most
 * 256 KiB). Every change re-reads its shard right before writing, one change at a time, so the
 * window and the widget do not undo each other.
 */

const SHARDS = 8;
const shardOf = (id: string) =>
  [...id].reduce((sum, char) => (sum + char.charCodeAt(0)) % SHARDS, 0);
const key = (shard: number) => `tasks/${shard}`;

export interface Backup {
  format: "everyos-todo/1";
  exportedAt: number;
  projects: Project[];
  tasks: Task[];
}

export class TodoStore {
  readonly #app: EveryOSApp;
  readonly #now: () => number;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(app: EveryOSApp, now: () => number = () => Date.now()) {
    this.#app = app;
    this.#now = now;
  }

  #serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #shard(shard: number): Promise<Task[]> {
    const stored = (await this.#app.storage.get<unknown[]>(key(shard))) ?? [];
    return stored.map(parseTask).filter((task): task is Task => task !== null);
  }

  /** The shard holding a task: its own, or (written by other means) wherever it is. */
  async #locate(id: string): Promise<{ shard: number; tasks: Task[] }> {
    const own = shardOf(id);
    const tasks = await this.#shard(own);
    if (tasks.some((task) => task.id === id)) return { shard: own, tasks };
    for (let shard = 0; shard < SHARDS; shard += 1) {
      if (shard === own) continue;
      const other = await this.#shard(shard);
      if (other.some((task) => task.id === id)) return { shard, tasks: other };
    }
    return { shard: own, tasks };
  }

  async tasks(): Promise<Task[]> {
    const shards = await Promise.all(
      Array.from({ length: SHARDS }, (_, shard) => this.#shard(shard)),
    );
    return shards.flat();
  }

  async projects(): Promise<Project[]> {
    const stored = (await this.#app.storage.get<Project[]>("projects")) ?? [];
    return stored.filter(
      (project) => typeof project.id === "string" && typeof project.name === "string",
    );
  }

  /** Writes a task (new or changed). */
  put(task: Task): Promise<Task> {
    return this.#serially(async () => {
      const { shard, tasks } = await this.#locate(task.id);
      const updated = { ...task, updatedAt: this.#now() };
      const index = tasks.findIndex((entry) => entry.id === task.id);
      if (index === -1) tasks.push(updated);
      else tasks[index] = updated;
      await this.#app.storage.set(key(shard), tasks);
      return updated;
    });
  }

  /** Changes a task as stored now (another instance may have changed it meanwhile). */
  change(id: string, change: (task: Task) => Task): Promise<Task | null> {
    return this.#serially(async () => {
      const { shard, tasks } = await this.#locate(id);
      const index = tasks.findIndex((entry) => entry.id === id);
      if (index === -1) return null;
      const updated = { ...change(tasks[index]!), updatedAt: this.#now() };
      tasks[index] = updated;
      await this.#app.storage.set(key(shard), tasks);
      return updated;
    });
  }

  remove(id: string): Promise<void> {
    return this.#serially(async () => {
      const { shard, tasks } = await this.#locate(id);
      await this.#app.storage.set(
        key(shard),
        tasks.filter((task) => task.id !== id),
      );
    });
  }

  saveProjects(projects: Project[]): Promise<void> {
    return this.#serially(() => this.#app.storage.set("projects", projects.slice(0, 200)));
  }

  async addProject(name: string): Promise<Project> {
    const projects = await this.projects();
    const project: Project = {
      id: newId(),
      name: name.trim().slice(0, 80),
      color: PROJECT_COLORS[projects.length % PROJECT_COLORS.length]!,
      order: projects.length,
    };
    await this.saveProjects([...projects, project]);
    return project;
  }

  /** Deletes a project; its tasks move to the Inbox. */
  async removeProject(id: string): Promise<void> {
    await this.saveProjects((await this.projects()).filter((project) => project.id !== id));
    for (const task of await this.tasks())
      if (task.projectId === id)
        await this.change(task.id, (current) => ({ ...current, projectId: null }));
  }

  async exportAll(): Promise<Backup> {
    return {
      format: "everyos-todo/1",
      exportedAt: this.#now(),
      projects: await this.projects(),
      tasks: await this.tasks(),
    };
  }

  /** Adds what a backup holds that is not here yet (by id). */
  async importBackup(value: unknown): Promise<number> {
    const backup = value as Partial<Backup> | null;
    if (backup?.format !== "everyos-todo/1" || !Array.isArray(backup.tasks))
      throw new SyntaxError("Not a To-Do backup");
    const projects = await this.projects();
    const known = new Set(projects.map((project) => project.id));
    const added = (Array.isArray(backup.projects) ? backup.projects : []).filter(
      (project): project is Project =>
        !!project &&
        typeof project.id === "string" &&
        typeof project.name === "string" &&
        !known.has(project.id),
    );
    if (added.length)
      await this.saveProjects([
        ...projects,
        ...added.map((project, index) => ({
          id: project.id,
          name: project.name.slice(0, 80),
          color:
            typeof project.color === "string" && /^#[0-9a-f]{6}$/i.test(project.color)
              ? project.color
              : PROJECT_COLORS[0]!,
          order: projects.length + index,
        })),
      ]);
    const existing = new Set((await this.tasks()).map((task) => task.id));
    let count = 0;
    for (const raw of backup.tasks) {
      const task = parseTask(raw);
      if (!task || existing.has(task.id)) continue;
      await this.put(task);
      count += 1;
    }
    return count;
  }
}
