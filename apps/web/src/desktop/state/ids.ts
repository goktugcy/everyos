/** Short random ids for desktop items, folders and virtual desktops. */
export function newId(prefix: string): string {
  const random = new Uint32Array(2);
  crypto.getRandomValues(random);
  return `${prefix}${random[0]!.toString(36)}${random[1]!.toString(36)}`.slice(0, 24);
}
