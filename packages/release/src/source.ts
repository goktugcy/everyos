export const DEFAULT_RELEASE_SOURCE = "https://github.com/goktugcy/everyos/releases";

/** The owner's repository rename preserves the independently configured publisher key. */
export function canonicalReleaseSource(source: string): string {
  const url = new URL(source);
  return url.origin === "https://github.com" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    /^\/goktugcy\/otuken\/releases\/*$/i.test(url.pathname)
    ? DEFAULT_RELEASE_SOURCE
    : source;
}
