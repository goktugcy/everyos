# Home Assistant panel and widgets

EveryOS uses a stored Home Assistant connection for both the built-in **Home Assistant** app
(`everyos.homeassistant`) and the entity/control widgets. The panel is available through the
launcher, desktop, dock and a widget's **Open panel** action. It is also available in the mobile
app list. It does not embed Home Assistant's frontend or send its access token to the browser.

## Connect and choose a scope

Open Home Assistant → Connect Home Assistant, or Settings → Widgets → Add connection.
Enter the URL and long-lived access token. The connection name is optional in the form and
defaults to Home Assistant. The new form selects **All** for both display and control scope,
so entity IDs are not required. The scope is explicit in the saved connection:

```json
{
  "adapter": "homeassistant",
  "name": "Home",
  "baseUrl": "http://192.168.1.20:8123",
  "options": { "entityScope": "all", "controlScope": "all" }
}
```

Send the token in the create/update request's `secret` field; it is encrypted at rest and never
returned by a read endpoint. Keep the audience at **App managers only** unless you intend to
share states, including presence information, with other EveryOS users.

Existing connections retain their lists: an absent scope means `selected`. Edit the existing
connection and select **All** when you want to expose every accessible entity. Selected mode
still accepts `entities` and `controlEntities`; permitted control entities are included in the
state feed as before. Partial edits preserve omitted options, audience and credentials.

A widget independently chooses **All** or **Selected** within the integration's authorized
scope. All is its default and does not require an entity selection. Widget manifest version 2
preserves existing selected IDs. All widgets paginate their results rather than discarding
entities beyond the selected-list limit. Control widgets support small, medium and large sizes.

## Panel behavior

- Choose between saved Home Assistant connections, add a connection or edit its scope.
- The default **Devices** view groups entities from the same registered physical device.
  **All entities** keeps every exposed entity individually accessible. Search also matches brands
  and models. Cards are grouped under actual Home Assistant room headings; room chips filter them. Entities whose area overrides their device area form a separate card in that room, so details cannot include siblings from a different room. Advanced domain/control filters
  are tucked into **Filters**.
- Cards show a device symbol, reported manufacturer/model, current state and a quick toggle
  when supported. **Details** holds secondary sensors, entity IDs and parameterized controls.
  Unavailable devices retain their reported state and cannot be controlled.
- Browse 24 cards per page. Widgets use smaller pages suitable for their size.
- State collection runs every 15 seconds while subscribed. Panel and widgets share the same
  collection. **Refresh** explicitly reads fresh state without disabling controls afterward.
- Actions show request errors and acceptance separately from device state. State changes appear
  only when Home Assistant reports them; no optimistic device values are fabricated.

