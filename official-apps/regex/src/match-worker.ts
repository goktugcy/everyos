import { runMatch, type MatchRequest } from "./match-core.ts";

/** Runs one match per message; the window stops this worker when it takes too long. */
onmessage = (event: MessageEvent<{ id: number; request: MatchRequest }>) => {
  postMessage({ id: event.data.id, result: runMatch(event.data.request) });
};
