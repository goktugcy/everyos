import type { DiskUsage, SystemStorage } from "@everyos/app-sdk";

export const usage: DiskUsage = {
  total: 1200,
  files: 3,
  folders: 1,
  truncated: false,
  children: [
    { name: "media", kind: "directory", size: 1000, items: 2 },
    { name: "notes.txt", kind: "file", size: 200, items: 1 },
  ],
  largest: [
    { path: "media/movie.mkv", size: 900 },
    { path: "notes.txt", size: 200 },
    { path: "media/song.mp3", size: 100 },
  ],
  types: [
    { extension: "mkv", count: 1, size: 900 },
    { extension: "txt", count: 1, size: 200 },
    { extension: "mp3", count: 1, size: 100 },
  ],
};
export const storage: SystemStorage = {
  source: "host",
  mounts: [
    {
      device: "/dev/data",
      mountpoint: "/data",
      fsType: "ext4",
      readOnly: false,
      totalBytes: 10000,
      usedBytes: 6000,
      availableBytes: 3500,
      inodesTotal: 1000,
      inodesFree: 800,
    },
  ],
};