The adapter reads the documented [state and service APIs](https://developers.home-assistant.io/docs/api/rest/).
It calls `/api/services/<domain>/<service>` to control an entity. It never writes `/api/states`
to pretend that a device changed. Only the fields used by the UI leave the API; arbitrary
attributes, positions, camera URLs and credentials are omitted.

## Automatic device recognition

The API authenticates a short [WebSocket session](https://developers.home-assistant.io/docs/api/websocket/)
at `/api/websocket` and reads only `config/device_registry/list`, `config/entity_registry/list`
and `config/area_registry/list`. Device IDs join the registries to allowed states. An entity's
area overrides its device area. Only the linked name, manufacturer, model, area, icon and category
are returned; serials, connections, identifiers, pictures and unrelated entities are omitted.
Registry metadata is cached for 60 seconds (15 seconds after failure), up to 32 connections.
Credential changes use a different cache fingerprint. Requests pin vetted DNS addresses, refuse
redirects and have a six-second deadline, 16 MiB frame and 48 MiB session limits; each registry
is limited to 10,000 entries. Only sanitized metadata is cached.

Reported manufacturers are mapped to known brand families; TP-Link Tapo models use the Tapo
brand. A Zigbee integration name is not treated as a manufacturer. Supported families include
Philips/Signify, Aqara/LUMI, IKEA, Shelly, Sonoff, Xiaomi, Tuya, TP-Link/Tapo, ESPHome, Samsung,
LG, Bosch, Netatmo, Nest, Ring, Reolink, Ubiquiti, Roborock, Ecovacs, Sonos, Nanoleaf, Govee
and tado. Unknown manufacturers retain their reported text and a device-type symbol. No model
or manufacturer is guessed from a friendly name.

Brand PNGs come from [Home Assistant Brands](https://github.com/home-assistant/brands), whose
assets represent their respective owners. A same-origin, audience-checked API endpoint proxies
only fixed PNG paths in the official Home Assistant Brands GitHub repository. It sends no Home Assistant token, refuses redirects, pins DNS,
checks PNG signatures and caps images at 512 KiB. Successful images are cached for a day;
missing images/network failures for one minute. The browser never contacts an external image
host. Logos are an enhancement: offline operation or a missing logo leaves the device symbol
and real manufacturer/model text available. Home Assistant MDI icon hints use a fixed local
symbol map, with device-class/domain fallbacks; remote SVG/HTML is never rendered.

If WebSocket access is blocked or registry reads are denied, states and allowed controls remain
usable and the UI clearly reports missing device information. Configure the reverse proxy to
forward WebSocket upgrades, and use a token whose Home Assistant user can read the registries.
New device metadata appears on the next collection after cache expiry. Details contain only
entities already shared by the server, even when a device has other hidden entities.

## Controls and authorization

Reading requires `apps:read` plus the integration's audience permissions. Controlling and editing
connections require `apps:manage`, independently checked by the API. Scope authorization is
checked before every action, and settings are checked again after capability discovery before
the service call. Entity state and available services are read again before execution;
unavailable entities, unsupported actions/options and out-of-range values are rejected.

| Entity domains                                                         | Fixed controls                                                                                                                                                 |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| light                                                                  | On/off, brightness, RGB color picker (Home Assistant translates supported color modes), Kelvin color temperature, white channel, effects, flash and transition |
| switch, input_boolean, automation, script, scene, button, input_button | Existing on/off, run and trigger controls                                                                                                                      |
| fan                                                                    | On/off, speed, preset, oscillation and direction                                                                                                               |
| cover                                                                  | Open/close/stop, position and tilt actions/position                                                                                                            |
| climate                                                                | Temperature, paired low/high temperature range, HVAC/fan/preset/swing modes and target humidity                                                                |
| humidifier                                                             | On/off, target humidity and mode                                                                                                                               |
| media_player                                                           | Power, playback, tracks, volume/mute, source/sound mode, shuffle/repeat and seek                                                                               |
| vacuum                                                                 | Start/pause/stop/return, locate, spot clean and fan speed                                                                                                      |
| valve                                                                  | Open/close/stop and position                                                                                                                                   |
| water_heater                                                           | Power, target temperature, operation and away modes                                                                                                            |
| siren                                                                  | Power, advertised tones, volume and bounded duration                                                                                                           |
| remote, lawn_mower                                                     | Remote power; mower start/pause/dock/stop                                                                                                                      |
| lock                                                                   | Lock/unlock/open latch; unlock and open require explicit confirmation                                                                                          |
| number, input_number, select, input_select                             | Bounded numeric value and reported choices                                                                                                                     |

Only registered services and advertised entity features/color modes/options produce controls.
New parameterized controls require the appropriate feature flags; legacy basic fan/media/vacuum
controls remain compatible with integrations omitting flags. Controls use explicit draft edits
and **Apply**; moving a slider does not send commands. The reported value stays separate and
updates only from Home Assistant state, even when the requested value is rounded by a device.
Every setting is validated again against fresh capabilities immediately before the service call.

Controls are not universally inferred from a domain-wide service list: those services describe
all devices in that domain and may include actions a particular device cannot perform. The fixed
service/field manifest never executes remote descriptions or arbitrary service names. Custom
integration actions, remote commands, camera streams, alarm codes, media URLs, script-specific
variables and firmware management remain in Home Assistant's own authenticated interface. The
panel includes **Open in Home Assistant** without appending or disclosing the stored token.
Sensors, presence and weather remain read-only. Existing selected scopes are not widened.

Every action writes an audit outcome without tokens or request secrets. Remote requests use the
existing pinned-DNS, no-redirect client. States are limited to 16 MiB and 10,000 entities; service
metadata is limited to 4 MiB. Exceeding a bound produces an error rather than silently hiding the
remaining entities. A settings change during a direct state read invalidates that read, and an
audience revocation is checked again before data is returned.

## API

`GET /api/integrations/:id/states` returns `{ status, data?, reason?, code?, at }` for Home Assistant,
using the same audience as `data.integration.<id>.states`. The topic's successful data is
`{ source: "host", registry: "ok" | "unavailable", entities, controllable }` with sanitized action/range metadata.

`POST /api/integrations/:id/actions` accepts a strict, single-entity action:

```json
{ "entityId": "cover.living_room", "service": "close_cover" }
```

Parameterized actions use dedicated fields: `temperature` for `set_temperature`, `hvacMode` for
`set_hvac_mode`, `value` for `set_value`, and `option` for `select_option`. An `unlock` or lock-domain `open` action also
requires `confirm: true`. Generic service names and additional payload fields are rejected.

The automated acceptance uses disposable HTTP/WebSocket servers implementing the documented
Home Assistant APIs, including mutable states, registry joins and real HTTP service calls. It checks the full browser path and
negative authorization cases. It does not claim to exercise the owner's physical devices.

Extended settings use a fixed control identifier, not an arbitrary service or parameter:

```json
{ "entityId": "light.living_room", "service": "configure", "control": "brightness", "value": 75 }
{ "entityId": "light.living_room", "service": "configure", "control": "color", "value": [255, 64, 0] }
```

Each entity includes sanitized `controls` with numeric bounds/current value, available choices,
boolean state or RGB color. A temperature range sends both low and high in the same command.
Scope filtering removes both `actions` and `controls`. Strict request validation rejects unknown
controls, extra targets/parameters, wrong types, invalid RGB channels and unsupported values.
Audits contain the entity, service and fixed control identifier, never the setting payload.
