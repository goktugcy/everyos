import type { Context } from "hono";
import type { z } from "zod";
import { ApiError } from "./errors.ts";

function issues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

/** Parses and validates a JSON request body against a schema. */
export async function parseJsonBody<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<z.output<S>> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "BAD_REQUEST", "Expected an application/json body");
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, "BAD_REQUEST", "Malformed JSON body");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ApiError(400, "VALIDATION_FAILED", "Request validation failed", {
      details: issues(result.error),
    });
  }
  return result.data;
}

export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) {
    throw new ApiError(400, "VALIDATION_FAILED", "Invalid query parameters", {
      details: issues(result.error),
    });
  }
  return result.data;
}
