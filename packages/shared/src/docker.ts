/*
 * Zod-free constants and view types for Docker management. Runtime schemas
 * live in "@otuken/shared/schemas" (schemas/docker.ts).
 */

export const CONTAINER_ACTIONS = ["start", "stop", "restart"] as const;

export type ContainerAction = (typeof CONTAINER_ACTIONS)[number];

/**
 * Compose operations on imported projects. `update` pulls newer images and
 * recreates changed services; `down` removes containers and networks but
 * never volumes or images.
 */
export const COMPOSE_ACTIONS = ["up", "start", "stop", "restart", "update", "down"] as const;

export type ComposeAction = (typeof COMPOSE_ACTIONS)[number];

export const CONTAINER_STATES = [
  "created",
  "running",
  "paused",
  "restarting",
  "removing",
  "exited",
  "dead",
] as const;

export type ContainerState = (typeof CONTAINER_STATES)[number];

export const HEALTH_STATES = ["healthy", "unhealthy", "starting", "none"] as const;

export type HealthState = (typeof HEALTH_STATES)[number];

/**
 * Who manages a Docker resource. Decided only from Otuken's own records,
 * never from container labels (images can carry arbitrary labels).
 * - managed: installed by the Otuken App Store (Phase 5)
 * - imported: a Compose project the owner explicitly imported
 * - external: everything else; Otuken never claims ownership
 */
export const DOCKER_OWNERSHIP = ["managed", "imported", "external"] as const;

export type DockerOwnership = (typeof DOCKER_OWNERSHIP)[number];

/** Other tools that appear to manage a Compose project (a hint, not a guarantee). */
export const DOCKER_MANAGERS = ["casaos", "coolify", "runtipi", "portainer"] as const;

export type DockerManager = (typeof DOCKER_MANAGERS)[number];

/** Container settings that weaken isolation from the host. */
export const CONTAINER_RISKS = [
  "privileged",
  "docker-socket",
  "host-network",
  "host-pid",
  "host-ipc",
  "added-capabilities",
  "devices",
  "apparmor-unconfined",
  "seccomp-unconfined",
  "host-root-mount",
] as const;

export type ContainerRisk = (typeof CONTAINER_RISKS)[number];

/** Docker object identifiers accepted by Otuken (no names, paths or options). */
export const CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/;
export const IMAGE_ID_PATTERN = /^(sha256:)?[a-f0-9]{12,64}$/;
export const NETWORK_ID_PATTERN = /^[a-f0-9]{12,64}$/;
export const VOLUME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
/** Compose project names as normalized by Compose itself. */
export const COMPOSE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Built-in networks that can never be removed. */
export const BUILT_IN_NETWORKS = ["bridge", "host", "none"] as const;

/** Derived (rate) values for one container, computed by the API from raw counters. */
export interface ContainerStatsPoint {
  at: number;
  cpuPercent: number | null;
  memoryBytes: number;
  memoryLimitBytes: number | null;
  netRxBytesPerSec: number | null;
  netTxBytesPerSec: number | null;
  blockReadBytesPerSec: number | null;
  blockWriteBytesPerSec: number | null;
  pids: number | null;
}

/** Latest stats of every running container, pushed on the `docker` event topic. */
export interface DockerStatsSnapshot {
  source: "host" | "simulated";
  at: number;
  containers: Record<string, ContainerStatsPoint>;
}

export interface ContainerStatsHistory {
  id: string;
  resolutionMs: number;
  points: ContainerStatsPoint[];
}

/** A lightweight change notification; clients refetch what they display. */
export interface DockerChangeEvent {
  type: "container" | "image" | "volume" | "network";
  action: string;
  id: string;
  name: string | null;
  at: number;
}
