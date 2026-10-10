import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readCatalog } from "./adapters.ts";
import { readZip } from "./archive.ts";
import { inspectCompose, object, parseCompose } from "./compose.ts";
import { prepareInstall } from "./install.ts";
import { addressAllowed, createCatalogFetcher, type CatalogFetcher } from "./fetch.ts";

// Original fixtures, intentionally unrelated to upstream catalog content.
export function zipFixture(
  files: Record<string, string>,
  modes: Record<string, number> = {},
): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const name = Buffer.from(path);
    const data = Buffer.from(content);
    const compressed = deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(((modes[path] ?? 0x81a4) << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const compose = "services:\n  test:\n    image: example.invalid/test:1.0\n";
const id = "6c134c11-e11c-46da-b8c3-120010330625";
function memory(contents: Record<string, string | Buffer>): CatalogFetcher {
  return {
    get: (url) => {
      const value = contents[url];
      return value === undefined
        ? Promise.reject(new Error("Missing fixture"))
        : Promise.resolve(Buffer.isBuffer(value) ? value : Buffer.from(value));
    },
  };
}

describe("catalog transport", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.31.1.1",
    "192.168.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:7f00:1::",
  ])("rejects nonpublic %s", (address) => {
    expect(addressAllowed(address)).toBe(false);
  });
  it("keeps metadata and mapped addresses blocked with private access enabled", () => {
    expect(addressAllowed("127.0.0.1", true)).toBe(true);
    expect(addressAllowed("169.254.169.254", true)).toBe(false);
    expect(addressAllowed("::ffff:127.0.0.1", true)).toBe(false);
    expect(addressAllowed("8.8.8.8")).toBe(true);
    expect(addressAllowed("2001:4860:4860::8888")).toBe(true);
  });
  it("pins DNS, checks redirects, and bounds responses", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "http://169.254.169.254/" });
        res.end();
      } else res.end("fixture-body");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      await expect(createCatalogFetcher().get(base)).rejects.toThrow("unsafe-address");
      const fetcher = createCatalogFetcher({ allowPrivate: true });
      let lookups = 0;
      const pinned = createCatalogFetcher({
        allowPrivate: true,
        resolve: () => {
          lookups++;
          return Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
        },
      });
      expect((await pinned.get(`http://catalog-fixture.invalid:${port}`)).toString()).toBe(
        "fixture-body",
      );
      expect(lookups).toBe(1);
      expect((await fetcher.get(base)).toString()).toBe("fixture-body");
      await expect(fetcher.get(`${base}/redirect`)).rejects.toThrow("unsafe-address");
      await expect(fetcher.get(base, 2)).rejects.toThrow("too-large");
      await expect(fetcher.get(`http://user:password@127.0.0.1:${port}`)).rejects.toThrow(
        "invalid-url",
      );
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

describe("catalog archives and policies", () => {
  it("reads metadata without extracting scripts and rejects traversal, symlinks, bombs and corrupt data", () => {
    const archive = zipFixture({
      "repo/Apps/Test/docker-compose.yml": compose,
      "repo/run.sh": "never run me",
    });
    expect([...readZip(archive).keys()]).toEqual(["Apps/Test/docker-compose.yml"]);
    expect(() => readZip(zipFixture({ "../escape.yml": compose }))).toThrow("unsafe-path");
    expect(() => readZip(zipFixture({ "link.yml": compose }, { "link.yml": 0xa1ff }))).toThrow(
      "unsafe-archive",
    );
    expect(() => readZip(zipFixture({ "bomb.yml": "a".repeat(512 * 1024 + 1) }))).toThrow(
      "too-large",
    );
    const corrupt = Buffer.from(archive);
    corrupt[60] = (corrupt[60] ?? 0) ^ 255;
    expect(() => readZip(corrupt)).toThrow();
  });
  it("derives risks and blockers from Compose and never inherits bare environment", () => {
    const analysis = inspectCompose(
      `${compose}    privileged: true\n    network_mode: host\n    pid: host\n    devices: [/dev/video0]\n    cap_add: [SYS_ADMIN]\n    security_opt: [seccomp:unconfined]\n    volumes: [/var/run/docker.sock:/var/run/docker.sock, /etc:/host]\n    env_file: .env\n    post_start: [{command: echo forbidden}]\n    environment: [HOST_SECRET, 'PASSWORD=\${DB_PASSWORD:-unsafe-default}']\n`,
    );
    expect(analysis.risks).toEqual(
      expect.arrayContaining([
        "privileged",
        "host-network",
        "host-pid",
        "devices",
        "cap-add",
        "security-opt-unconfined",
        "docker-socket",
        "sensitive-host-path",
      ]),
    );
    expect(analysis.blockers).toEqual(
      expect.arrayContaining(["compose.env_file", "compose.post_start"]),
    );
    expect(analysis.variables.find((entry) => entry.key === "HOST_SECRET")?.required).toBe(true);
    expect(analysis.variables.find((entry) => entry.key === "DB_PASSWORD")?.secret).toBe(true);
  });
});

