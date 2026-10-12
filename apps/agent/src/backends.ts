import {
  createDockerClient,
  createDockerSimulator,
  createJournalSource,
  createSimulator,
  createSystemdManager,
  detectCapabilities,
  pathKind,
  REAL_HOST,
  type DockerApi,
  type LogSource,
  type ServiceManager,
} from "@everyos/system";
import type { AgentConfig } from "./config.ts";
/**
 * Picks the real systemd/journald backends, or the simulator in development
 * when they are missing (macOS) or explicitly requested. Production never
 * uses simulated data: missing tools surface as "unsupported" errors.
 */
export async function selectBackends(
  config: Pick<AgentConfig, "mode" | "simulate" | "dockerSocket">,
  isProtectedContainer: (name: string) => boolean,
): Promise<{ services: ServiceManager; logs: LogSource; docker: DockerApi }> {
  const capabilities = await detectCapabilities(REAL_HOST, null);
  const simulator = config.mode === "development" ? createSimulator() : null;
  const services =
    simulator && (config.simulate || !capabilities.systemd.available)
      ? simulator.services
      : createSystemdManager();
  const logs =
    simulator && (config.simulate || !capabilities.journald.available)
      ? simulator.logs
      : createJournalSource();
  const dockerSocketPresent = config.dockerSocket
    ? (await pathKind(config.dockerSocket)) !== "missing"
    : capabilities.docker.available || capabilities.docker.reason === "permission-denied";
  const docker =
    config.mode === "development" && (config.simulate || !dockerSocketPresent)
      ? createDockerSimulator({ isProtected: isProtectedContainer })
      : createDockerClient({
          ...(config.dockerSocket ? { socketPaths: [config.dockerSocket] } : {}),
          isProtected: isProtectedContainer,
        });
  return { services, logs, docker };
}
