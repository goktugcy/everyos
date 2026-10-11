import {
  isValidUnitName,
  type ServiceAction,
  type ServiceDetail,
  type ServiceList,
  type TimerSummary,
} from "@everyos/shared";
import { CommandError, findExecutable, runCommand } from "../exec.ts";
import {
  parseListTimers,
  parseListUnitFiles,
  parseListUnits,
  parseShow,
  serviceDetailFromShow,
  SHOW_PROPERTIES,
} from "../linux/systemd.ts";

export class ServiceError extends Error {
  readonly kind: "unavailable" | "not-found" | "invalid" | "failed";

  constructor(kind: ServiceError["kind"], message: string) {
    super(message);
    this.name = "ServiceError";
    this.kind = kind;
  }
}

/** Abstraction over systemd so the agent can use a simulator in development. */
export interface ServiceManager {
  readonly source: "host" | "simulated";
  list(isProtected: (unit: string) => boolean, signal?: AbortSignal): Promise<ServiceList>;
  get(
    unit: string,
    isProtected: (unit: string) => boolean,
    signal?: AbortSignal,
  ): Promise<ServiceDetail>;
  control(unit: string, action: ServiceAction, signal?: AbortSignal): Promise<void>;
  /** systemd timers (the host's scheduled tasks). */
  timers(signal?: AbortSignal): Promise<TimerSummary>;
}

async function systemctl(): Promise<string> {
  const path = await findExecutable("systemctl");
  if (!path) throw new ServiceError("unavailable", "systemctl is not installed");
  return path;
}

/** systemd via `systemctl` with JSON/KEY=VALUE output (no D-Bus bindings needed). */
export function createSystemdManager(): ServiceManager {
  return {
    source: "host",

    async list(isProtected, signal) {
      const bin = await systemctl();
      const common = ["--no-pager", "--no-legend", "--output=json", "--type=service"];
      const [units, files] = await Promise.all([
        runCommand(bin, ["list-units", "--all", ...common], {
          timeoutMs: 15_000,
          ...(signal ? { signal } : {}),
        }),
        runCommand(bin, ["list-unit-files", ...common], {
          timeoutMs: 15_000,
          ...(signal ? { signal } : {}),
        }),
      ]);
      const states = parseListUnitFiles(JSON.parse(files));
      const listed = parseListUnits(JSON.parse(units));
      const names = new Set(listed.map((unit) => unit.name));
      // Installed but never loaded units (e.g. disabled ones) only appear in list-unit-files.
      for (const file of states.keys()) {
        if (!names.has(file) && !file.includes("@")) {
          listed.push({
            name: file,
            description: "",
            load: "not-loaded",
            active: "inactive",
            sub: "dead",
          });
        }
      }
      return {
        source: "host",
        units: listed
          .filter((unit) => isValidUnitName(unit.name))
          .slice(0, 4000)
          .map((unit) => ({
            ...unit,
            unitFileState: states.get(unit.name) ?? null,
            protected: isProtected(unit.name),
          })),
      };
    },

    async get(unit, isProtected, signal) {
      if (!isValidUnitName(unit)) throw new ServiceError("invalid", "Invalid unit name");
      const bin = await systemctl();
      const output = await runCommand(
        bin,
        [
          "show",
          "--no-pager",
          "--timestamp=unix",
          `--property=${SHOW_PROPERTIES.join(",")}`,
          "--",
          unit,
        ],
        { timeoutMs: 10_000, ...(signal ? { signal } : {}) },
      );
      const props = parseShow(output);
      if (props.get("LoadState") === "not-found")
        throw new ServiceError("not-found", `Unit ${unit} not found`);
      return { source: "host", ...serviceDetailFromShow(props, isProtected(unit)) };
    },

    async control(unit, action, signal) {
      if (!isValidUnitName(unit)) throw new ServiceError("invalid", "Invalid unit name");
      const bin = await systemctl();
      try {
        // --no-ask-password: never wait for an interactive polkit prompt.
        await runCommand(bin, ["--no-ask-password", "--no-block", action, "--", unit], {
          timeoutMs: 30_000,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (error instanceof CommandError && error.stderr.includes("not found")) {
          throw new ServiceError("not-found", `Unit ${unit} not found`);
        }
        throw new ServiceError("failed", `systemctl ${action} ${unit} failed`);
      }
    },

    async timers(signal) {
      const bin = await systemctl();
      const output = await runCommand(
        bin,
        ["list-timers", "--all", "--no-pager", "--no-legend", "--output=json"],
        { timeoutMs: 10_000, ...(signal ? { signal } : {}) },
      );
      return { source: "host", timers: parseListTimers(JSON.parse(output)) };
    },
  };
}