describe("catalog formats", () => {
  it("generates credentials with declared sizes and accepts only declared overrides", async () => {
    const input = `${compose}    environment: [SERVICE_USER_TEST_64_NAME, SERVICE_PASSWORD_64_TEST, SERVICE_PASSWORDWITHSYMBOLS_TEST, SERVICE_HEX_128_TEST]\n`;
    const result = await readCatalog({
      catalogId: id,
      url: "https://fixture.invalid/generators.yml",
      format: "auto",
      fetcher: memory({ "https://fixture.invalid/generators.yml": input }),
    });
    const app = result.apps[0]!;
    const render = (variables: Record<string, string>) =>
      prepareInstall(app, id, { variables, ports: [] });
    const env = (rendered: string) =>
      object(object(object(parseCompose(rendered).services).test).environment);
    const generated = env(render({}));
    expect(generated.SERVICE_USER_TEST_64_NAME).toMatch(/^[a-f0-9]{16}$/);
    expect(generated.SERVICE_PASSWORD_64_TEST).toMatch(/^[a-f0-9]{64}$/);
    expect(generated.SERVICE_PASSWORDWITHSYMBOLS_TEST).toMatch(/^[a-f0-9]{31}!$/);
    expect(generated.SERVICE_HEX_128_TEST).toMatch(/^[a-f0-9]{128}$/);
    expect(env(render({})).SERVICE_PASSWORD_64_TEST).not.toBe(generated.SERVICE_PASSWORD_64_TEST);
    const chosen = env(
      render({
        SERVICE_USER_TEST_64_NAME: "known-user",
        SERVICE_PASSWORD_64_TEST: "known-$password",
      }),
    );
    expect(chosen.SERVICE_USER_TEST_64_NAME).toBe("known-user");
    expect(chosen.SERVICE_PASSWORD_64_TEST).toBe("known-$$password");
    expect(() => render({ UNDECLARED_PASSWORD: "forbidden" })).toThrow("unknown-variable");
  });
  it("exposes mount paths and access modes for installation review", () => {
    const analysis = inspectCompose(
      `${compose}    volumes:\n      - /etc:/host:ro\n      - data:/data\n      - /cache\n      - type: bind\n        source: /srv/app\n        target: /app\n        read_only: true\n`,
    );
    expect(analysis.mounts).toEqual([
      { service: "test", source: "/etc", target: "/host", kind: "bind", readOnly: true },
      { service: "test", source: "data", target: "/data", kind: "volume", readOnly: false },
      { service: "test", source: null, target: "/cache", kind: "volume", readOnly: false },
      { service: "test", source: "/srv/app", target: "/app", kind: "bind", readOnly: true },
    ]);
    expect(analysis.risks).toContain("sensitive-host-path");
  });
  it("preserves loopback port bindings and fixed credential relationships", async () => {
    const input = `${compose}    ports: ['127.0.0.1:8123:80']\n    environment: {PASSWORD: original-public-default}\n  db:\n    image: example.invalid/db:1\n    environment: {PASSWORD: original-public-default}\n`;
    const result = await readCatalog({
      catalogId: id,
      url: "https://fixture.invalid/a",
      format: "auto",
      fetcher: memory({ "https://fixture.invalid/a": input }),
    });
    const app = result.apps[0]!;
    expect(app.risks).toContain("default-secret");
    const prepared = prepareInstall(app, "test-instance", {
      variables: {},
      ports: [{ service: "test", index: 0, host: 9000 }],
    });
    expect(prepared).toContain("host_ip: 127.0.0.1");
    expect(prepared.match(/original-public-default/g)).toHaveLength(2);
  });
  it("normalizes CasaOS / Big Bear source metadata and removes fixed names", async () => {
    const source = zipFixture({
      "repo/Apps/Test/docker-compose.yml": `${compose}    container_name: host-owned-name\nx-casaos:\n  id: com.example.test\n  title: {tr_TR: Deneme, en_US: Test}\n  architectures: [arm64]\n`,
    });
    const result = await readCatalog({
      catalogId: id,
      url: "https://fixture.invalid/source.zip",
      format: "auto",
      fetcher: memory({ "https://fixture.invalid/source.zip": source }),
    });
    expect(result.apps[0]?.source.format).toBe("casaos-source");
    expect(result.apps[0]?.name.tr_TR).toBe("Deneme");
    expect(result.apps[0]?.compose).not.toContain("container_name");
  });
  it("resolves v2 files against base_url and records full content provenance", async () => {
    const contents = {
      "https://fixture.invalid/index.json": JSON.stringify({
        version: 2,
        base_url: "https://assets.invalid/v2/",
        apps: [
          {
            id: "test",
            compose_url: "apps/test.yml",
            meta_url: "apps/test.json",
            content_hash: "test",
          },
        ],
      }),
      "https://assets.invalid/v2/apps/test.yml": compose,
      "https://assets.invalid/v2/apps/test.json": JSON.stringify({
        title: "Test",
        description: "Original fixture",
      }),
    };
    const result = await readCatalog({
      catalogId: id,
      url: "https://fixture.invalid/index.json",
      format: "auto",
      fetcher: memory(contents),
    });
    expect(result.apps[0]?.source.ref).toBe(result.ref);
    const changed = await readCatalog({
      catalogId: id,
      url: "https://fixture.invalid/index.json",
      format: "auto",
      fetcher: memory({
        ...contents,
        "https://assets.invalid/v2/apps/test.yml": compose.replace("1.0", "2.0"),
      }),
    });
    expect(changed.ref).not.toBe(result.ref);
  });
  it("uses Runtipi native/dynamic selection rather than obsolete static YAML", async () => {
    const archive = zipFixture({
      "repo/apps/test/config.json": JSON.stringify({ tipi_version: 1, name: "Test", port: 8800 }),
      "repo/apps/test/docker-compose.yml": compose,
      "repo/apps/test/docker-compose.json": JSON.stringify({
        schemaVersion: 2,
        services: [
          { name: "test", image: "example.invalid/current:2", isMain: true, internalPort: 80 },
        ],
      }),
    });
    const result = await readCatalog({
      catalogId: id,
      url: "https://fixture.invalid/a.zip",
      format: "auto",
      fetcher: memory({ "https://fixture.invalid/a.zip": archive }),
    });
    expect(result.apps[0]?.images).toEqual(["example.invalid/current:2"]);
    expect(result.apps[0]?.ports[0]?.host).toBe(8800);
  });
  it("reads Coolify JSON as data and identifies secret generators", async () => {
    const result = await readCatalog({
      catalogId: id,
      url: "https://fixture.invalid/c.json",
      format: "coolify",
      fetcher: memory({
        "https://fixture.invalid/c.json": JSON.stringify({
          test: {
            slogan: "Original",
            compose: Buffer.from(`${compose}    environment: [SERVICE_PASSWORD_TEST]\n`).toString(
              "base64",
            ),
          },
        }),
      }),
    });
    expect(result.apps[0]?.variables[0]).toMatchObject({
      key: "SERVICE_PASSWORD_TEST",
      secret: true,
      generated: true,
    });
  });
  it("converts Portainer container templates and reports unsupported swarm entries", async () => {
    const result = await readCatalog({
      catalogId: id,
      url: "https://fixture.invalid/p.json",
      format: "auto",
      fetcher: memory({
        "https://fixture.invalid/p.json": JSON.stringify({
          version: "3",
          templates: [
            {
              type: 1,
              title: "Test",
              image: "example.invalid/test:1",
              ports: ["8080:80/tcp"],
              env: [{ name: "PASSWORD" }],
            },
            { type: 2, title: "Swarm" },
          ],
        }),
      }),
    });
    expect(result.apps[0]?.source.format).toBe("portainer");
    expect(result.skipped[0]?.reason).toBe("unsupported-portainer-type");
  });
  it("accepts plain compose and refuses empty, foreign, and Umbrel sources", async () => {
    const read = (value: string | Buffer) =>
      readCatalog({
        catalogId: id,
        url: "https://fixture.invalid/a",
        format: "auto",
        fetcher: memory({ "https://fixture.invalid/a": value }),
      });
    expect((await read(compose)).apps[0]?.source.format).toBe("compose-dir");
    await expect(read("hi")).rejects.toThrow("no-valid-apps");
    await expect(
      read(
        zipFixture({
          "repo/umbrel-app.yml": "manifestVersion: 1",
          "repo/docker-compose.yml": compose,
        }),
      ),
    ).rejects.toThrow("unsupported-umbrel");
  });
});
