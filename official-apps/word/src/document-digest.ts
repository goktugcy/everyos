import { sha256 } from "@noble/hashes/sha2.js";

/** The DOCX writer needs SHA-256 even when a LAN HTTP origin has no SubtleCrypto. */
export function documentDigest(): Pick<SubtleCrypto, "digest"> {
  return {
    digest(algorithm, data) {
      const name = typeof algorithm === "string" ? algorithm : algorithm.name;
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      const snapshot = new Uint8Array(bytes);
      return Promise.resolve().then(() => {
        if (name.toUpperCase() !== "SHA-256")
          throw new DOMException("Unsupported document digest algorithm", "NotSupportedError");
        return new Uint8Array(sha256(snapshot)).buffer;
      });
    },
  };
}

export function installDocumentDigest(target: Crypto = crypto): void {
  if (!target.subtle)
    Object.defineProperty(target, "subtle", { value: documentDigest(), configurable: true });
}
