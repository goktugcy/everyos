import { EVENT_TOPICS, type EventTopic, type TopicMessage } from "@everyos/shared";
import { useSessionStore } from "../stores/session-store.ts";
import { api } from "./api.ts";

/*
 * One multiplexed server-sent event stream per tab (`/api/events?topics=…`).
 * Components subscribe to topics; the connection carries the union of the
 * subscribed topics, is reopened when that set changes, closes while the tab
 * is hidden or the session is locked, and reconnects with backoff.
 */

export type StreamStatus = "connecting" | "live" | "retrying";

/** Event names each topic produces (EventSource needs them up front). */
const TOPIC_EVENTS: Record<EventTopic, readonly string[]> = {
  metrics: ["metrics"],
  docker: ["docker.stats", "docker.change"],
  notifications: ["notifications"],
  release: ["release.status"],
  disks: ["disks.change"],
  transfers: ["transfers"],
};

export interface TopicHandlers {
  /** Called whenever the stream (re)connects; reload anything that may be stale. */
  ready?: () => void;
  /** Live topics (metrics, docker): handlers per event name. */
  events?: Record<string, (data: unknown) => void>;
  /** Shared data topics (`data.*`): every `event: data` message for this topic. */
  data?: (message: TopicMessage) => void;
  status?: (status: StreamStatus) => void;
}

interface Subscription extends TopicHandlers {
  topic: string;
}

const isStreamTopic = (topic: string): topic is EventTopic =>
  (EVENT_TOPICS as readonly string[]).includes(topic);

const MAX_RETRY_MS = 30_000;
const subscriptions = new Set<Subscription>();
let source: EventSource | null = null;
let openTopics = "";
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1_000;
let listening = false;

function setStatus(status: StreamStatus): void {
  for (const subscription of subscriptions) subscription.status?.(status);
}

function wantedTopics(): string {
  const session = useSessionStore.getState();
  if (document.visibilityState !== "visible" || session.phase !== "authenticated" || session.locked)
    return "";
  return [...new Set([...subscriptions].map((s) => s.topic))].sort().join(",");
}

function close(): void {
  source?.close();
  source = null;
  openTopics = "";
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function open(topics: string): void {
  openTopics = topics;
  setStatus("connecting");
  const events = new EventSource(`/api/events?topics=${topics}`);
  source = events;
  events.addEventListener("ready", () => {
    if (source !== events) return;
    retryDelay = 1_000;
    setStatus("live");
    for (const subscription of subscriptions) subscription.ready?.();
  });
  const list = topics.split(",");
  if (list.some((topic) => !isStreamTopic(topic))) {
    events.addEventListener("data", (event) => {
      if (source !== events) return;
      let message: TopicMessage;
      try {
        message = JSON.parse((event as MessageEvent<string>).data) as TopicMessage;
      } catch {
        return;
      }
      for (const subscription of subscriptions) {
        if (subscription.topic === message.topic) subscription.data?.(message);
      }
    });
  }
  for (const topic of list.filter(isStreamTopic)) {
    for (const name of TOPIC_EVENTS[topic]) {
      events.addEventListener(name, (event) => {
        if (source !== events) return;
        let data: unknown;
        try {
          data = JSON.parse((event as MessageEvent<string>).data);
        } catch {
          return;
        }
        for (const subscription of subscriptions) {
          if (subscription.topic === topic) subscription.events?.[name]?.(data);
        }
      });
    }
  }
  events.onerror = () => {
    if (source !== events) return;
    setStatus("retrying");
    // CONNECTING means the browser is already retrying a dropped connection.
    if (events.readyState !== EventSource.CLOSED) return;
    // The server refused the stream (signed out, locked, no permission). A
    // normal request lets the global session handlers react to that.
    close();
    // `/auth/sessions` answers 401 when signed out and 423 when locked.
    void api("/auth/sessions").catch(() => undefined);
    retryTimer = setTimeout(reconcile, retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
  };
}

function reconcile(): void {
  const wanted = wantedTopics();
  if (wanted === openTopics && (source !== null || wanted === "")) return;
  close();
  if (wanted) open(wanted);
}

/** Coalesces bursts of subscribe/unsubscribe (e.g. a window opening) into one reconnect. */
function scheduleReconcile(): void {
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    reconcile();
  }, 30);
}

function listenOnce(): void {
  if (listening) return;
  listening = true;
  document.addEventListener("visibilitychange", reconcile);
  useSessionStore.subscribe((state, previous) => {
    if (state.locked !== previous.locked || state.phase !== previous.phase) reconcile();
  });
}

/** Subscribes to a topic of the shared event stream; returns the unsubscribe function. */
export function subscribeTopic(topic: string, handlers: TopicHandlers): () => void {
  listenOnce();
  const subscription: Subscription = { topic, ...handlers };
  subscriptions.add(subscription);
  scheduleReconcile();
  return () => {
    subscriptions.delete(subscription);
    scheduleReconcile();
  };
}
