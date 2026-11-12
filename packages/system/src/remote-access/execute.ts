import type { RemoteAccessProviderId } from "@everyos/shared";
import { CommandError, type findExecutable, type runCapture } from "../exec.ts";
import { VPN_CREDENTIAL_EXEC } from "./credential-exec.ts";

/** Return only static reasons; vendor output may contain credentials and private URLs. */
export function remoteCommandFailure(provider: RemoteAccessProviderId, output: string): string {
  if (/EVERYOS_VPN_CREDENTIAL_INPUT_UNAVAILABLE|failed to read setup key file/i.test(output))
    return "REMOTE_CREDENTIAL_INPUT_UNAVAILABLE";
  if (provider !== "netbird") return "REMOTE_COMMAND_FAILED";
  if (/peer.*already registered.*(?:different|another)|desc = invalid user/i.test(output))
    return "REMOTE_PEER_IDENTITY_CONFLICT";
  if (
    /(?:invalid|expired|revoked|exhausted)[ -]setup[ -]?key|setup[ -]?key.{0,100}(?:invalid|expired|revoked|not found|usage limit|exhausted)/i.test(
      output,
    )
  )
    return "REMOTE_AUTH_REJECTED";
  if (/x509:|certificate.*(?:expired|unknown authority|not trusted|invalid)/i.test(output))
    return "REMOTE_CERTIFICATE_FAILED";
  if (
    /disable-update-settings|settings updates? (?:are )?disabled|configuration is locked/i.test(
      output,
    )
  )
    return "REMOTE_CONFIGURATION_LOCKED";
  if (
    /unable to connect.*daemon|daemon.*(?:not running|unavailable)|netbird\.sock.*(?:no such file|permission denied|connection refused)/i.test(
      output,
    )
  )
    return "REMOTE_DAEMON_UNAVAILABLE";
  if (
    /no such host|network is unreachable|connection refused|context deadline exceeded|i\/o timeout|TLS handshake timeout/i.test(
      output,
    )
  )
    return "REMOTE_NETWORK_UNREACHABLE";
  return "REMOTE_COMMAND_FAILED";
}

export async function executeRemoteMutation(
  deps: { find: typeof findExecutable; capture: typeof runCapture },
  provider: RemoteAccessProviderId,
  args: string[],
  signal: AbortSignal,
  credential?: string,
): Promise<string | null> {
  const executable = await deps.find(provider);
  if (!executable) return "REMOTE_NOT_INSTALLED";
  let file = executable,
    commandArgs = args;
  if (credential) {
    const python = await deps.find("python3");
    if (!python) return "REMOTE_CREDENTIAL_INPUT_UNAVAILABLE";
    file = python;
    commandArgs = ["-I", "-c", VPN_CREDENTIAL_EXEC, executable, ...args];
  }
  try {
    const result = await deps.capture(file, commandArgs, {
      signal,
      timeoutMs: 55_000,
      maxOutputBytes: 16 * 1024,
      ...(credential ? { input: credential + "\n" } : {}),
    });
    return result.exitCode === 0 ? null : remoteCommandFailure(provider, result.output);
  } catch (error) {
    return error instanceof CommandError && error.kind === "timeout"
      ? "REMOTE_COMMAND_TIMEOUT"
      : "REMOTE_COMMAND_FAILED";
  }
}
