import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { crc32, deflateRawSync } from "node:zlib";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readCatalog } from "./adapters.ts";
import { readZip } from "./archive.ts";
import { inspectCompose, object, parseCompose } from "./compose.ts";
import { prepareInstall, selectArchitecture } from "./install.ts";
import { parseField, validateField } from "./fields.ts";
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

it("resolves linked identity defaults and automatic ports without widening loopback bindings", async () => {
  const template = `services:
  app:
    image: example.invalid/app:1
    environment:
      PUID: \${PUID}
      PGID: \${PGID}
      TZ: \${TZ}
    ports: ['127.0.0.1:8080:80', '5353:53/udp']
  second:
    image: example.invalid/second:1
    environment: {PUID: '1000', PGID: '1000', TZ: Etc/UTC}
`;
  const app = (
    await readCatalog({
      url: "https://fixture.invalid/app.yml",
      format: "compose-dir",
      catalogId: "00000000-0000-4000-8000-000000000001",
      fetcher: { get: () => Promise.resolve(Buffer.from(template)) },
    })
  ).apps[0]!;
  const defaults = { source: "host" as const, uid: 1801, gid: 1902, timezone: "Europe/Istanbul" };
  const prepared = parseCompose(
    prepareInstall(app, "instance", { variables: {}, ports: [] }, defaults),
  );
  const service = object(object(prepared.services).app);
  expect(service.environment).toEqual({ PUID: "1801", PGID: "1902", TZ: "Europe/Istanbul" });
  expect(object(object(prepared.services).second).environment).toEqual(service.environment);
  expect(service.ports).toEqual([
    { target: 80, protocol: "tcp", host_ip: "127.0.0.1" },
    { target: 53, protocol: "udp" },
  ]);
  const custom = parseCompose(
    prepareInstall(
      app,
      "instance",
      {
        variables: { TZ: "Europe/London" },
        ports: [{ service: "app", index: 0, host: 9001 }],
      },
      defaults,
    ),
  );
  expect(object(object(custom.services).app).ports).toEqual([
    { target: 80, published: "9001", protocol: "tcp", host_ip: "127.0.0.1" },
    { target: 53, protocol: "udp" },
  ]);
  expect(object(object(object(custom.services).app).environment).TZ).toBe("Europe/London");
});
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
  it("normalizes Coolify embedded configs and declared ingress ports without joining host proxies", async () => {
    const input = `${compose}    labels: {'traefik.enable': 'true', 'custom.label': 'keep'}\n    environment: [SERVICE_URL_TEST_8080]\n    volumes:\n      - source: ./config.txt\n        target: /config.txt\n        content: 'token=\${SERVICE_PASSWORD_TEST}'\n      - type: bind\n        source: ./uploads\n        target: /uploads\n        is_directory: true\n    exclude_from_hc: true\n`;
    const app = (
      await readCatalog({
        catalogId: id,
        url: "https://fixture.invalid/c",
        format: "coolify",
        fetcher: memory({
          "https://fixture.invalid/c": JSON.stringify({
            test: { slogan: "Original", compose: Buffer.from(input).toString("base64") },
          }),
        }),
      })
    ).apps[0]!;
    expect(app.blockers).toEqual([]);
    expect(app.ports[0]?.container).toBe(8080);
    expect(app.compose).toContain("{{otuken.configDir}}/config0");
    expect(app.compose).toContain("${APP_DATA_DIR}/uploads");
    expect(app.compose).not.toContain("traefik.enable");
    expect(app.compose).toContain("custom.label");
    const rendered = prepareInstall(app, id, {
      variables: { SERVICE_URL_TEST_8080: "https://test.example.org" },
      ports: [{ service: "test", index: 0, host: 9000 }],
    });
    expect(rendered).toContain("x-otuken-files");
    expect(rendered).not.toContain("${SERVICE_PASSWORD_TEST}");
    expect(() =>
      inspectCompose(`${compose}x-otuken-files: [{name: ../escape, content: secret}]\n`),
    ).toThrow("invalid-inline-files");
  });
  it("honors v2 repository metadata, prefixed URLs, architecture manifests and incremental identity", async () => {
    const root = "https://fixture.invalid/store/store.json",
      index = "https://fixture.invalid/store/index.json",
      base = "https://assets.invalid/repo@main";
    const entry = {
      id: "app",
      compose_url: "/apps/app.yml",
      meta_url: "/apps/app.json",
      content_hash: "native-hash",
      architectures: ["arm64"],
    };
    const contents = {
      [root]: JSON.stringify({
        version: 2,
        store_id: "test",
        url: "https://github.com/example/repository",
      }),
      [index]: JSON.stringify({ version: 2, base_url: base, apps: [entry] }),
      [`${base}/apps/app.yml`]: compose,
      [`${base}/apps/app.arm64.yml`]: compose.replace("test:1.0", "arm-test:2"),
      [`${base}/apps/app.json`]: JSON.stringify({
        title: "Original",
        screenshots: ["/apps/screen.png"],
      }),
    };
    const first = await readCatalog({
      catalogId: id,
      url: root,
      format: "auto",
      fetcher: memory(contents),
    });
    expect(first.apps[0]?.screenshots).toEqual([`${base}/apps/screen.png`]);
    expect(selectArchitecture(first.apps[0]!, "arm64").images).toEqual([
      "example.invalid/arm-test:2",
    ]);
    const second = await readCatalog({
      catalogId: id,
      url: root,
      format: "auto",
      previous: first.apps,
      fetcher: memory({ [root]: contents[root], [index]: contents[index] }),
    });
    expect(second.ref).toBe(first.ref);
    const changed = await readCatalog({
      catalogId: id,
      url: root,
      format: "auto",
      previous: second.apps,
      fetcher: memory({
        ...contents,
        [index]: JSON.stringify({ version: 2, base_url: base, apps: [{ ...entry, version: "2" }] }),
      }),
    });
    expect(changed.ref).not.toBe(first.ref);
  });
  it("applies Runtipi architecture overrides and validates declared generated fields", async () => {
    const archive = zipFixture({
      "repo/apps/app/config.json": JSON.stringify({
        tipi_version: 1,
        name: "App",
        form_fields: [
          { env_variable: "TOKEN", type: "random", min: 24, max: 24, encoding: "base64" },
        ],
      }),
      "repo/apps/app/docker-compose.json": JSON.stringify({
        schemaVersion: 2,
        services: [
          {
            name: "app",
            image: "example.invalid/x86:1",
            environment: [{ key: "TOKEN", value: "${TOKEN}" }],
          },
        ],
        overrides: [
          { architecture: "arm64", services: [{ name: "app", image: "example.invalid/arm:1" }] },
        ],
      }),
    });
    const app = (
      await readCatalog({
        catalogId: id,
        url: "https://fixture.invalid/t.zip",
        format: "auto",
        fetcher: memory({ "https://fixture.invalid/t.zip": archive }),
      })
    ).apps[0]!;
    const selected = selectArchitecture(app, "arm64");
    expect(selected.images).toEqual(["example.invalid/arm:1"]);
    const env = object(
      object(
        object(parseCompose(prepareInstall(selected, id, { variables: {}, ports: [] })).services)
          .app,
      ).environment,
    );
    expect(Buffer.from(String(env.TOKEN), "base64")).toHaveLength(24);
    expect(() =>
      prepareInstall(selected, id, { variables: { TOKEN: "short" }, ports: [] }),
    ).toThrow("invalid-field-value");
  });
  it("generates Supabase JWTs from one signing key and derives paired service URLs", async () => {
    const input = `${compose}    environment: [SERVICE_SUPABASEANON_APP, SERVICE_SUPABASESERVICE_APP, SERVICE_PASSWORD_JWT, SERVICE_URL_APP, SERVICE_FQDN_APP]\n`;
    const app = (
      await readCatalog({
        catalogId: id,
        url: "https://fixture.invalid/a",
        format: "auto",
        fetcher: memory({ "https://fixture.invalid/a": input }),
      })
    ).apps[0]!;
    const env = object(
      object(
        object(
          parseCompose(
            prepareInstall(app, id, {
              variables: { SERVICE_URL_APP: "https://app.example.org" },
              ports: [],
            }),
          ).services,
        ).test,
      ).environment,
    );
    expect(env.SERVICE_FQDN_APP).toBe("app.example.org");
    for (const [name, role] of [
      ["SERVICE_SUPABASEANON_APP", "anon"],
      ["SERVICE_SUPABASESERVICE_APP", "service_role"],
    ]) {
      const [header, body, signature] = String(env[name!]).split(".");
      expect(signature).toBe(
        createHmac("sha256", String(env.SERVICE_PASSWORD_JWT))
          .update(`${header}.${body}`)
          .digest("base64url"),
      );
      expect(JSON.parse(Buffer.from(body!, "base64url").toString())).toMatchObject({
        iss: "supabase",
        role,
      });
    }
    expect(() =>
      prepareInstall(app, id, { variables: { SERVICE_URL_APP: "file:///host" }, ports: [] }),
    ).toThrow("invalid-field-value");
  });
  it("isolates CasaOS app-data binds and bridge networks while retaining unrelated host risks", async () => {
    const input = `${compose}    network_mode: bridge\n    volumes: ['/DATA/AppData/demo/cache:/cache', '/DATA/Media:/media:ro']\nx-casaos: {title: Demo}\n`;
    const app = (
      await readCatalog({
        catalogId: id,
        url: "https://fixture.invalid/a",
        format: "auto",
        fetcher: memory({ "https://fixture.invalid/a": input }),
      })
    ).apps[0]!;
    expect(app.compose).toContain("${APP_DATA_DIR}/demo/cache");
    expect(app.compose).not.toContain("network_mode");
    expect(app.mounts[1]?.source).toBe("/DATA/Media");
    expect(app.risks).toContain("sensitive-host-path");
  });
  it("supports legacy Portainer lists and skips Windows and Swarm explicitly", async () => {
    const entries = [
      { type: "container", title: "Original", image: "example.invalid/app:1" },
      { type: 1, platform: "windows", image: "example.invalid/win:1" },
      { type: 2, title: "Swarm" },
    ];
    const result = await readCatalog({
      catalogId: id,
      url: "https://fixture.invalid/p",
      format: "auto",
      fetcher: memory({ "https://fixture.invalid/p": JSON.stringify(entries) }),
    });
    expect(result.apps).toHaveLength(1);
    expect(result.skipped.map((item) => item.reason)).toEqual([
      "unsupported-portainer-platform",
      "unsupported-portainer-type",
    ]);
  });
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

describe("untrusted catalog form constraints", () => {
  it.each([
    { type: "number", min: 2, max: 4 },
    { type: "boolean" },
    { type: "ip" },
    { type: "email" },
    { type: "fqdn" },
    { type: "url" },
    { regex: "^[a-z]{3}$" },
    { options: [{ value: "allowed" }] },
  ])("rejects an invalid field value for %j", (raw) => {
    expect(() => validateField("invalid value", parseField(raw))).toThrow("invalid-field-value");
  });
  it("bounds unsafe patterns and rejects unsupported backreferences without running JavaScript regex", () => {
    expect(() => parseField({ regex: "a".repeat(513) })).toThrow("unsupported-field-pattern");
    expect(() => parseField({ regex: "(a)\\1" })).toThrow("unsupported-field-pattern");
    expect(() => validateField("a".repeat(4000) + "!", parseField({ regex: "^(a+)+$" }))).toThrow(
      "invalid-field-value",
    );
  });
});
