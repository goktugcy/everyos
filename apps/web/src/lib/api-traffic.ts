const resources = ["auth", "system", "files", "apps", "preferences", "updates", "widgets"] as const;

export interface ApiTraffic {
  method: string;
  resource: (typeof resources)[number] | "api";
  status: number;
  timestamp: number;
  durationMs: number;
  sentBytes: number;
  receivedBytes: number | null;
}

const listeners = new Set<(entry: ApiTraffic) => void>();

/** Only active viewers receive metadata; URLs, headers and bodies never enter this channel. */
export function subscribeApiTraffic(listener: (entry: ApiTraffic) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function traceApiRequest(method: string, path: string, sentBytes: number) {
  const viewers = [...listeners];
  const started = performance.now();
  const candidate = path.split(/[/?#]/)[1] ?? "";
  const resource = resources.find((value) => value === candidate) ?? "api";
  return (status: number, receivedBytes: number | null) => {
    const entry: ApiTraffic = {
      method,
      resource,
      status,
      receivedBytes,
      sentBytes,
      timestamp: Date.now(),
      durationMs: Math.max(0, performance.now() - started),
    };
    for (const viewer of viewers) {
      if (!listeners.has(viewer)) continue;
      // Diagnostics must never affect the original request's success or failure.
      try {
        viewer(entry);
      } catch {
        /* A detached view may no longer accept updates. */
      }
    }
  };
}
