import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { addRegistryFixture } from "../../apps/api/src/test-support/home-assistant-registry.ts";
import { signIn } from "./helpers.ts";

test("Home Assistant all-entity widgets and panel use real API state and typed controls", async ({
  page,
}) => {
  const states = [
    {
      entity_id: "light.room",
      state: "off",
      attributes: {
        friendly_name: "Test lamp",
        supported_color_modes: ["rgb", "color_temp"],
        supported_features: 4,
        brightness: 128,
        rgb_color: [12, 34, 56],
        color_temp_kelvin: 3000,
        min_color_temp_kelvin: 2000,
        max_color_temp_kelvin: 6500,
        effect_list: ["rainbow", "pulse"],
      },
    },
    {
      entity_id: "light.offline",
      state: "unavailable",
      attributes: { friendly_name: "Unavailable lamp" },
    },
    {
      entity_id: "cover.blind",
      state: "open",
      attributes: { friendly_name: "Test blind", supported_features: 3 },
    },
    {
      entity_id: "climate.room",
      state: "heat",
      attributes: {
        friendly_name: "Test climate",
        supported_features: 1,
        temperature: 22,
        current_temperature: 21,
        min_temp: 16,
        max_temp: 30,
        target_temp_step: 1,
        hvac_modes: ["heat", "off"],
      },
    },
    { entity_id: "lock.door", state: "locked", attributes: { friendly_name: "Test lock" } },
    ...Array.from({ length: 26 }, (_, index) => ({
      entity_id: `sensor.test_${index}`,
      state: String(index),
      attributes: {
        friendly_name: `Test sensor ${String(index).padStart(2, "0")}`,
        unit_of_measurement: "°C",
      },
    })),
  ];
  const services = [
    { domain: "light", services: { toggle: {}, turn_on: {}, turn_off: {} } },
    { domain: "cover", services: { open_cover: {}, close_cover: {}, stop_cover: {} } },
    { domain: "climate", services: { set_temperature: {}, set_hvac_mode: {} } },
    { domain: "lock", services: { lock: {}, unlock: {} } },
  ];
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    void (async () => {
      res.setHeader("Content-Type", "application/json");
      if (req.headers.authorization !== "Bearer test-ha-token") {
        res.writeHead(401).end("{}");
        return;
      }
      if (req.method === "GET" && req.url === "/api/services") {
        res.end(JSON.stringify(services));
        return;
      }
      if (req.method === "GET" && req.url === "/api/states") {
        res.end(JSON.stringify(states));
        return;
      }
      const target = states.find((entity) => req.url === `/api/states/${entity.entity_id}`);
      if (req.method === "GET" && target) {
        res.end(JSON.stringify(target));
        return;
      }
      let text = "";
      for await (const chunk of req) text += String(chunk);
      if (req.method === "POST") {
        const body = JSON.parse(text) as Record<string, unknown>;
        const entity = states.find((item) => item.entity_id === body.entity_id);
        calls.push({ path: req.url ?? "", body });
        if (entity && req.url === "/api/services/light/turn_on") {
          entity.state = "on";
          Object.assign(entity.attributes, {
            ...(typeof body.brightness_pct === "number"
              ? { brightness: Math.round((body.brightness_pct / 100) * 255) }
              : {}),
            ...(body.rgb_color ? { rgb_color: body.rgb_color } : {}),
            ...(body.color_temp_kelvin ? { color_temp_kelvin: body.color_temp_kelvin } : {}),
          });
        }
        if (entity && req.url?.endsWith("/toggle"))
          entity.state = entity.state === "on" ? "off" : "on";
        if (entity && req.url?.endsWith("/close_cover")) entity.state = "closed";
        if (entity && req.url?.endsWith("/unlock")) entity.state = "unlocked";
        if (entity && req.url?.endsWith("/set_temperature"))
          Object.assign(entity.attributes, { temperature: body.temperature });
        res.end(JSON.stringify(entity ? [entity] : []));
        return;
      }
      res.writeHead(404).end("{}");
    })().catch(() => res.destroy());
  });
  const closeRegistry = addRegistryFixture(
    server,
    {
      devices: [
        {
          id: "lamp",
          name: "Test lamp",
          manufacturer: "Signify",
          model: "LCA001",
          area_id: "living",
        },
        {
          id: "blind",
          name: "Test blind",
          manufacturer: "IKEA",
          model: "FYRTUR",
          area_id: "living",
        },
        {
          id: "climate",
          name: "Test climate",
          manufacturer: "tado",
          model: "Smart Thermostat",
          area_id: "bedroom",
        },
        {
          id: "lock",
          name: "Test lock",
          manufacturer: "Unknown vendor",
          model: "Door lock",
          area_id: "hall",
        },
        {
          id: "offline",
          name: "Unavailable lamp",
          manufacturer: "LUMI",
          model: "ZNLDP12LM",
          area_id: "bedroom",
        },
        ...Array.from({ length: 13 }, (_, i) => ({
          id: `sensor-${i}`,
          name: `Room sensor ${String(i).padStart(2, "0")}`,
          manufacturer: "LUMI",
          model: "WSDCGQ11LM",
          area_id: i % 2 ? "bedroom" : "living",
        })),
      ],
      entities: [
        ...[
          ["light.room", "lamp"],
          ["cover.blind", "blind"],
          ["climate.room", "climate"],
          ["lock.door", "lock"],
          ["light.offline", "offline"],
        ].map(([entity_id, device_id]) => ({ entity_id, device_id })),
        ...Array.from({ length: 26 }, (_, i) => ({
          entity_id: `sensor.test_${i}`,
          device_id: `sensor-${Math.floor(i / 2)}`,
          icon: "mdi:thermometer",
          ...(i === 1 ? { area_id: "bedroom" } : {}),
        })),
      ],
      areas: [
        { id: "living", name: "Living room" },
        { id: "bedroom", name: "Bedroom" },
        { id: "hall", name: "Hall" },
      ],
    },
    { token: "test-ha-token" },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const session = await signIn(page);
  let integrationId: string | undefined;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("home assistant");
    await page.getByRole("option", { name: "Home Assistant", exact: true }).click();
    const app = page.locator('[data-app-id="everyos.homeassistant"]');
    await app.getByRole("button", { name: "Home Assistant bağla", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Bağlantı ekle", exact: true });
    await form.getByLabel("Ad", { exact: true }).fill("HA test fixture");
    await form.getByLabel("Adres", { exact: true }).fill(`http://127.0.0.1:${port}`);
    await form.getByLabel("Uzun ömürlü erişim belirteci", { exact: true }).fill("test-ha-token");
    await expect(form.getByLabel("Görüntülenecek varlıklar", { exact: true })).toHaveValue("all");
    await expect(form.getByLabel("Kontrol edilebilecek varlıklar", { exact: true })).toHaveValue(
      "all",
    );
    await form.getByRole("button", { name: "Kaydet", exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(app).toContainText("31 varlık");
    const integrationResponse = (await (await page.request.get("/api/integrations")).json()) as {
      integrations: Array<{ id: string; name: string; options: unknown }>;
    };
    integrationId = integrationResponse.integrations.find(
      (integration) => integration.name === "HA test fixture",
    )?.id;
    expect(integrationId).toBeTruthy();
    expect(JSON.stringify(integrationResponse)).not.toContain("test-ha-token");
    await expect(app.locator("li[data-entity-id]")).toHaveCount(19);
    await expect(app.locator('[data-entity-id="light.room"]')).toContainText("Signify · LCA001");
    await expect(app.getByRole("heading", { name: "Living room", exact: true })).toBeVisible();
    await expect(app.getByRole("heading", { name: "Bedroom", exact: true })).toBeVisible();
    await app.getByRole("button", { name: "Bedroom", exact: true }).click();
    await expect(app.locator("li[data-entity-id]")).toHaveCount(9);
    const splitSensor = app.locator('li[data-device-id="sensor-0"]');
    await splitSensor.getByRole("button", { name: "Ayrıntılar", exact: true }).click();
    const roomDetails = page.getByRole("dialog", { name: "Room sensor 00", exact: true });
    await expect(roomDetails.locator('[data-entity-id="sensor.test_1"]')).toBeVisible();
    await expect(roomDetails.locator('[data-entity-id="sensor.test_0"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await app.getByRole("button", { name: "Tüm odalar", exact: true }).click();
    await expect(app.getByRole("heading", { name: "Bedroom", exact: true })).toBeInViewport();
    await page.screenshot({
      path: test.info().outputPath("home-assistant-devices.png"),
      animations: "disabled",
    });
    await app.getByLabel("Görünüm", { exact: true }).selectOption("entities");
    await expect(app.locator("li[data-entity-id]")).toHaveCount(24);
    await app.getByRole("button", { name: "Sonraki varlıklar", exact: true }).click();
    await expect(app.locator("li[data-entity-id]")).toHaveCount(7);
    await app.getByLabel("Varlık ara", { exact: true }).fill("light.room");
    const lamp = app.locator('[data-entity-id="light.room"]');
    await lamp.getByRole("button", { name: "Değiştir", exact: true }).click();
    await expect(lamp.getByRole("status").first()).toHaveText("Açık");
    await lamp.getByRole("button", { name: "Ayrıntılar", exact: true }).click();
    const lampDetails = page.getByRole("dialog", { name: "Test lamp", exact: true });
    const brightness = lampDetails
      .locator("form")
      .filter({ has: page.getByLabel("Parlaklık (%)", { exact: true }) });
    await brightness.getByLabel("Parlaklık (%)", { exact: true }).fill("75");
    expect(calls.some((call) => call.body.brightness_pct === 75)).toBe(false);
    await brightness.getByRole("button", { name: "Uygula", exact: true }).click();
    await expect
      .poll(() =>
        calls.some(
          (call) => call.path === "/api/services/light/turn_on" && call.body.brightness_pct === 75,
        ),
      )
      .toBe(true);
    await expect(brightness).toContainText("Home Assistant değeri: 74.9");
    await expect(brightness.getByRole("button", { name: "Uygula", exact: true })).toBeEnabled();
    const color = lampDetails
      .locator("form")
      .filter({ has: page.getByLabel("Renk", { exact: true }) });
    await color.getByLabel("Renk", { exact: true }).fill("#ff4000");
    await color.getByRole("button", { name: "Uygula", exact: true }).click();
    await expect
      .poll(() =>
        calls.some(
          (call) =>
            call.path === "/api/services/light/turn_on" &&
            JSON.stringify(call.body.rgb_color) === "[255,64,0]",
        ),
      )
      .toBe(true);
    await expect(color).toContainText("Home Assistant değeri: #ff4000");
    await page.screenshot({
      path: test.info().outputPath("home-assistant-light-controls.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await app.getByLabel("Varlık ara", { exact: true }).fill("cover.blind");
    const blind = app.locator('[data-entity-id="cover.blind"]');
    await blind.getByRole("button", { name: "Ayrıntılar", exact: true }).click();
    let details = page.getByRole("dialog", { name: "Test blind", exact: true });
    await details.getByRole("button", { name: "Kapat", exact: true }).last().click();
    await expect(details.getByRole("status").first()).toHaveText("Kapalı");
    await page.keyboard.press("Escape");
    await app.getByLabel("Varlık ara", { exact: true }).fill("climate.room");
    const climate = app.locator('[data-entity-id="climate.room"]');
    await climate.getByRole("button", { name: "Ayrıntılar", exact: true }).click();
    details = page.getByRole("dialog", { name: "Test climate", exact: true });
    await expect(details).toContainText("Smart Thermostat");
    await details.getByLabel("Hedef sıcaklık", { exact: true }).fill("23");
    await details.getByRole("button", { name: "Sıcaklığı uygula", exact: true }).click();
    await expect
      .poll(() =>
        calls.some(
          (call) =>
            call.path === "/api/services/climate/set_temperature" && call.body.temperature === 23,
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: test.info().outputPath("home-assistant-details.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await app.getByLabel("Varlık ara", { exact: true }).fill("light.offline");
    await expect(
      app.locator('[data-entity-id="light.offline"]').getByRole("button", { name: "Değiştir" }),
    ).toBeDisabled();
    await app.getByLabel("Varlık ara", { exact: true }).fill("lock.door");
    const lock = app.locator('[data-entity-id="lock.door"]');
    await lock.getByRole("button", { name: "Ayrıntılar", exact: true }).click();
    details = page.getByRole("dialog", { name: "Test lock", exact: true });
    await details.getByRole("button", { name: "Kilidi aç", exact: true }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("Test lock kilidi açılsın mı?");
    await confirm.getByRole("button", { name: "Vazgeç", exact: true }).click();
    expect(calls.some((call) => call.path === "/api/services/lock/unlock")).toBe(false);
    await expect(details.getByRole("button", { name: "Kilidi aç", exact: true })).toBeEnabled();
    await details.getByRole("button", { name: "Kilidi aç", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Kilidi aç", exact: true })
      .click();
    await expect(details.getByRole("status").first()).toHaveText("Kilit açık");
    await page.keyboard.press("Escape");
    await app.getByLabel("Varlık ara", { exact: true }).fill("");
    await app.getByText("Filtreler", { exact: true }).click();
    await app.getByLabel("Cihaz türü", { exact: true }).selectOption("sensor");
    await app.getByText("Filtreler", { exact: true }).click();
    await expect(app.locator("li[data-entity-id]")).toHaveCount(24);
    await expect(app.locator("li[data-entity-id]").first()).toContainText("Salt okunur");
    await app.getByRole("button", { name: "Yenile", exact: true }).click();
    await expect(app.getByRole("button", { name: "Yenile", exact: true })).toBeEnabled();
    await page.screenshot({
      path: test.info().outputPath("home-assistant-panel.png"),
      animations: "disabled",
    });

    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Uygulama veya komut ara…" }).fill("widget");
    await page.getByRole("option", { name: "Ayarlar: Widget'lar", exact: true }).click();
    const settings = page.locator('[data-app-id="everyos.settings"]');
    await settings.getByRole("button", { name: "Widget galerisini aç", exact: true }).click();
    const gallery = page.getByRole("dialog", { name: "Widget galerisi", exact: true });
    await gallery.getByRole("tab", { name: "Uygulamalar", exact: true }).click();
    await gallery
      .locator('[data-widget="homeassistant.controls"]')
      .getByRole("button", { name: /^Ekle:/ })
      .click();
    const configure = page
      .getByRole("dialog")
      .filter({ has: page.getByLabel("Gösterilecek varlıklar", { exact: true }) });
    await expect(configure.getByLabel("Gösterilecek varlıklar", { exact: true })).toHaveValue(
      "all",
    );
    await configure.getByLabel("Uygulama bağlantısı", { exact: true }).selectOption(integrationId!);
    await configure.getByRole("button", { name: "Kaydet", exact: true }).click();
    await page.keyboard.press("Escape");
    // Close windows to expose the real desktop widget.
    await settings.getByRole("button", { name: "Kapat", exact: true }).first().click();
    await app.getByRole("button", { name: "Kapat", exact: true }).first().click();
    const widget = page
      .getByTestId("desktop-widget")
      .filter({ has: page.locator('[data-widget="homeassistant.controls"]') });
    await expect(widget).toContainText("Test blind");
    await expect(
      widget.getByRole("button", { name: "Sonraki varlıklar", exact: true }),
    ).toBeVisible();
    await widget.getByRole("button", { name: "Sonraki varlıklar", exact: true }).click();
    await expect(widget).toContainText("Test lamp");
    await widget.getByRole("button", { name: "Paneli aç", exact: true }).click();
    await expect(app).toBeVisible();
    await expect(app.getByLabel("Home Assistant bağlantısı", { exact: true })).toHaveValue(
      integrationId!,
    );
    await app.getByLabel("Görünüm", { exact: true }).selectOption("devices");
    await app.getByText("Filtreler", { exact: true }).click();
    await app.getByLabel("Cihaz türü", { exact: true }).selectOption("");
    await app.getByText("Filtreler", { exact: true }).click();
    await page.setViewportSize({ width: 900, height: 850 });
    await expect(app.locator("li[data-entity-id]")).toHaveCount(19);
    await page.screenshot({
      path: test.info().outputPath("home-assistant-compact.png"),
      animations: "disabled",
    });
    expect(errors).toEqual([]);
  } finally {
    if (integrationId)
      await page.request.delete(`/api/integrations/${integrationId}`, {
        headers: { "X-EveryOS-CSRF": session.csrfToken },
      });
    closeRegistry();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
