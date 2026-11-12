import type { RemoteAccessProviderId } from "@everyos/shared";
import { CommandError, type findExecutable, type runCapture } from "../exec.ts";
import { VPN_CREDENTIAL_EXEC } from "./credential-exec.ts";

/** Return only static reasons; vendor output may contain credentials and private URLs. */
export function remoteCommandFailure(provider: RemoteAccessProviderId, output: string): string {
  if (
    /EVERYOS_VPN_CREDENTIAL_INPUT_UNAVAILABLE|failed to read setup key file|\/dev\/stdin.*no such device or address/i.test(
      output,
    )
  )
    return "REMOTE_CREDENTIAL_INPUT_UNAVAILABLE";
  if (/unknown flag|flag provided but not defined|unknown command/i.test(output))
    return "REMOTE_VERSION_UNSUPPORTED";
  if (/x509:|certificate.*(?:expired|unknown authority|not trusted|invalid)/i.test(output))
    return "REMOTE_CERTIFICATE_FAILED";
  if (provider === "tailscale") {
    if (
      /invalid (?:auth[ -]?key|key)|auth[ -]?key.*(?:expired|revoked|not found|invalid)/i.test(
        output,
      )
    )
      return "REMOTE_AUTH_REJECTED";
    if (
      /failed to connect to (?:local )?tailscaled|is tailscaled running|tailscaled\.sock.*(?:permission denied|no such file|connection refused)/i.test(
        output,
      )
    )
      return "REMOTE_DAEMON_UNAVAILABLE";
    if (
      /requires mentioning all non-default flags|changing settings via.*tailscale up/i.test(output)
    )
      return "REMOTE_SETTINGS_NOT_APPLIED";
    if (/device approval required|machine authorization required|NeedsMachineAuth/i.test(output))
      return "REMOTE_APPROVAL_REQUIRED";
    if (/timeout waiting for.*Running|timed out waiting/i.test(output))
      return "REMOTE_COMMAND_TIMEOUT";
  } else {
    if (/peer.*already registered.*(?:different|another)|desc = invalid user/i.test(output))
      return "REMOTE_PEER_IDENTITY_CONFLICT";
    if (
      /(?:invalid|expired|revoked|exhausted)[ -]setup[ -]?key|setup[ -]?key.{0,100}(?:invalid|expired|revoked|not found|usage limit|exhausted)/i.test(
        output,
      )
    )
      return "REMOTE_AUTH_REJECTED";
    if (
      /disable-update-settings|settings updates? (?:are )?disabled|configuration is locked|daemon refused the settings update/i.test(
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
  }
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
    if (result.exitCode !== 0) return remoteCommandFailure(provider, result.output);
    if (provider === "netbird") {
      if (/Already connected and the connection belongs to another user/i.test(result.output))
        return "REMOTE_PEER_IDENTITY_CONFLICT";
      if (/daemon did not apply the settings update/i.test(result.output))
        return "REMOTE_SETTINGS_NOT_APPLIED";
    }
    return null;
  } catch (error) {
    return error instanceof CommandError && error.kind === "timeout"
      ? "REMOTE_COMMAND_TIMEOUT"
      : "REMOTE_COMMAND_FAILED";
  }
}
