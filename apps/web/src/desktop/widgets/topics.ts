import type { TopicMessage, TopicUnavailableReason } from "@everyos/shared";
import { useEffect } from "react";
import { create } from "zustand";
import { subscribeTopic } from "../../lib/event-stream.ts";

export type TopicState<T = unknown> =
  | { status: "loading" }
  | { status: "ok"; data: T; at: number }
  | { status: "unavailable"; reason: TopicUnavailableReason }
  | { status: "error"; code: string };

const LOADING: TopicState<never> = { status: "loading" };

/** Last message of every subscribed data topic in this tab. */
export const useTopicStore = create<Record<string, TopicState>>()(() => ({}));

const counts = new Map<string, number>();
const unsubscribers = new Map<string, () => void>();

/** Adds a reader of a topic; the first one subscribes on the event stream. */
export function acquireTopic(topic: string): void {
  counts.set(topic, (counts.get(topic) ?? 0) + 1);
  if (unsubscribers.has(topic)) return;
  unsubscribers.set(
    topic,
    subscribeTopic(topic, {
      data: (message: TopicMessage) =>
        useTopicStore.setState({
          [topic]:
            message.status === "ok"
              ? { status: "ok", data: message.data, at: message.at }
              : message.status === "unavailable"
                ? { status: "unavailable", reason: message.reason }
                : { status: "error", code: message.code },
        }),
    }),
  );
}

/** Removes a reader; the last one unsubscribes and drops the cached value. */
export function releaseTopic(topic: string): void {
  const next = (counts.get(topic) ?? 1) - 1;
  if (next > 0) {
    counts.set(topic, next);
    return;
  }
  counts.delete(topic);
  unsubscribers.get(topic)?.();
  unsubscribers.delete(topic);
  // Drop the cached value so a later subscriber never shows stale data as current.
  useTopicStore.setState((state) => {
    const { [topic]: _removed, ...rest } = state;
    return rest;
  }, true);
}

/**
 * A shared data topic. Any number of widgets reading the same topic share
 * one subscription on the tab's single event stream (and one collector on
 * the server); the subscription ends with the last reader.
 */
export function useTopic<T>(topic: string | null): TopicState<T> {
  useEffect(() => {
    if (!topic) return;
    acquireTopic(topic);
    return () => releaseTopic(topic);
  }, [topic]);
  // A constant fallback keeps the snapshot stable while nothing has arrived yet.
  return useTopicStore(
    (state) => (topic ? (state[topic] as TopicState<T> | undefined) : undefined) ?? LOADING,
  );
}
