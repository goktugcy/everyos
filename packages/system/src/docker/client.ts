import { stat } from "node:fs/promises";
import { request, type IncomingMessage } from "node:http";
import { totalmem } from "node:os";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import type {
  AppImage,
  ComposeAction,
  ComposeActionResult,
  ComposeFileCheck,
  ComposeProject,
  ContainerAction,
  ContainerDetail,
  ContainerLogLine,
  ContainerStatsSample,
  ContainerSummary,
  DockerEvent,
  DockerStatus,
  ImageSummary,
  NetworkSummary,
  VolumeSummary,
} from "@everyos/shared";
import { EVERYOS_AI_NETWORK } from "@everyos/shared";
import type { PostgresStats } from "@everyos/shared/schemas";
import { mapLimit, pathKind } from "../fs-utils.ts";
import { checkComposeFiles, ComposeError, detectCompose, runCompose } from "./compose.ts";
import { resolveManagedImages } from "./managed-images.ts";
import {
  composeProjects,
  LogDemuxer,
  parseContainerInspect,
  parseContainerList,
  parseContainerStats,
  parseDockerEvent,
  parseImages,
  parseLogLine,
  parseNetworks,
  parseVolumes,
  parseVolumeSizes,
  RELAYED_EVENTS,
  type ListedContainer,
} from "./parse.ts";

export type DockerErrorKind =
  | "unavailable"
  | "permission-denied"
  | "unsupported"
  | "not-found"
  | "conflict"
  | "invalid"
  | "timeout"
  | "too-large"
  | "failed";

export class DockerError extends Error {
  readonly kind: DockerErrorKind;

  constructor(kind: DockerErrorKind, message: string) {
    super(message);
    this.name = "DockerError";
    this.kind = kind;
  }
}

export interface LogOptions {
  tail: number;
  follow: boolean;
  /** Epoch milliseconds. */
  since?: number | undefined;
}

/**
 * Typed access to Docker. There is no generic passthrough: every Engine API
 * call EveryOS makes is one of these methods, with fixed paths and
 * validated identifiers.
 */
export interface DockerApi {
  resolveImages(
    input: string,
    platform: string,
    update: boolean,
    signal?: AbortSignal,
  ): Promise<{ compose: string; images: AppImage[] }>;
  readonly source: "host" | "simulated";
  status(): Promise<DockerStatus>;
  listContainers(): Promise<ContainerSummary[]>;
  inspectContainer(id: string, options: { showCommand: boolean }): Promise<ContainerDetail>;
  stats(ids: readonly string[]): Promise<ContainerStatsSample[]>;
  controlContainer(id: string, action: ContainerAction): Promise<void>;
  logs(id: string, options: LogOptions, signal: AbortSignal): AsyncIterable<ContainerLogLine>;
  listImages(): Promise<ImageSummary[]>;
  removeImage(id: string): Promise<void>;
  listVolumes(): Promise<VolumeSummary[]>;
  removeVolume(name: string): Promise<void>;
  listNetworks(): Promise<NetworkSummary[]>;
  removeNetwork(id: string): Promise<void>;
  /**
   * Creates or verifies the internal network that built-in AI apps share. A same-named
   * network that EveryOS did not create is never adopted.
   */
  ensureAiNetwork(): Promise<void>;
  listProjects(): Promise<ComposeProject[]>;
  /** Checks the Compose files a discovered project was created from (for import). */
  checkProject(project: string): Promise<ComposeFileCheck>;
  runCompose(
    project: string,
    workingDir: string,
    files: readonly string[],
    action: ComposeAction,
    signal?: AbortSignal,
    input?: string,
  ): Promise<ComposeActionResult>;
  events(signal: AbortSignal): AsyncIterable<DockerEvent>;
  /**
   * Connection and size statistics of a PostgreSQL container, from one fixed,
   * read-only query run with `psql` inside it (never arbitrary SQL or commands).
   */
  postgresStats(
    container: string,
    user: string,
    database: string,
    signal?: AbortSignal,
  ): Promise<PostgresStats>;
}

