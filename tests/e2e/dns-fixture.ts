import { createSocket } from "node:dgram";
import { once } from "node:events";

/** A loopback-only DNS fixture; real UDP queries, no external resolver dependency. */
export async function startDnsFixture() {
  const socket = createSocket("udp4");
  const queries: string[] = [];
  socket.on("message", (message, peer) => {
    if (message.length < 17) return;
    let offset = 12;
    const labels: string[] = [];
    while (offset < message.length && message[offset]) {
      const length = message[offset]!;
      if (length > 63 || offset + length + 1 >= message.length) return;
      labels.push(message.subarray(offset + 1, offset + 1 + length).toString("ascii"));
      offset += length + 1;
    }
    if (offset + 5 > message.length) return;
    offset++;
    const name = labels.join(".").toLowerCase();
    queries.push(name);
    const type = message.readUInt16BE(offset);
    const address = name === "printer.home.arpa" && type === 1;
    const header = Buffer.alloc(12);
    message.copy(header, 0, 0, 2);
    header.writeUInt16BE(name === "printer.home.arpa" ? 0x8180 : 0x8183, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(address ? 1 : 0, 6);
    const answer = address
      ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 1, 44, 0, 4, 192, 0, 2, 40])
      : Buffer.alloc(0);
    socket.send(
      Buffer.concat([header, message.subarray(12, offset + 4), answer]),
      peer.port,
      peer.address,
    );
  });
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  return {
    port: socket.address().port,
    queries,
    async close() {
      socket.close();
      await once(socket, "close");
    },
  };
}
