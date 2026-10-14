import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { StringDecoder } from "node:string_decoder";
import type { AiChatMessage } from "@everyos/shared";
import { z } from "zod";
import {
  IntegrationHttpError,
  resolveIntegrationAddress,
  type HttpOptions,
} from "../integrations/http.ts";

const Chunk = z.object({
  choices: z
    .array(
      z.object({
        delta: z.object({ content: z.string().nullable().optional() }).optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .optional(),
  error: z.unknown().optional(),
});

/** A run the agent reported as failed, with its own redacted, bounded explanation. */
export class AgentRunError extends IntegrationHttpError {
  readonly detail: string;
  constructor(detail: string) {
    super("invalid", "Agent run failed");
    this.detail = detail;
  }
}

/**
 * Fixed OpenAI chat endpoint, pinned DNS, bounded SSE, no redirects. Upstream errors surface only
 * as the agent's own stream error message, with known secrets redacted and bounded in size.
 */
export async function streamAgentChat(input: {
  url: string;
  key: string;
  model: string;
  user: string;
  messages: AiChatMessage[];
  signal: AbortSignal;
  onDelta: (text: string) => Promise<void>;
  resolve?: HttpOptions["resolve"];
  redactSecrets?: string[];
}): Promise<string> {
  const target = new URL(input.url);
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(10 * 60_000)]);
  // Cancellation must also release the turn while an upstream DNS lookup is pending.
  const resolving = resolveIntegrationAddress(target, input.resolve);
  const pinned = await new Promise<Awaited<typeof resolving>>((resolve, reject) => {
    const abort = () => reject(new IntegrationHttpError("offline", "Agent connection ended"));
    if (signal.aborted) {
      abort();
      void resolving.catch(() => undefined);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void resolving.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
  const body = Buffer.from(
    JSON.stringify({
      model: input.model,
      messages: input.messages,
      stream: true,
      user: input.user,
    }),
  );
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(
      target,
      {
        method: "POST",
        agent: false,
        signal,
        family: pinned.family,
        lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
        headers: {
          // Local model servers often have no key.
          ...(input.key ? { Authorization: `Bearer ${input.key}` } : {}),
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Accept-Encoding": "identity",
          "Content-Length": String(body.length),
        },
      },
      resolve,
    );
    request.on("error", () =>
      reject(new IntegrationHttpError("offline", "Agent connection ended")),
    );
    request.end(body);
  });
  try {
    const status = response.statusCode ?? 0;
    if (status === 401 || status === 403)
      throw new IntegrationHttpError("auth", "Agent rejected authentication");
    if (status < 200 || status >= 300)
      throw new IntegrationHttpError("status", "Agent request failed", status);
    if (!response.headers["content-type"]?.includes("text/event-stream"))
      throw new IntegrationHttpError("invalid", "Agent did not return a chat stream");
    const decoder = new StringDecoder("utf8");
    let content = "";
    const secrets = [...new Set([input.key, ...(input.redactSecrets ?? [])].filter(Boolean))];
    let pending = "";
    const emit = async (text: string) => {
      if (!text) return;
      content += text;
      if (Buffer.byteLength(content) > 128 * 1024)
        throw new IntegrationHttpError("too-large", "Agent answer too large");
      await input.onDelta(text);
    };
    const safeDelta = async (text: string, flush = false) => {
      pending += text;
      while (pending.length) {
        let keep = 0;
        if (!flush)
          for (const secret of secrets)
            for (let size = Math.min(secret.length - 1, pending.length); size > keep; size--) {
              if (pending.endsWith(secret.slice(0, size))) {
                keep = size;
                break;
              }
            }
        const boundary = pending.length - keep;
        if (!boundary) return;
        const matches = secrets
          .map((secret) => ({ secret, index: pending.indexOf(secret) }))
          .filter((match) => match.index >= 0 && match.index < boundary)
          .sort((a, b) => a.index - b.index);
        const match = matches[0];
        if (match) {
          await emit(pending.slice(0, match.index) + "[REDACTED]");
          pending = pending.slice(match.index + match.secret.length);
        } else {
          await emit(pending.slice(0, boundary));
          pending = pending.slice(boundary);
        }
      }
    };
    let buffer = "",
      bytes = 0,
      done = false;
    const line = async (value: string) => {
      if (!value.startsWith("data:")) return;
      const data = value.slice(5).trim();
      if (data === "[DONE]") {
        done = true;
        return;
      }
      if (!data || done) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        throw new IntegrationHttpError("invalid", "Invalid agent stream");
      }
      const chunk = Chunk.safeParse(parsed);
      if (!chunk.success) throw new IntegrationHttpError("invalid", "Agent run failed");
      // Hermes ends a failed turn with finish_reason "error", sometimes after fallback text.
      if (chunk.data.error !== undefined || chunk.data.choices?.[0]?.finish_reason === "error") {
        const error = chunk.data.error,
          message =
            typeof error === "string"
              ? error
              : error !== null && typeof error === "object" && "message" in error
                ? String(error.message)
                : "";
        const detail = secrets
          .reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), message)
          .replace(/[\p{Cc}\s]+/gu, " ")
          .trim();
        throw new AgentRunError(detail.length > 300 ? `${detail.slice(0, 299)}…` : detail);
      }
      const text = chunk.data.choices?.[0]?.delta?.content;
      if (text) {
        if (signal.aborted) throw new IntegrationHttpError("offline", "Chat cancelled");
        await safeDelta(text);
      }
    };
    for await (const raw of response) {
      const chunk = raw as Buffer;
      bytes += chunk.length;
      if (bytes > 1024 * 1024)
        throw new IntegrationHttpError("too-large", "Agent stream too large");
      buffer += decoder.write(chunk);
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const value = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        await line(value);
      }
      if (Buffer.byteLength(buffer) > 64 * 1024)
        throw new IntegrationHttpError("too-large", "Agent stream frame too large");
      if (done) break;
    }
    buffer += decoder.end();
    if (buffer.trim()) await line(buffer.replace(/\r$/, ""));
    if (done && !signal.aborted) await safeDelta("", true);
    if (signal.aborted || !done || !content.trim())
      throw new IntegrationHttpError("invalid", "Agent did not finish its answer");
    return content;
  } catch (error) {
    if (error instanceof IntegrationHttpError) throw error;
    throw new IntegrationHttpError("offline", "Agent connection ended");
  } finally {
    response.destroy();
  }
}