const DEFAULT_SOCKETS = ["/var/run/docker.sock", "/run/docker.sock"];
const AI_NETWORK_LABEL = "io.everyos.owned";
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
/** Images of PostgreSQL and its common distributions; exec is refused for anything else. */
const POSTGRES_IMAGE = /(^|\/)(postgres|postgresql|pgvector|pgvecto-rs|postgis)(:|@|$)/;
/** The only statement EveryOS runs inside PostgreSQL containers: read-only, fixed, no user input. */
export const POSTGRES_STATS_SQL =
  "BEGIN READ ONLY; SELECT json_build_object(" +
  "'connections', (SELECT count(*) FROM pg_stat_activity), " +
  "'maxConnections', current_setting('max_connections')::int, " +
  "'databases', COALESCE((SELECT json_agg(json_build_object('name', datname, 'sizeBytes', pg_database_size(datname))) " +
  "FROM pg_database WHERE NOT datistemplate AND datallowconn), '[]'::json)); COMMIT;";

export function parsePostgresStats(line: string): PostgresStats {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new DockerError("failed", "psql returned unexpected output");
  }
  const value = (raw ?? {}) as {
    connections?: unknown;
    maxConnections?: unknown;
    databases?: unknown;
  };
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    connections: count(value.connections),
    maxConnections: count(value.maxConnections),
    databases: (Array.isArray(value.databases) ? value.databases : [])
      .slice(0, 256)
      .flatMap((entry: unknown) => {
        const db = (entry ?? {}) as { name?: unknown; sizeBytes?: unknown };
        return typeof db.name === "string"
          ? [{ name: db.name.slice(0, 128), sizeBytes: count(db.sizeBytes) }]
          : [];
      }),
  };
}
/** Newest Engine API version EveryOS was written against; older servers are used at their version. */
const CLIENT_API_VERSION = "1.51";
/** `stats?one-shot=true` needs 1.41 (Docker 20.10). */
const MIN_API_VERSION = "1.41";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function compareVersions(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

function connectionError(error: NodeJS.ErrnoException): DockerError {
  if (error instanceof DockerError) return error;
  if (error.code === "EACCES" || error.code === "EPERM")
    return new DockerError("permission-denied", "No permission to use the Docker socket");
  if (error.code === "ENOENT" || error.code === "ECONNREFUSED")
    return new DockerError("unavailable", "Docker is not running");
  if (error.name === "AbortError") return new DockerError("failed", "Request aborted");
  return new DockerError("failed", "Docker request failed");
}

function statusError(status: number, body: Buffer): DockerError {
  let message = `Docker returned HTTP ${status}`;
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { message?: unknown };
    if (typeof parsed.message === "string") message = parsed.message.slice(0, 300);
  } catch {
    // Keep the generic message.
  }
  if (status === 404) return new DockerError("not-found", message);
  if (status === 409) return new DockerError("conflict", message);
  if (status === 400) return new DockerError("invalid", message);
  return new DockerError("failed", message);
}

interface CallOptions {
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string>;
  timeoutMs?: number;
  /** Statuses treated as success besides 2xx (e.g. 304 "already started"). */
  okStatuses?: readonly number[];
  signal?: AbortSignal;
  /** JSON request body. */
  body?: unknown;
}

/** HTTP over the Docker Unix socket with negotiated API version, timeouts and size caps. */
class DockerTransport {
  readonly #candidates: readonly string[];
  #socket: Promise<{ path: string; prefix: string; apiVersion: string }> | null = null;

  constructor(candidates: readonly string[]) {
    this.#candidates = candidates;
  }

