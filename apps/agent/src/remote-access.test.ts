import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "@everyos/logger";
import { AGENT_OPERATIONS, type OperationContext } from "@everyos/agent-protocol";
import type * as SystemModule from "@everyos/system";
import { createAptSimulator, emptyRemoteNode, type RemoteAccessDriver } from "@everyos/system";
import type { RemoteAccessProviderId } from "@everyos/shared";
import { createRemoteAccessHandlers } from "./remote-access.ts";
import { createPolicy } from "./policy.ts";

const install = vi.hoisted(() => ({
  release: null as (() => void) | null,
  signal: null as AbortSignal | null,
}));
vi.mock("@everyos/system", async (original) => ({
  ...(await original<typeof SystemModule>()),
  installRemoteAccessProvider: async function* (
    _apt: unknown,
    _provider: unknown,
    _configure: unknown,
    signal: AbortSignal,
  ) {
    install.signal = signal;
    yield { type: "stage", stage: "installing" };
    await new Promise<void>((resolve) => {
      install.release = resolve;
    });
    yield { type: "done", ok: true, error: null };
  },
}));
const context = (): OperationContext => ({
  actor: { kind: "user", userId: "admin", username: "owner", role: "admin" },
  signal: new AbortController().signal,
  logger: silentLogger,
});
const settings = { managementUrl: null, acceptDNS: true, acceptRoutes: true };
function drivers() {
  const make = (id: RemoteAccessProviderId) => ({
    id,
    status: vi.fn<RemoteAccessDriver["status"]>(() =>
      Promise.resolve({
        ...emptyRemoteNode(id),
        installed: true,
        available: true,
        state: "disconnected",
      }),
    ),
    peers: vi.fn<RemoteAccessDriver["peers"]>(() => Promise.resolve([])),
    connect: vi.fn<RemoteAccessDriver["connect"]>(() =>
      Promise.resolve({
        ...emptyRemoteNode(id),
        installed: true,
        available: true,
        state: "connected",
      }),
    ),
    disconnect: vi.fn<RemoteAccessDriver["disconnect"]>(() => Promise.resolve(emptyRemoteNode(id))),
  });
  return { tailscale: make("tailscale"), netbird: make("netbird") };
}
describe("remote access agent", () => {
  it("requires strict parameters, management permission and a user actor for all host mutations", () => {
    for (const op of [
      "remoteAccess.install",
      "remoteAccess.connect",
      "remoteAccess.disconnect",
      "remoteAccess.peers",
    ] as const) {
      expect(AGENT_OPERATIONS[op]).toMatchObject({
        permission: "system:manage",
        allowSystemActor: false,
      });
    }
    const schema = AGENT_OPERATIONS["remoteAccess.connect"].params;
    expect(
      schema.safeParse({
        provider: "netbird",
        settings,
        credential: "secret",
        acknowledgeConflicts: false,
      }).success,
    ).toBe(true);
    for (const value of [
      { provider: "unknown", settings, acknowledgeConflicts: false },
      {
        provider: "netbird",
        settings: { ...settings, managementUrl: "https://user:password@example.test" },
        acknowledgeConflicts: false,
      },
      { provider: "netbird", settings, credential: "secret\nflag", acknowledgeConflicts: false },
      { provider: "netbird", settings, shell: "command", acknowledgeConflicts: false },
    ])
      expect(schema.safeParse(value).success).toBe(false);
  });
  it("rechecks another connected provider, requires acknowledgment and changes only the requested provider", async () => {
    const host = drivers();
    vi.mocked(host.tailscale.status).mockResolvedValue({
      ...emptyRemoteNode("tailscale"),
      installed: true,
      available: true,
      state: "connected",
    });
    const handlers = createRemoteAccessHandlers({
      apt: createAptSimulator(),
      simulate: false,
      drivers: host,
    });
    const params = { provider: "netbird" as const, settings, acknowledgeConflicts: false };
    await expect(handlers["remoteAccess.connect"](params, context())).rejects.toThrow(
      "REMOTE_CONFLICT_ACK_REQUIRED",
    );
    expect(host.netbird.connect).not.toHaveBeenCalled();
    await handlers["remoteAccess.connect"]({ ...params, acknowledgeConflicts: true }, context());
    await handlers["remoteAccess.disconnect"]({ provider: "netbird" }, context());
    expect(host.netbird.connect).toHaveBeenCalledOnce();
    expect(host.netbird.disconnect).toHaveBeenCalledOnce();
    expect(host.tailscale.connect).not.toHaveBeenCalled();
    expect(host.tailscale.disconnect).not.toHaveBeenCalled();
  });
  it("serializes transitions across providers so concurrent connections cannot bypass conflict checks", async () => {
    const host = drivers();
    let release!: () => void;
    vi.mocked(host.tailscale.connect).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return emptyRemoteNode("tailscale");
    });
    const handlers = createRemoteAccessHandlers({
      apt: createAptSimulator(),
      simulate: false,
      drivers: host,
    });
    const first = handlers["remoteAccess.connect"](
      { provider: "tailscale", settings, acknowledgeConflicts: true },
      context(),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(
      handlers["remoteAccess.disconnect"]({ provider: "netbird" }, context()),
    ).rejects.toThrow("REMOTE_BUSY");
    release();
    await first;
  });
  it("requires conflict consent while another provider is still connecting and releases the mutation lock after failure", async () => {
    const host = drivers();
    vi.mocked(host.tailscale.status).mockResolvedValue({
      ...emptyRemoteNode("tailscale"),
      installed: true,
      available: true,
      state: "connecting",
    });
    const handlers = createRemoteAccessHandlers({
      apt: createAptSimulator(),
      simulate: false,
      drivers: host,
    });
    const params = { provider: "netbird" as const, settings, acknowledgeConflicts: false };
    await expect(handlers["remoteAccess.connect"](params, context())).rejects.toThrow(
      "REMOTE_CONFLICT_ACK_REQUIRED",
    );
    expect(host.netbird.connect).not.toHaveBeenCalled();
    vi.mocked(host.netbird.connect).mockRejectedValueOnce(new Error("private fixture error"));
    await expect(
      handlers["remoteAccess.connect"]({ ...params, acknowledgeConflicts: true }, context()),
    ).rejects.toThrow("REMOTE_COMMAND_FAILED");
    await handlers["remoteAccess.disconnect"]({ provider: "netbird" }, context());
    expect(host.tailscale.disconnect).not.toHaveBeenCalled();
  });
  it("continues a package job independently of the initiating request and exposes its completion", async () => {
    const handlers = createRemoteAccessHandlers({
      apt: createAptSimulator(),
      simulate: false,
      drivers: drivers(),
    });
    const controller = new AbortController();
    expect(
      await handlers["remoteAccess.install"](
        { provider: "netbird", configureRepository: true },
        { ...context(), signal: controller.signal },
      ),
    ).toMatchObject({ status: "running" });
    controller.abort();
    await vi.waitFor(() => expect(install.release).toBeTypeOf("function"));
    expect(install.signal?.aborted).toBe(false);
    expect((await handlers["remoteAccess.snapshot"]({}, context())).installations[0]?.stage).toBe(
      "installing",
    );
    await expect(
      handlers["remoteAccess.connect"](
        { provider: "tailscale", settings, acknowledgeConflicts: true },
        context(),
      ),
    ).rejects.toThrow("REMOTE_BUSY");
    install.release!();
    await vi.waitFor(async () =>
      expect(
        (await handlers["remoteAccess.snapshot"]({}, context())).installations[0],
      ).toMatchObject({ status: "succeeded", stage: "done", error: null }),
    );
  });
  it("labels simulation explicitly and denies real host mutations in development", async () => {
    const host = drivers(),
      handlers = createRemoteAccessHandlers({
        apt: createAptSimulator(),
        simulate: true,
        drivers: host,
      });
    await handlers["remoteAccess.install"](
      { provider: "netbird", configureRepository: true },
      context(),
    );
    expect(
      (
        await handlers["remoteAccess.connect"](
          { provider: "netbird", settings, acknowledgeConflicts: true },
          context(),
        )
      ).source,
    ).toBe("simulated");
    expect(host.netbird.connect).not.toHaveBeenCalled();
    for (const source of ["host", "simulated"] as const) {
      const policy = createPolicy({
        mode: "development",
        servicesSource: "simulated",
        dockerSource: "simulated",
        remoteAccessSource: source,
        isProtected: () => false,
      });
      for (const op of [
        "remoteAccess.connect",
        "remoteAccess.disconnect",
        "remoteAccess.install",
      ] as const)
        expect(policy(op, {}, context().actor)).toMatchObject({
          allowed: source === "simulated",
        });
    }
  });
});
