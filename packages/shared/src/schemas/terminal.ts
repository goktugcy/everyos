import { z } from "zod";
import { TERMINAL_DISABLED_REASONS } from "../terminal.ts";

const SessionIdSchema = z.string().uuid();
const Cols = z.number().int().min(2).max(500);
const Rows = z.number().int().min(2).max(300);
/** Base64, at most 64 KiB of raw bytes per message. */
const Base64Schema = z
  .string()
  .max(88_000)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

export const TerminalStatusSchema = z.union([
  z.object({ enabled: z.literal(true), user: z.string().max(64), shell: z.string().max(256) }),
  z.object({ enabled: z.literal(false), reason: z.enum(TERMINAL_DISABLED_REASONS) }),
]);

export const TerminalOpenSchema = z.strictObject({
  sessionId: SessionIdSchema,
  cols: Cols,
  rows: Rows,
});

export const TerminalEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), user: z.string().max(64), shell: z.string().max(256) }),
  z.object({ type: z.literal("output"), data: Base64Schema }),
  z.object({
    type: z.literal("exit"),
    code: z.number().int().nullable(),
  }),
]);

export const TerminalInputSchema = z.strictObject({
  sessionId: SessionIdSchema,
  data: Base64Schema,
});

export const TerminalResizeSchema = z.strictObject({
  sessionId: SessionIdSchema,
  cols: Cols,
  rows: Rows,
});

export const TerminalCloseSchema = z.strictObject({ sessionId: SessionIdSchema });

/** WebSocket control frames from the browser. */
export const TerminalClientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("resize"), cols: Cols, rows: Rows }),
]);

/** `GET /api/terminal/ws?session=&cols=&rows=` */
export const TerminalConnectQuerySchema = z.strictObject({
  session: SessionIdSchema.optional(),
  cols: z.coerce.number().int().min(2).max(500).default(80),
  rows: z.coerce.number().int().min(2).max(300).default(24),
});
