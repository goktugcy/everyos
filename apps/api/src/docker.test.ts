import type {
  ApiErrorBody,
  AuditPage,
  ComposeActionResult,
  ComposeProjectView,
  ContainerDetail,
  ContainerStatsSample,
  DockerContainerView,
  DockerStatsSnapshot,
  ImageList,
  NetworkList,
  VolumeList,
} from "@otuken/shared";
import { silentLogger } from "@otuken/logger";
import { describe, expect, it } from "vitest";
import { computeContainerPoint, DockerHub } from "./modules/docker/docker-hub.ts";
import { FakeAgent, json, readEvents, withRoles, type TestClient } from "./test-support.ts";

const errorCode = async (response: Response) => (await json<ApiErrorBody>(response)).error.code;

async function containers(client: TestClient): Promise<DockerContainerView[]> {
  return (
    await json<{ containers: DockerContainerView[] }>(await client.get("/api/docker/containers"))
  ).containers;
}

async function idOf(client: TestClient, name: string): Promise<string> {
  const found = (await containers(client)).find((c) => c.name === name);
  if (!found) throw new Error(`container ${name} not found`);
  return found.id;
}

async function auditFor(admin: TestClient, prefix: string) {
  const page = await json<AuditPage>(await admin.get("/api/audit?limit=100"));
  return page.events.filter((event) => event.action.startsWith(prefix));
}

describe("container stats math", () => {
  const sample = (at: number, cpu: number, system: number, rx: number): ContainerStatsSample => ({
    id: "a".repeat(64),
    at,
    cpuTotalNs: cpu,
    systemCpuNs: system,
    onlineCpus: 4,
    memoryBytes: 100,
    memoryLimitBytes: 1000,
    netRxBytes: rx,
    netTxBytes: 0,
    blockReadBytes: null,
    blockWriteBytes: 0,
    pids: 3,
  });

  it("uses the docker stats CPU formula between two one-shot samples", () => {
    // 1 s of CPU time out of 8 s of system time on 4 CPUs → 50 %.
    const point = computeContainerPoint(sample(0, 0, 0, 0), sample(2_000, 1e9, 8e9, 4_000));
    expect(point).toMatchObject({
      cpuPercent: 50,
      netRxBytesPerSec: 2_000,
      blockReadBytesPerSec: null,
      pids: 3,
    });
    expect(computeContainerPoint(undefined, sample(0, 0, 0, 0)).cpuPercent).toBeNull();
    // A restarted container resets its counters: no negative rates.
    expect(
      computeContainerPoint(sample(0, 5e9, 1e9, 9_000), sample(1_000, 1e9, 2e9, 10))
        .netRxBytesPerSec,
    ).toBeNull();
  });

  it("keeps per-container history only while sampling", async () => {
    const agent = new FakeAgent();
    let now = 1_760_000_000_000;
    agent.now = () => now;
    const hub = new DockerHub({ agent, logger: silentLogger, now: () => now, intervalMs: 60_000 });
    await hub.sample();
    now += 5_000;
    await hub.sample();
    const snapshot = hub.latest!;
    expect(snapshot.source).toBe("simulated");
    const [id, point] = Object.entries(snapshot.containers)[0]!;
    expect(point.cpuPercent).not.toBeNull();
    expect(hub.history(id).points).toHaveLength(2);
    hub.stop();
  });
});

