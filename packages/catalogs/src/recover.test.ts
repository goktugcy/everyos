import { describe, expect, it } from "vitest";
import { readCatalog } from "./adapters.ts";
import { prepareInstallValues } from "./install.ts";
import { recoverInputs } from "./recover.ts";

const template = (tag: string) => `services:
  app:
    image: example.invalid/app:${tag}
    environment:
      DATABASE_URL: postgres://app:\${SERVICE_PASSWORD_DB}@db:5432/app?sslmode=disable
      ADMIN_EMAIL: \${ADMIN_EMAIL}
      PUID: '1000'
      TZ: Etc/UTC
      PRICE: $$5
    ports: ['8080:80']
  db:
    image: example.invalid/postgres:17
    environment:
      POSTGRES_PASSWORD: \${SERVICE_PASSWORD_DB}
      POSTGRES_USER: \${DB_USER:-app}
`;
async function app(tag = "1") {
  return (
    await readCatalog({
      url: "https://fixture.invalid/app.yml",
      format: "compose-dir",
      catalogId: "00000000-0000-4000-8000-000000000001",
      fetcher: { get: () => Promise.resolve(Buffer.from(template(tag))) },
    })
  ).apps[0]!;
}
const defaults = { source: "host" as const, uid: 1801, gid: 1902, timezone: "Europe/Istanbul" };

describe("recovering installation inputs", () => {
  it("reads values back from a stored file only when preparing again reproduces it", async () => {
    const catalog = await app();
    const installed = prepareInstallValues(
      catalog,
      "instance",
      {
        variables: { ADMIN_EMAIL: "owner@example.com" },
        ports: [{ service: "app", index: 0, host: 9080 }],
      },
      defaults,
    );
    // The generated database password is shared by both services and must survive.
    expect(installed.variables.SERVICE_PASSWORD_DB).toMatch(/^[0-9a-f]{32}$/);
    const recovered = recoverInputs(catalog, "instance", installed.compose);
    expect(recovered).toEqual({
      variables: installed.variables,
      ports: [{ service: "app", index: 0, host: 9080 }],
      defaults: { source: "host", uid: 1801, gid: 0, timezone: "Europe/Istanbul" },
    });
    // A changed template no longer reproduces the stored file.
    expect(recoverInputs(await app("2"), "instance", installed.compose)).toBeNull();
    // A hand-edited stored file is refused rather than guessed.
    expect(
      recoverInputs(
        catalog,
        "instance",
        installed.compose.replace("sslmode=disable", "sslmode=require"),
      ),
    ).toBeNull();
  });

  it("recovers installations made without account defaults or fixed ports", async () => {
    const catalog = await app();
    const installed = prepareInstallValues(catalog, "instance", {
      variables: { ADMIN_EMAIL: "a@example.com", DB_USER: "custom" },
      ports: [],
    });
    expect(recoverInputs(catalog, "instance", installed.compose)).toEqual({
      variables: installed.variables,
      ports: [],
      defaults: null,
    });
  });
});
