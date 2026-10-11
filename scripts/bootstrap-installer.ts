import { createPublicKey } from "node:crypto";

/** The bootstrap carries reviewed code and trust; only signed release data is fetched at runtime. */
export function renderBootstrapInstaller(
  template: string,
  installer: string,
  publicKey: string,
): string {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("An Ed25519 publisher key is required");
  let result = template;
  for (const [marker, content, delimiter] of [
    [
      "@@EVERYOS_PUBLIC_KEY@@",
      key.export({ format: "pem", type: "spki" }).toString(),
      "EVERYOS_PUBLISHER_KEY",
    ],
    ["@@EVERYOS_PYTHON_INSTALLER@@", installer, "EVERYOS_PYTHON_INSTALLER"],
  ] as const) {
    if (result.split(marker).length !== 2 || content.split("\n").includes(delimiter))
      throw new Error("Invalid bootstrap template or heredoc delimiter");
    result = result.replace(marker, () => content.trimEnd());
  }
  return result;
}
