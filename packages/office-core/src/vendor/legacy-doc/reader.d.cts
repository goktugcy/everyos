declare const read: {
  (bytes: Uint8Array): string | null;
  model(bytes: Uint8Array): unknown;
};
export = read;
