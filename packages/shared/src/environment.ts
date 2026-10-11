/** New environment names win; older installations can keep their existing configuration. */
export function resolveEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const resolved = { ...env };
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("OTUKEN_")) continue;
    const renamed = `EVERYOS_${key.slice("OTUKEN_".length)}`;
    resolved[renamed] ??= value;
  }
  return resolved;
}
