import type { Translate } from "@everyos/app-ui";

/** All editor strings are package locale data, including its menus and accessibility labels. */
export function engineMessages<T extends object>(template: T, t: Translate): T {
  const visit = (value: unknown, path: string): unknown => {
    if (typeof value === "string") return t(`engine.${path}`);
    if (Array.isArray(value)) return value.map((item, index) => visit(item, `${path}.${index}`));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          visit(item, path ? `${path}.${key}` : key),
        ]),
      );
    return value;
  };
  return visit(template, "") as T;
}
