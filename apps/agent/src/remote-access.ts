import { OperationError, type OperationHandlers } from "@everyos/agent-protocol";
import type {
  RemoteAccessNode,
  RemoteAccessProviderId,
  RemoteAccessInstallJob,
} from "@everyos/shared";
import {
  createRemoteAccessDrivers,
  emptyRemoteNode,
  installRemoteAccessProvider,
  RemoteAccessError,
  type AptManager,
  type RemoteAccessDriver,
} from "@everyos/system";

export function createRemoteAccessHandlers(options: {
  apt: AptManager;
  simulate: boolean;
  tailscaleSockets?: readonly string[];
  drivers?: Record<RemoteAccessProviderId, RemoteAccessDriver>;
}): Pick<
  OperationHandlers,
  | "remoteAccess.snapshot"
  | "remoteAccess.peers"
  | "remoteAccess.connect"
  | "remoteAccess.disconnect"
  | "remoteAccess.install"
> {
  const simulated = new Map<RemoteAccessProviderId, RemoteAccessNode>();
  for (const provider of ["tailscale", "netbird"] as const)
    simulated.set(provider, {
      ...emptyRemoteNode(provider),
      source: "simulated",
      installed: provider === "tailscale",
      available: provider === "tailscale",
      reason: provider === "tailscale" ? null : "not-installed",
      state: provider === "tailscale" ? "disconnected" : "unknown",
      installationSupported: true,
    });
  const drivers =
    options.drivers ??
    createRemoteAccessDrivers(
      options.tailscaleSockets ? { tailscaleSockets: options.tailscaleSockets } : {},
    );
  const pending = new Set<RemoteAccessProviderId>();
  const installations = new Map<RemoteAccessProviderId, RemoteAccessInstallJob>();
  let installing = false;
  const status = (provider: RemoteAccessProviderId) =>
    options.simulate
      ? Promise.resolve({ ...simulated.get(provider)! })
      : drivers[provider].status();
  // Coalesce telemetry polls from multiple browser sessions; mutations always read fresh state.
  let reading: Promise<RemoteAccessNode[]> | null = null;
  const read = () => {
    reading ??= Promise.all((["tailscale", "netbird"] as const).map(status)).finally(() => {
      reading = null;
    });
    return reading;
  };
  const snapshot = async () => ({
    providers: await read(),
    installations: [...installations.values()].map((job) => ({ ...job })),
  });
  const safeFailure = (error: unknown): never => {
    if (error instanceof OperationError) throw error;
    throw new OperationError(
      "failed",
      error instanceof RemoteAccessError ? error.message : "REMOTE_COMMAND_FAILED",
    );
  };
  return {
    "remoteAccess.snapshot": snapshot,
    "remoteAccess.peers": async ({ provider }) => {
      if (options.simulate)
        return {
          peers: [
            {
              name: "Simulated peer",
              addresses: ["100.64.0.20"],
              online: true,
              connection: "direct",
              lastSeen: null,
              rxBytes: 0,
              txBytes: 0,
            },
          ],
        };
      try {
        return { peers: await drivers[provider].peers() };
      } catch (error) {
        return safeFailure(error);
      }
    },
    "remoteAccess.connect": async (
      { provider, settings, credential, acknowledgeConflicts },
      { signal },
    ) => {
      if (pending.size || installing) throw new OperationError("busy", "REMOTE_BUSY");
      pending.add(provider);
      try {
        const all = {
          providers: await Promise.all((["tailscale", "netbird"] as const).map(status)),
        };
        if (
          !acknowledgeConflicts &&
          all.providers.some(
            (node) =>
              node.provider !== provider && ["connected", "connecting"].includes(node.state),
          )
        )
          throw new OperationError("conflict", "REMOTE_CONFLICT_ACK_REQUIRED");
        if (provider === "tailscale" && settings.managementUrl !== null)
          throw new OperationError("invalid_params", "REMOTE_PROVIDER_SETTINGS");
        if (options.simulate) {
          const initial = simulated.get(provider)!;
          if (!initial.installed) throw new OperationError("failed", "REMOTE_NOT_INSTALLED");
          simulated.set(provider, {
            ...initial,
            state: "connected",
            available: true,
            reason: null,
            managementUrl: settings.managementUrl,
            dnsEnabled: settings.acceptDNS,
            acceptsRoutes: settings.acceptRoutes,
            routeVisibility: true,
            defaultRoute: false,
            addresses: [provider === "tailscale" ? "100.64.0.11" : "100.80.0.12"],
            routes: settings.acceptRoutes ? ["10.20.0.0/16"] : [],
          });
          return status(provider);
        }
        return await drivers[provider].connect(settings, credential, signal);
      } catch (error) {
        return safeFailure(error);
      } finally {
        pending.delete(provider);
      }
    },
    "remoteAccess.disconnect": async ({ provider }, { signal }) => {
      if (pending.size || installing) throw new OperationError("busy", "REMOTE_BUSY");
      pending.add(provider);
      try {
        if (options.simulate) {
          const node = simulated.get(provider)!;
          simulated.set(provider, {
            ...node,
            state: "disconnected",
            routes: [],
            dnsEnabled: false,
            defaultRoute: false,
          });
          return status(provider);
        }
        return await drivers[provider].disconnect(signal);
      } catch (error) {
        return safeFailure(error);
      } finally {
        pending.delete(provider);
      }
    },
    "remoteAccess.install": ({ provider, configureRepository }, { logger }) => {
      if (installing || pending.size) throw new OperationError("busy", "REMOTE_BUSY");
      installing = true;
      const job: RemoteAccessInstallJob = {
        provider,
        status: "running",
        stage: "preparing",
        error: null,
        startedAt: Date.now(),
        finishedAt: null,
      };
      installations.set(provider, job);
      const result = { ...job };
      // Package ownership belongs to the agent, not an HTTP tab or the API process lifetime.
      const run = async () => {
        try {
          if (options.simulate) {
            simulated.set(provider, {
              ...simulated.get(provider)!,
              installed: true,
              available: true,
              reason: null,
              state: "needs-login",
            });
            job.status = "succeeded";
          } else {
            for await (const event of installRemoteAccessProvider(
              options.apt,
              provider,
              configureRepository,
              AbortSignal.timeout(35 * 60_000),
            )) {
              if (event.type === "stage") job.stage = event.stage;
              else {
                job.status = event.ok ? "succeeded" : "failed";
                job.error = event.error;
              }
            }
            if (job.status === "running") {
              job.status = "failed";
              job.error = "REMOTE_INSTALL_FAILED";
            }
          }
        } catch {
          job.status = "failed";
          job.error = "REMOTE_INSTALL_FAILED";
        } finally {
          job.stage = "done";
          job.finishedAt = Date.now();
          installing = false;
          logger.info("Remote access package installation finished", {
            provider,
            status: job.status,
            error: job.error,
          });
        }
      };
      void run();
      return result;
    },
  };
}
