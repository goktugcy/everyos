import { OperationError } from "@everyos/agent-protocol";
import { object } from "@everyos/catalogs/compose";
import { EVERYOS_AI_NETWORK } from "@everyos/shared";

export const AI_NETWORK_KEY = "x-otuken-ai-network";

/**
 * Services of a built-in AI app that join EveryOS's internal AI network, with an optional DNS
 * alias. Catalog templates cannot ask for it: the API strips every other `x-` key from them.
 */
export function aiNetworkMembers(doc: Record<string, unknown>): Array<[string, string | null]> {
  if (doc[AI_NETWORK_KEY] === undefined) return [];
  const services = object(doc.services),
    members = Object.entries(object(doc[AI_NETWORK_KEY]));
  if (
    !members.length ||
    doc.networks !== undefined ||
    members.some(
      ([name, alias]) =>
        !Object.hasOwn(services, name) ||
        object(services[name]).networks !== undefined ||
        object(services[name]).network_mode !== undefined ||
        (alias !== null && (typeof alias !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(alias))),
    )
  )
    throw new OperationError("invalid_params", "Invalid AI network membership");
  return members as Array<[string, string | null]>;
}

/**
 * Replaces the request with the external network and per-service membership Compose needs.
 * Returns whether the network must exist before the project starts.
 */
export function applyAiNetwork(doc: Record<string, unknown>): boolean {
  const members = aiNetworkMembers(doc);
  delete doc[AI_NETWORK_KEY];
  if (!members.length) return false;
  doc.networks = {
    default: {},
    [EVERYOS_AI_NETWORK]: { external: true, name: EVERYOS_AI_NETWORK },
  };
  const services = object(doc.services);
  for (const [name, alias] of members)
    services[name] = {
      ...object(services[name]),
      networks: { default: {}, [EVERYOS_AI_NETWORK]: alias ? { aliases: [alias] } : {} },
    };
  return true;
}