describe("docker API", () => {
  it("rejects unexpected parameters before submitting Docker mutations", async () => {
    const { ctx, operator } = await withRoles();
    const id = await idOf(operator, "jellyfin");
    for (const path of [
      "",
      "/containers",
      `/containers/${id}`,
      `/containers/${id}/stats`,
      "/stats",
      "/images",
      "/volumes",
      "/networks",
      "/projects",
    ]) {
      expect((await operator.get(`/api/docker${path}?force=true`)).status, path).toBe(400);
    }
    expect(
      (await operator.post(`/api/docker/containers/${id}/actions`, { action: "stop", force: true }))
        .status,
    ).toBe(400);
    expect(
      (await operator.post(`/api/docker/containers/${id}/actions?force=true`, { action: "stop" }))
        .status,
    ).toBe(400);
    expect(
      (
        await operator.request("DELETE", "/api/docker/images/" + "a".repeat(64), {
          body: { force: true },
        })
      ).status,
    ).toBe(400);
    expect(
      (await operator.request("DELETE", "/api/docker/networks/" + "a".repeat(64), { body: {} }))
        .status,
    ).toBe(400);
    expect(
      (await operator.request("DELETE", "/api/docker/projects/media/import", { body: {} })).status,
    ).toBe(400);
    expect(
      ctx.agent.calls.some((call) =>
        ["docker.containers.control", "docker.images.remove", "docker.networks.remove"].includes(
          call.op,
        ),
      ),
    ).toBe(false);
  });
  it("lets every role see Docker, but only operators control it", async () => {
    const { viewer, operator } = await withRoles();
    const list = await containers(viewer);
    expect(list.length).toBeGreaterThan(5);
    expect(list.every((c) => c.ownership === "external")).toBe(true);
    for (const path of ["", "/images", "/volumes", "/networks", "/projects"]) {
      expect((await viewer.get(`/api/docker${path}`)).status, path).toBe(200);
    }
    const id = await idOf(viewer, "jellyfin");
    const denied = await viewer.post(`/api/docker/containers/${id}/actions`, { action: "stop" });
    expect(denied.status).toBe(403);
    expect(await errorCode(denied)).toBe("FORBIDDEN");
    // Container logs additionally need logs:read.
    expect((await viewer.get(`/api/docker/containers/${id}/logs`)).status).toBe(403);
    expect(
      (await operator.post(`/api/docker/containers/${id}/actions`, { action: "stop" })).status,
    ).toBe(202);
    expect((await containers(operator)).find((c) => c.id === id)?.state).toBe("exited");
  });

  it("returns container details without environment values", async () => {
    const { operator } = await withRoles();
    const id = await idOf(operator, "nextcloud-db");
    const detail = await json<ContainerDetail & { ownership: string }>(
      await operator.get(`/api/docker/containers/${id}`),
    );
    expect(detail.envKeys).toContain("POSTGRES_PASSWORD");
    expect(detail.ownership).toBe("external");
    expect((await operator.get("/api/docker/containers/not-an-id")).status).toBe(400);
    expect((await operator.get(`/api/docker/containers/${"f".repeat(64)}`)).status).toBe(404);
  });

  it("audits container actions with the container name", async () => {
    const { admin, operator } = await withRoles();
    const id = await idOf(operator, "qbittorrent");
    await operator.post(`/api/docker/containers/${id}/actions`, { action: "restart" });
    expect(await auditFor(admin, "docker.containers")).toContainEqual(
      expect.objectContaining({
        action: "docker.containers.restart",
        target: "qbittorrent",
        outcome: "success",
      }),
    );
  });

  it("only removes unused images and networks; built-in networks never", async () => {
    const { operator } = await withRoles();
    const images = (await json<ImageList>(await operator.get("/api/docker/images"))).images;
    const used = images.find((image) => image.usedBy.length > 0)!;
    const unused = images.find((image) => image.tags.includes("redis:7-alpine"))!;
    const usedResponse = await operator.delete(`/api/docker/images/${encodeURIComponent(used.id)}`);
    expect(usedResponse.status).toBe(409);
    expect(await errorCode(usedResponse)).toBe("CONFLICT");
    expect(
      (await operator.delete(`/api/docker/images/${encodeURIComponent(unused.id)}`)).status,
    ).toBe(204);

    const networks = (await json<NetworkList>(await operator.get("/api/docker/networks"))).networks;
    const bridge = networks.find((n) => n.name === "bridge")!;
    const unusedNet = networks.find((n) => n.name === "unused_net")!;
    expect((await operator.delete(`/api/docker/networks/${bridge.id}`)).status).toBe(400);
    expect((await operator.delete(`/api/docker/networks/${unusedNet.id}`)).status).toBe(204);
  });

  it("deletes volume data only for administrators who type the name", async () => {
    const { admin, operator } = await withRoles();
    const volumes = (await json<VolumeList>(await admin.get("/api/docker/volumes"))).volumes;
    expect(volumes.find((v) => v.name === "cloud_db")?.usedBy).toEqual(["nextcloud-db"]);
    const remove = (client: TestClient, name: string, confirmName: string) =>
      client.request("DELETE", `/api/docker/volumes/${name}`, { body: { confirmName } });
    expect((await remove(operator, "orphan_volume", "orphan_volume")).status).toBe(403);
    expect((await remove(admin, "orphan_volume", "wrong")).status).toBe(400);
    expect((await remove(admin, "cloud_db", "cloud_db")).status).toBe(409);
    expect((await remove(admin, "orphan_volume", "orphan_volume")).status).toBe(204);
    expect(await auditFor(admin, "docker.volumes")).toContainEqual(
      expect.objectContaining({
        action: "docker.volumes.remove",
        target: "orphan_volume",
        outcome: "success",
      }),
    );
  });

  it("manages Compose projects only after an explicit import", async () => {
    const { ctx, admin, operator } = await withRoles();
    const projects = async () =>
      (await json<{ projects: ComposeProjectView[] }>(await operator.get("/api/docker/projects")))
        .projects;
    expect((await projects()).find((p) => p.name === "media")?.ownership).toBe("external");

    const refused = await operator.post("/api/docker/projects/media/actions", { action: "down" });
    expect(refused.status).toBe(409);
    expect(ctx.agent.calls.some((call) => call.op === "docker.compose.run")).toBe(false);

    expect((await operator.post("/api/docker/projects/media/import", {})).status).toBe(201);
    const media = (await projects()).find((p) => p.name === "media")!;
    expect(media).toMatchObject({
      ownership: "imported",
      importedBy: "operator",
      configFiles: ["/srv/media/compose.yaml"],
    });
    expect(
      (await containers(operator))
        .filter((c) => c.project === "media")
        .every((c) => c.ownership === "imported"),
    ).toBe(true);

    const down = await operator.post("/api/docker/projects/media/actions", { action: "down" });
    expect(down.status).toBe(200);
    expect((await json<ComposeActionResult>(down)).ok).toBe(true);
    expect(ctx.agent.calls.at(-1)).toMatchObject({
      op: "docker.compose.run",
      params: {
        project: "media",
        workingDir: "/srv/media",
        configFiles: ["/srv/media/compose.yaml"],
        action: "down",
      },
    });
    // The project stays manageable without containers, and `down` kept its volume.
    expect((await projects()).find((p) => p.name === "media")?.containers.total).toBe(0);
    expect(
      (await json<VolumeList>(await operator.get("/api/docker/volumes"))).volumes.some(
        (v) => v.name === "media_config",
      ),
    ).toBe(true);
    expect(
      (await operator.post("/api/docker/projects/media/actions", { action: "up" })).status,
    ).toBe(200);
    expect((await containers(operator)).filter((c) => c.project === "media")).toHaveLength(2);

    expect((await operator.delete("/api/docker/projects/media/import")).status).toBe(204);
    expect((await projects()).find((p) => p.name === "media")?.ownership).toBe("external");
    const audit = await auditFor(admin, "docker.projects");
    expect(audit.map((e) => [e.action, e.outcome])).toEqual(
      expect.arrayContaining([
        ["docker.projects.down", "denied"],
        ["docker.projects.import", "success"],
        ["docker.projects.down", "success"],
        ["docker.projects.up", "success"],
        ["docker.projects.unimport", "success"],
      ]),
    );
  });

  it("asks for acknowledgement before importing a project another tool manages", async () => {
    const { operator, viewer } = await withRoles();
    const response = await operator.post("/api/docker/projects/big-bear-pihole/import", {});
    expect(response.status).toBe(409);
    expect((await json<ApiErrorBody>(response)).error.details).toEqual({ managerHint: "casaos" });
    expect(
      (
        await operator.post("/api/docker/projects/big-bear-pihole/import", {
          acknowledgeManager: true,
        })
      ).status,
    ).toBe(201);
    expect((await viewer.post("/api/docker/projects/cloud/import", {})).status).toBe(403);
    expect((await operator.post("/api/docker/projects/Bad..Name/import", {})).status).toBe(400);
    expect((await operator.post("/api/docker/projects/unknown/import", {})).status).toBe(404);
  });

  it("streams container logs", async () => {
    const { operator } = await withRoles();
    const id = await idOf(operator, "jellyfin");
    const response = await operator.get(`/api/docker/containers/${id}/logs?tail=3`);
    expect(response.status).toBe(200);
    const { events, reader } = await readEvents(response, 5);
    expect(events.map((e) => e.event)).toEqual(["ready", "line", "line", "line", "end"]);
    expect(events[1]!.data).toMatchObject({ stream: "stdout" });
    await reader.cancel();
    expect((await operator.get(`/api/docker/containers/${id}/logs?tail=99999`)).status).toBe(400);
  });

  it("pushes container stats and change events on the docker topic", async () => {
    const { ctx, operator } = await withRoles();
    const response = await operator.get("/api/events?topics=docker");
    expect(response.status).toBe(200);
    const first = await readEvents(response, 2);
    expect(first.events.map((e) => e.event)).toEqual(["ready", "docker.stats"]);
    expect((first.events[1]!.data as DockerStatsSnapshot).source).toBe("simulated");
    const id = await idOf(operator, "jellyfin");
    // The change is relayed from Docker's event stream to subscribed browsers.
    const pending = readEvents(
      { body: { getReader: () => first.reader } } as unknown as Response,
      1,
      3_000,
    );
    await operator.post(`/api/docker/containers/${id}/actions`, { action: "stop" });
    const { events } = await pending;
    expect(events[0]).toMatchObject({
      event: "docker.change",
      data: { type: "container", action: "stop", id },
    });
    await first.reader.cancel();
    await expect.poll(() => ctx.services.docker.subscriberCount).toBe(0);
  });
});
