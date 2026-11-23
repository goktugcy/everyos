import { connect } from "node:net";

/** A single explicitly requested endpoint, with no protocol payload or background scanning. */
export function tcpReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (value: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
