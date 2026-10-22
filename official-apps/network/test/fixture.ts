import type { NetHttpResponse, SystemMetrics, SystemNetwork } from "@everyos/app-sdk";

export const network: SystemNetwork = {
  source: "host",
  interfaces: [
    {
      name: "eth0",
      kind: "ethernet",
      up: true,
      mac: "02:00:00:00:00:01",
      mtu: 1500,
      speedMbps: 1000,
      addresses: [
        { family: "ipv4", address: "192.0.2.10", prefix: 24 },
        { family: "ipv6", address: "2001:db8::10", prefix: 64 },
      ],
    },
  ],
  gateways: [{ interface: "eth0", address: "192.0.2.1", family: "ipv4" }],
  dns: ["9.9.9.9"],
  internet: { state: "online", checkedAt: 1700000000000, latencyMs: 4 },
};
export const metrics: SystemMetrics = {
  source: "host",
  point: {
    at: 1700000000000,
    cpuPercent: null,
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    swapUsedBytes: null,
    swapTotalBytes: null,
    load1: null,
    netRxBytesPerSec: 2048,
    netTxBytesPerSec: 1024,
    diskReadBytesPerSec: null,
    diskWriteBytesPerSec: null,
    temperatureC: null,
  },
  uptimeSeconds: 100,
  load: null,
  cpuCores: null,
  cpuFrequencyMHz: null,
  interfaces: [{ name: "eth0", rxBytesPerSec: 2048, txBytesPerSec: 1024 }],
  disks: null,
  thermal: null,
  fans: null,
};
export const response: NetHttpResponse = {
  url: "https://service.test/",
  status: 404,
  statusText: "Not Found",
  httpVersion: "1.1",
  headers: [["Set-Cookie", "session=endpoint-secret"]],
  body: { encoding: "text", data: "private response", size: 16, truncated: false },
  timing: { dns: 1, connect: 2, tls: 3, firstByte: 4, total: 5 },
  remoteAddress: "192.0.2.15",
  redirects: [],
};