  connection(): Promise<{ path: string; prefix: string; apiVersion: string }> {
    this.#socket ??= this.#connect().catch((error: unknown) => {
      this.#socket = null;
      throw error;
    });
    return this.#socket;
  }

  async #connect() {
    let denied = false;
    for (const path of this.#candidates) {
      const kind = await pathKind(path);
      if (kind === "denied") denied = true;
      if (kind !== "socket") continue;
      const response = await this.#send(path, "GET", "/_ping", {}, 5_000);
      response.resume();
      const header = response.headers["api-version"];
      const server = typeof header === "string" ? header : MIN_API_VERSION;
      if (compareVersions(server, MIN_API_VERSION) < 0)
        throw new DockerError(
          "unsupported",
          `Docker API ${server} is too old (needs ${MIN_API_VERSION})`,
        );
      const apiVersion =
        compareVersions(server, CLIENT_API_VERSION) < 0 ? server : CLIENT_API_VERSION;
      return { path, prefix: `/v${apiVersion}`, apiVersion: server };
    }
    throw denied
      ? new DockerError("permission-denied", "No permission to use the Docker socket")
      : new DockerError("unavailable", "Docker socket not found");
  }

  #send(socketPath: string, method: string, path: string, options: CallOptions, timeoutMs: number) {
    return new Promise<IncomingMessage>((resolve, reject) => {
      const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
      const req = request({
        socketPath,
        method,
        path,
        headers: {
          Host: "docker",
          ...(body
            ? { "Content-Type": "application/json", "Content-Length": String(body.length) }
            : {}),
        },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      req.setTimeout(timeoutMs, () =>
        req.destroy(new DockerError("timeout", "Docker did not respond in time")),
      );
      req.once("response", resolve);
      req.once("error", (error) => reject(connectionError(error)));
      req.end(body ?? undefined);
    });
  }

  async open(path: string, options: CallOptions = {}): Promise<IncomingMessage> {
    const connection = await this.connection();
    const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : "";
    const response = await this.#send(
      connection.path,
      options.method ?? "GET",
      `${connection.prefix}${path}${query}`,
      options,
      options.timeoutMs ?? 15_000,
    );
    const ok =
      (response.statusCode ?? 0) < 300 ||
      (options.okStatuses ?? []).includes(response.statusCode ?? 0);
    if (!ok) throw statusError(response.statusCode ?? 0, await readBody(response, 64 * 1024));
    return response;
  }

  async json(path: string, options: CallOptions = {}): Promise<unknown> {
    const body = await readBody(await this.open(path, options), MAX_RESPONSE_BYTES);
    return body.length === 0 ? null : (JSON.parse(body.toString("utf8")) as unknown);
  }
}

