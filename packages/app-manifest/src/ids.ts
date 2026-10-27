/**
 * Publishers own a reverse-DNS namespace (`io.github.alice`); their apps live inside it
 * (`io.github.alice.todo`). A registry's signed index says which key owns which namespace.
 */
const SEGMENT = "[a-z][a-z0-9-]{0,62}";
export const PUBLISHER_ID_PATTERN = new RegExp(`^${SEGMENT}(\\.${SEGMENT}){1,5}$`);
export const APP_ID_PATTERN = new RegExp(`^${SEGMENT}(\\.${SEGMENT}){2,6}$`);
export const MAX_ID_LENGTH = 128;

/** The official registry's publisher: only its pinned key may sign `dev.everyos.*`. */
export const OFFICIAL_PUBLISHER_ID = "dev.everyos";

export function isPublisherId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= MAX_ID_LENGTH && PUBLISHER_ID_PATTERN.test(value)
  );
}

export function isAppId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ID_LENGTH && APP_ID_PATTERN.test(value);
}

/** Whether `appId` lies inside the publisher's namespace (a dot boundary, not a prefix). */
export function appBelongsTo(appId: string, publisherId: string): boolean {
  return appId.startsWith(`${publisherId}.`);
}

/**
 * Names only the official registry may use: its namespace and anything that starts with
 * `everyos`, which would read as EveryOS itself.
 */
export function isReservedNamespace(id: string): boolean {
  return (
    id === OFFICIAL_PUBLISHER_ID ||
    id.startsWith(`${OFFICIAL_PUBLISHER_ID}.`) ||
    id.split(".")[0] === "everyos"
  );
}
