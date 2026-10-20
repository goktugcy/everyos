import { createPrivateKey, sign } from "node:crypto";
import { generatePublisherKeys, sha256Hex, signPackage } from "@everyos/app-package";
import { describe, expect, it } from "vitest";
import {
  latestVersion,
  RegistryError,
  revocationOf,
  signRegistryIndex,
  verifyRegistryIndex,
  type RegistryIndex,
} from "./index.ts";

const NOW = 1_800_000_000_000;
const registryKeys = generatePublisherKeys();
const alice = generatePublisherKeys();
const mallory = generatePublisherKeys();

function manifest(id: string, version: string, publisher: string) {
  return {
    manifestVersion: 1 as const,
    id,
    name: "To-Do",
    version,
    description: "Tasks",
    entry: "index.html",
    icon: "icon.png",
    category: "productivity" as const,
    permissions: ["storage:app" as const],
    window: {
      defaultWidth: 800,
      defaultHeight: 600,
      minWidth: 400,
      minHeight: 300,
      instances: "single" as const,
    },
    widgets: [],
    sdk: "^1.0.0",
    publisher: { id: publisher, name: "Alice" },
  };
}

function version(id: string, value: string, publisher = "io.github.alice", key = alice.privateKey) {
  const bytes = Buffer.from(`${id}@${value}`);
  const digest = { appId: id, version: value, sha256: sha256Hex(bytes), size: bytes.length };
  return {
    version: value,
    manifest: manifest(id, value, publisher),
    package: {
      url: `packages/${id}-${value}.eosapp`,
      size: digest.size,
      sha256: digest.sha256,
      signature: signPackage(digest, key),
    },
    publishedAt: NOW - 1000,
  };
}

function index(overrides: Partial<RegistryIndex> = {}): RegistryIndex {
  return {
    format: "everyos-app-registry",
    schemaVersion: 1,
    registry: { id: "community", name: "Community" },
    sequence: 7,
    publishedAt: NOW - 1000,
    expiresAt: NOW + 86_400_000,
    publishers: [{ id: "io.github.alice", name: "Alice", keys: [alice.publicKey] }],
    apps: [
      {
        id: "io.github.alice.todo",
        publisher: "io.github.alice",
        icon: "icons/todo.png",
        screenshots: [],
        versions: [
          version("io.github.alice.todo", "1.0.0"),
          version("io.github.alice.todo", "1.1.0"),
          version("io.github.alice.todo", "2.0.0-beta.1"),
        ],
      },
    ],
    revoked: [],
    ...overrides,
  };
}

const errorCode = (run: () => unknown): string => {
  try {
    run();
    return "ok";
  } catch (error) {
    if (error instanceof RegistryError) return error.code;
    throw error;
  }
};

const options = { official: false, now: NOW };

describe("registry indexes", () => {
  it("verifies the chain from the registry key to every package signature", () => {
    const signed = signRegistryIndex(index(), registryKeys.privateKey, { official: false });
    const verified = verifyRegistryIndex(signed, registryKeys.publicKey, options);
    expect(verified.apps[0]?.versions).toHaveLength(3);
    expect(latestVersion(verified, verified.apps[0]!)?.version).toBe("1.1.0");
    expect(latestVersion(verified, verified.apps[0]!, true)?.version).toBe("2.0.0-beta.1");
  });

  it("rejects other keys, tampering, expiry and rollback", () => {
    const signed = signRegistryIndex(index(), registryKeys.privateKey, { official: false });
    expect(errorCode(() => verifyRegistryIndex(signed, mallory.publicKey, options))).toBe(
      "bad-signature",
    );
    const envelope = JSON.parse(signed) as { payload: string; signature: string };
    const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString()) as RegistryIndex;
    payload.sequence = 99;
    const tampered = JSON.stringify({
      ...envelope,
      payload: Buffer.from(JSON.stringify(payload)).toString("base64"),
    });
    expect(errorCode(() => verifyRegistryIndex(tampered, registryKeys.publicKey, options))).toBe(
      "bad-signature",
    );
    expect(
      errorCode(() =>
        verifyRegistryIndex(signed, registryKeys.publicKey, {
          ...options,
          now: NOW + 2 * 86_400_000,
        }),
      ),
    ).toBe("expired");
    expect(
      errorCode(() =>
        verifyRegistryIndex(signed, registryKeys.publicKey, { ...options, minSequence: 8 }),
      ),
    ).toBe("rollback");
    expect(errorCode(() => verifyRegistryIndex("{}", registryKeys.publicKey, options))).toBe(
      "invalid-format",
    );
  });

  it("keeps publishers inside their namespaces and away from reserved names", () => {
    const sign =
      (value: RegistryIndex, official = false) =>
      () =>
        verifyRegistryIndex(
          // Sign without the signer-side checks to prove the verifier enforces them by itself.
          JSON.stringify({
            payload: Buffer.from(JSON.stringify(value)).toString("base64"),
            signature: signRaw(value),
          }),
          registryKeys.publicKey,
          { ...options, official },
        );
    const official = index({
      publishers: [{ id: "dev.everyos", name: "EveryOS", keys: [alice.publicKey] }],
      apps: [
        {
          id: "dev.everyos.notes",
          publisher: "dev.everyos",
          icon: "icons/notes.png",
          screenshots: [],
          versions: [version("dev.everyos.notes", "1.0.0", "dev.everyos")],
        },
      ],
    });
    expect(errorCode(sign(official))).toBe("invalid-index");
    expect(errorCode(sign(official, true))).toBe("ok");
    const outside = index();
    outside.apps[0]!.id = "io.github.bob.todo";
    expect(errorCode(sign(outside))).toBe("invalid-index");
    const nested = index({
      publishers: [
        { id: "io.github.alice", name: "Alice", keys: [alice.publicKey] },
        { id: "io.github.alice.tools", name: "Tools", keys: [mallory.publicKey] },
      ],
    });
    expect(errorCode(sign(nested))).toBe("invalid-index");
    // A package signed by someone else's key is not the publisher's package.
    const forged = index();
    forged.apps[0]!.versions = [
      version("io.github.alice.todo", "1.0.0", "io.github.alice", mallory.privateKey),
    ];
    expect(errorCode(sign(forged))).toBe("invalid-index");
    const mismatched = index();
    mismatched.apps[0]!.versions[0]!.manifest.version = "9.9.9";
    expect(errorCode(sign(mismatched))).toBe("invalid-index");
  });

  it("honours revocations of one version or every version", () => {
    const revoked = index({
      revoked: [{ appId: "io.github.alice.todo", version: "1.1.0", reason: "Data loss bug" }],
    });
    expect(revocationOf(revoked, "io.github.alice.todo", "1.1.0")?.reason).toBe("Data loss bug");
    expect(latestVersion(revoked, revoked.apps[0]!)?.version).toBe("1.0.0");
    const all = index({
      revoked: [{ appId: "io.github.alice.todo", version: "*", reason: "Malware" }],
    });
    expect(latestVersion(all, all.apps[0]!)).toBeNull();
  });
});

function signRaw(value: RegistryIndex): string {
  return sign(
    null,
    Buffer.from(JSON.stringify(value)),
    createPrivateKey(registryKeys.privateKey),
  ).toString("base64");
}