async function readBody(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      response.destroy();
      throw new DockerError("too-large", "Docker response is too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export interface DockerClientOptions {
  socketPaths?: readonly string[];
  isProtected?: (containerName: string) => boolean;
  now?: () => number;
}

export function createDockerClient(options: DockerClientOptions = {}): DockerApi {
  const transport = new DockerTransport(options.socketPaths ?? DEFAULT_SOCKETS);
  const isProtected = options.isProtected ?? (() => false);
  const now = options.now ?? Date.now;

  const listed = async (filters?: Record<string, string[]>): Promise<ListedContainer[]> =>
    parseContainerList(
      await transport.json("/containers/json", {
        query: { all: "1", ...(filters ? { filters: JSON.stringify(filters) } : {}) },
      }),
    );
  const summary = (container: ListedContainer): ContainerSummary => ({
    ...container.summary,
    protected: isProtected(container.summary.name),
  });
  const findOne = async (id: string): Promise<ListedContainer> => {
    const [match] = await listed({ id: [id] });
    if (!match) throw new DockerError("not-found", "Container not found");
    return match;
  };

  return {
    source: "host",
    async resolveImages(input, platform, update, signal) {
      const { path } = await transport.connection();
      return resolveManagedImages(path, input, platform, update, signal);
    },

    async status() {
      const empty = { total: 0, running: 0, paused: 0, stopped: 0 };
      try {
        const { apiVersion } = await transport.connection();
        const [version, info, compose] = await Promise.all([
          transport.json("/version") as Promise<Record<string, unknown>>,
          transport.json("/info") as Promise<Record<string, unknown>>,
          detectCompose(),
        ]);
        const count = (value: unknown) => (typeof value === "number" ? value : 0);
        const text = (value: unknown, max: number) =>
          typeof value === "string" ? value.slice(0, max) : null;
        const runtimes = info.Runtimes,
          devices = Array.isArray(info.DiscoveredDevices) ? info.DiscoveredDevices : [];
        const nvidia =
          (runtimes !== null && typeof runtimes === "object" && "nvidia" in runtimes) ||
          devices.some(
            (device: unknown) =>
              typeof (device as { ID?: unknown }).ID === "string" &&
              (device as { ID: string }).ID.startsWith("nvidia.com/gpu"),
          );
        // ROCm containers need the kernel fusion driver of an AMD GPU.
        const amd = await stat("/dev/kfd").then(
          (entry) => entry.isCharacterDevice(),
          () => false,
        );
        return {
          source: "host",
          status: { available: true },
          version: text(version.Version, 64),
          apiVersion: apiVersion.slice(0, 16),
          os: text(version.Os, 64),
          arch: text(version.Arch, 32),
          storageDriver: text(info.Driver, 64),
          containers: {
            total: count(info.Containers),
            running: count(info.ContainersRunning),
            paused: count(info.ContainersPaused),
            stopped: count(info.ContainersStopped),
          },
          images: count(info.Images),
          compose: { available: compose !== null, version: compose },
          gpu: { nvidia, amd },
        };
      } catch (error) {
        const kind = error instanceof DockerError ? error.kind : "failed";
        return {
          source: "host",
          status: {
            available: false,
            reason: kind === "permission-denied" ? "permission-denied" : "socket-missing",
          },
          version: null,
          apiVersion: null,
          os: null,
          arch: null,
          storageDriver: null,
          containers: empty,
          images: 0,
          compose: { available: false, version: null },
        };
      }
    },

    async listContainers() {
      return (await listed()).map(summary);
    },

    async inspectContainer(id, inspectOptions) {
      const container = await findOne(id);
      const raw = await transport.json(`/containers/${container.summary.id}/json`);
      return { source: "host", ...parseContainerInspect(raw, summary(container), inspectOptions) };
    },

    async stats(ids) {
      const at = now();
      const samples = await mapLimit(ids.slice(0, 500), 8, async (id) => {
        try {
          const raw = await transport.json(`/containers/${id}/stats`, {
            query: { stream: "false", "one-shot": "true" },
            timeoutMs: 5_000,
          });
          const sample = parseContainerStats(raw, id, at);
          // Without a limit Docker reports the host's memory; that is not a limit.
          if (sample.memoryLimitBytes !== null && sample.memoryLimitBytes >= totalmem())
            sample.memoryLimitBytes = null;
          return sample;
        } catch {
          return null; // Stopped between listing and sampling.
        }
      });
      return samples.filter((sample): sample is ContainerStatsSample => sample !== null);
    },

    async controlContainer(id, action) {
      const container = await findOne(id);
      await transport.json(`/containers/${container.summary.id}/${action}`, {
        method: "POST",
        // Docker sends SIGKILL after 10 s; allow for that plus slow shutdowns.
        query: action === "start" ? {} : { t: "10" },
        timeoutMs: 60_000,
        okStatuses: [304],
      });
    },

    async *logs(id, logOptions, signal) {
      const container = await findOne(id);
      const inspect = (await transport.json(`/containers/${container.summary.id}/json`)) as {
        Config?: { Tty?: boolean };
      };
      const response = await transport.open(`/containers/${container.summary.id}/logs`, {
        query: {
          stdout: "1",
          stderr: "1",
          timestamps: "1",
          follow: logOptions.follow ? "1" : "0",
          tail: String(logOptions.tail),
          ...(logOptions.since !== undefined
            ? { since: String(Math.floor(logOptions.since / 1000)) }
            : {}),
        },
        timeoutMs: logOptions.follow ? 0 : 30_000,
        signal,
      });
      const abort = () => response.destroy();
      signal.addEventListener("abort", abort, { once: true });
      const pending = { stdout: "", stderr: "" };
      const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
      const MAX_LINE = 16 * 1024;
      const demux = inspect.Config?.Tty === true ? null : new LogDemuxer();
      try {
        for await (const chunk of response as AsyncIterable<Buffer>) {
          const frames = demux ? demux.push(chunk) : [{ stream: "stdout" as const, data: chunk }];
          for (const frame of frames) {
            const text = pending[frame.stream] + decoders[frame.stream].write(frame.data);
            const lines = text.split("\n");
            pending[frame.stream] = (lines.pop() ?? "").slice(-MAX_LINE);
            for (const line of lines)
              yield parseLogLine(frame.stream, line.slice(0, MAX_LINE).replace(/\r$/, ""));
          }
        }
        for (const stream of ["stdout", "stderr"] as const) {
          pending[stream] += decoders[stream].end();
          if (pending[stream]) yield parseLogLine(stream, pending[stream]);
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      } finally {
        signal.removeEventListener("abort", abort);
        response.destroy();
      }
    },

    async listImages() {
      const [raw, containers] = await Promise.all([transport.json("/images/json"), listed()]);
      return parseImages(raw, containers);
    },

    async removeImage(id) {
      const images = parseImages(await transport.json("/images/json"), await listed());
      const image = images.find(
        (candidate) => candidate.id === id || candidate.id === `sha256:${id}`,
      );
      if (!image) throw new DockerError("not-found", "Image not found");
      if (image.usedBy.length > 0)
        throw new DockerError("conflict", "Image is used by a container");
      await transport.json(`/images/${encodeURIComponent(image.id)}`, {
        method: "DELETE",
        timeoutMs: 60_000,
      });
    },

    async listVolumes() {
      const [raw, containers, sizes] = await Promise.all([
        transport.json("/volumes"),
        listed(),
        transport
          .json("/system/df", { query: { type: "volume" }, timeoutMs: 20_000 })
          .then(parseVolumeSizes)
          .catch(() => new Map<string, number>()),
      ]);
      return parseVolumes(raw, sizes, containers);
    },

    async removeVolume(name) {
      const volumes = parseVolumes(await transport.json("/volumes"), new Map(), await listed());
      const volume = volumes.find((candidate) => candidate.name === name);
      if (!volume) throw new DockerError("not-found", "Volume not found");
      if (volume.usedBy.length > 0)
        throw new DockerError("conflict", "Volume is used by a container");
      await transport.json(`/volumes/${encodeURIComponent(name)}`, {
        method: "DELETE",
        timeoutMs: 60_000,
      });
    },

    async listNetworks() {
      const [raw, containers] = await Promise.all([transport.json("/networks"), listed()]);
      return parseNetworks(raw, containers);
    },

    async ensureAiNetwork() {
      const inspect = () =>
        transport.json(`/networks/${EVERYOS_AI_NETWORK}`).catch((error: unknown) => {
          if (error instanceof DockerError && error.kind === "not-found") return null;
          throw error;
        });
      let network = await inspect();
      if (network === null) {
        await transport
          .json("/networks/create", {
            method: "POST",
            timeoutMs: 30_000,
            body: {
              Name: EVERYOS_AI_NETWORK,
              Driver: "bridge",
              // Members keep their own project network for outside access; this one has none.
              Internal: true,
              Labels: { [AI_NETWORK_LABEL]: "ai" },
            },
          })
          .catch((error: unknown) => {
            if (!(error instanceof DockerError && error.kind === "conflict")) throw error;
          });
        network = await inspect();
      }
      const record = (network ?? {}) as { Labels?: Record<string, unknown>; Internal?: unknown };
      if (record.Labels?.[AI_NETWORK_LABEL] !== "ai" || record.Internal !== true)
        throw new DockerError("conflict", "The AI network exists but was not created by EveryOS");
    },

    async removeNetwork(id) {
      const networks = parseNetworks(await transport.json("/networks"), await listed());
      const network = networks.find(
        (candidate) => candidate.id === id || candidate.id.startsWith(id),
      );
      if (!network) throw new DockerError("not-found", "Network not found");
      if (network.builtIn) throw new DockerError("invalid", "Built-in networks cannot be removed");
      if (network.usedBy.length > 0)
        throw new DockerError("conflict", "Network is used by a container");
      await transport.json(`/networks/${network.id}`, { method: "DELETE", timeoutMs: 30_000 });
    },

    async listProjects() {
      return composeProjects(await listed());
    },

    async checkProject(project) {
      const found = composeProjects(await listed()).find((candidate) => candidate.name === project);
      if (!found) throw new DockerError("not-found", "Compose project not found");
      return checkComposeFiles(found.name, found.workingDir, found.configFiles);
    },

    async runCompose(project, workingDir, files, action, signal, input) {
      try {
        const { path } = await transport.connection();
        return await runCompose(project, workingDir, files, action, path, signal, input);
      } catch (error) {
        if (error instanceof ComposeError)
          throw new DockerError(
            error.kind === "unavailable" ? "unsupported" : "invalid",
            error.message,
          );
        throw error;
      }
    },

    async postgresStats(container, user, database, signal) {
      if (!SQL_IDENTIFIER.test(user) || !SQL_IDENTIFIER.test(database))
        throw new DockerError("invalid", "Invalid PostgreSQL role or database name");
      const found = (await listed()).find(
        (candidate) =>
          candidate.summary.name === container || candidate.summary.id.startsWith(container),
      );
      if (!found) throw new DockerError("not-found", "Container not found");
      if (found.summary.state !== "running")
        throw new DockerError("conflict", "Container is not running");
      if (!POSTGRES_IMAGE.test(found.summary.image))
        throw new DockerError("invalid", "Not a PostgreSQL container");
      const exec = (await transport.json(`/containers/${found.summary.id}/exec`, {
        method: "POST",
        body: {
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
          Cmd: [
            "psql",
            "-U",
            user,
            "-d",
            database,
            "-AtqX",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            POSTGRES_STATS_SQL,
          ],
        },
        timeoutMs: 10_000,
      })) as { Id?: unknown };
      if (typeof exec.Id !== "string" || !/^[a-f0-9]{64}$/.test(exec.Id))
        throw new DockerError("failed", "Docker did not create the exec instance");
      const response = await transport.open(`/exec/${exec.Id}/start`, {
        method: "POST",
        body: { Detach: false, Tty: false },
        timeoutMs: 15_000,
        ...(signal ? { signal } : {}),
      });
      const demux = new LogDemuxer();
      const output = { stdout: "", stderr: "" };
      for await (const chunk of response as AsyncIterable<Buffer>) {
        for (const frame of demux.push(chunk)) {
          output[frame.stream] += frame.data.toString("utf8");
          if (output.stdout.length + output.stderr.length > 1024 * 1024) {
            response.destroy();
            throw new DockerError("too-large", "psql produced too much output");
          }
        }
      }
      const result = (await transport.json(`/exec/${exec.Id}/json`)) as { ExitCode?: unknown };
      if (result.ExitCode !== 0) {
        const message = output.stderr.trim().split("\n")[0]?.slice(0, 200) ?? "";
        throw new DockerError("failed", `psql failed${message ? `: ${message}` : ""}`);
      }
      const line = output.stdout.split("\n").find((candidate) => candidate.startsWith("{"));
      return parsePostgresStats(line ?? "");
    },

    async *events(signal) {
      const response = await transport.open("/events", {
        query: {
          filters: JSON.stringify({
            type: Object.keys(RELAYED_EVENTS),
            event: [...new Set(Object.values(RELAYED_EVENTS).flat())],
          }),
        },
        timeoutMs: 0,
        signal,
      });
      const lines = createInterface({ input: response, crlfDelay: Infinity });
      // readline only finishes on "end"; a destroyed response must close it explicitly.
      const abort = () => {
        lines.close();
        response.destroy();
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        for await (const line of lines) {
          if (line.length > 64 * 1024) continue;
          const event = parseDockerEvent(line);
          if (event) yield event;
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      } finally {
        signal.removeEventListener("abort", abort);
        lines.close();
        response.destroy();
      }
    },
  };
}
