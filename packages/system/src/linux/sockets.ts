/*
 * /proc/net/{tcp,tcp6,udp,udp6} parsing. Addresses are hex, each 32-bit word
 * in host (little-endian) byte order on the platforms EveryOS supports.
 */

export interface ProcNetSocket {
  protocol: "tcp" | "udp";
  address: string;
  port: number;
  remotePort: number;
  /** Kernel TCP state code (0A = LISTEN, 01 = ESTABLISHED, 06 = TIME_WAIT; UDP 07 = unconnected). */
  state: string;
  inode: number;
}

function wordToOctets(word: string): number[] {
  const value = Number.parseInt(word, 16);
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

export function decodeAddress(hex: string): string {
  if (hex.length === 8) return wordToOctets(hex).join(".");
  if (hex.length !== 32) return hex;
  const bytes = [0, 8, 16, 24].flatMap((offset) => wordToOctets(hex.slice(offset, offset + 8)));
  // IPv4-mapped (::ffff:a.b.c.d) is shown as plain IPv4.
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return bytes.slice(12).join(".");
  }
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  const full = groups.join(":");
  // Compress the longest run of zero groups (RFC 5952).
  let best = { start: -1, length: 0 };
  for (let i = 0; i < 8;) {
    if (groups[i] !== "0") {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === "0") j++;
    if (j - i > best.length && j - i > 1) best = { start: i, length: j - i };
    i = j;
  }
  if (best.start < 0) return full;
  const head = groups.slice(0, best.start).join(":");
  const tail = groups.slice(best.start + best.length).join(":");
  return `${head}::${tail}`;
}

export function parseProcNet(text: string, protocol: "tcp" | "udp"): ProcNetSocket[] {
  const out: ProcNetSocket[] = [];
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const [localAddress, localPort] = fields[1]!.split(":");
    const remotePort = fields[2]!.split(":")[1];
    if (!localAddress || !localPort || !remotePort) continue;
    out.push({
      protocol,
      address: decodeAddress(localAddress),
      port: Number.parseInt(localPort, 16),
      remotePort: Number.parseInt(remotePort, 16),
      state: fields[3]!.toUpperCase(),
      inode: Number(fields[9]),
    });
  }
  return out;
}

/** Listening sockets: TCP in LISTEN, UDP sockets without a peer. */
export function isListening(socket: ProcNetSocket): boolean {
  return socket.protocol === "tcp"
    ? socket.state === "0A"
    : socket.remotePort === 0 && socket.state === "07";
}
