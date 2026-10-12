EveryOS 0.1.5 adds a device-focused Home Assistant panel and all-entity widget selection.

- New Home Assistant connections can choose **All** for displayed and controllable entities;
  entering entity IDs is optional. Existing connections keep their previous allowlists until
  their scope is explicitly edited. Connection names are optional in the form.
- Entity and control widgets default to **All** within their connection's authorized scope,
  paginate every available item and can open the full Home Assistant panel.
- The new built-in Home Assistant app offers connection management, live states, search,
  room groups, optional advanced filters and 24 cards per page. Secondary sensors and complex
  controls move into device details instead of crowding the overview.
- Devices are recognized from Home Assistant registries with their real manufacturer/model,
  brand logos and type symbols. Related entities share a device card; **All entities** stays
  available. Unknown brands, missing logos and denied registry access have usable fallbacks.
- Device commands use fixed Home Assistant services, fresh state/capability checks and validated
  parameters. Covers use open/close/stop; climate devices support temperature and HVAC mode;
  unlock actions require confirmation. Sensors and unsupported actions remain read-only.
- EveryOS permissions and integration audiences remain enforced on the server. Tokens stay
  encrypted and write-only. Partial connection edits preserve omitted scopes and audience,
  and revoked read access is checked again after a state request completes.

See [the Home Assistant guide](https://github.com/goktugcy/everyos/blob/main/docs/home-assistant.md)
for supported controls and configuration. The release source and publisher key are unchanged.
