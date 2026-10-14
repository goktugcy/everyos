import { createInterface } from "node:readline";
import { createLogger } from "@everyos/logger";
import {
  AGENT_OPERATIONS,
  OperationError,
  isOperationName,
  type Actor,
  type OperationContext,
} from "@everyos/agent-protocol";
import { z } from "zod";
import { LinuxAccountSchema } from "@everyos/shared/schemas";
import { roleHasPermission } from "@everyos/shared";
import { createInternetProbe } from "@everyos/system";
import { createHandlers } from "./handlers.ts";
import { selectBackends } from "./backends.ts";
import { createContainerProtection, createUnitProtection } from "./protection.ts";
import { createPolicy } from "./policy.ts";
import { accountFiles } from "./account-files.ts";
import { accountNativeAgents } from "./native-agents.ts";

const BootstrapSchema = z.strictObject({
  account: LinuxAccountSchema,
  userId: z.string().uuid(),
  version: z.string(),
  dockerSocket: z.string().nullable(),
  protectedUnits: z.array(z.string()),
  protectedContainers: z.array(z.string()),
  internetCheckTargets: z.array(z.string()),
  roots: z.array(
    z.strictObject({ id: z.string(), name: z.string(), path: z.string(), readOnly: z.boolean() }),
  ),
  maxUploadBytes: z.number(),
  minFreeBytes: z.number(),
});
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const iterator = lines[Symbol.asyncIterator]();
const boot = BootstrapSchema.parse(JSON.parse((await iterator.next()).value ?? "null"));
if (process.getuid?.() !== boot.account.uid || process.getgid?.() !== boot.account.gid)
  process.exit(126);
const logger = createLogger({
  name: "everyos-account",
  level: "warn",
  format: "json",
  sink: process.stderr,
});
const isProtected = createUnitProtection(boot.protectedUnits);
const isProtectedContainer = createContainerProtection(boot.protectedContainers);
const backends = await selectBackends(
  { mode: "production", simulate: false, dockerSocket: boot.dockerSocket },
  isProtectedContainer,
);
const handlers = {
  ...createHandlers({
    ...backends,
    mode: "production",
    version: boot.version,
    startedAt: Date.now(),
    isProtected,
    isProtectedContainer,
    internet: createInternetProbe(boot.internetCheckTargets),
  }),
  ...accountFiles({ ...boot, home: boot.account.home, logger }),
  ...accountNativeAgents(boot.account.home),
};
const policy = createPolicy({
  mode: "production",
  isProtected,
  servicesSource: "host",
  dockerSource: "host",
  aptSource: "host",
});
const running = new Map<number, AbortController>();
const send = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const invoke = async (frame: { id: number; op: string; params: unknown; actor: Actor }) => {
  const abort = new AbortController();
  running.set(frame.id, abort);
  try {
    if (
      !isOperationName(frame.op) ||
      frame.op.startsWith("identity.") ||
      frame.op.startsWith("terminal.") ||
      frame.op.startsWith("release.") ||
      frame.op.startsWith("backups.") ||
      frame.op.startsWith("apps.")
    )
      throw new OperationError("forbidden", "Operation unavailable in account worker");
    const contract = AGENT_OPERATIONS[frame.op];
    if (
      frame.actor.kind !== "user" ||
      frame.actor.userId !== boot.userId ||
      (contract.permission && !roleHasPermission(frame.actor.role, contract.permission))
    )
      throw new OperationError("forbidden", "Permission required");
    const decision = policy(frame.op, frame.params, frame.actor);
    if (!decision.allowed) throw new OperationError("policy_denied", decision.reason);
    const params = contract.params.parse(frame.params);
    const handler = handlers[frame.op] as (p: unknown, context: OperationContext) => unknown;
    const result = handler(params, { actor: frame.actor, signal: abort.signal, logger });
    if (contract.kind === "unary")
      send({ id: frame.id, result: contract.result.parse(await result) });
    else {
      for await (const event of result as AsyncIterable<unknown>) {
        if (!send({ id: frame.id, event: contract.event.parse(event) }))
          await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
      }
      send({ id: frame.id, result: null });
    }
  } catch (error) {
    send({
      id: frame.id,
      error: {
        code: error instanceof OperationError ? error.code : "failed",
        message: error instanceof OperationError ? error.message : "Account operation failed",
      },
    });
  } finally {
    running.delete(frame.id);
  }
};
while (true) {
  const line = await iterator.next();
  if (line.done) break;
  if (line.value.length > 1_048_576) process.exit(1);
  const frame = JSON.parse(line.value) as {
    cancel?: number;
    id: number;
    op: string;
    params: unknown;
    actor: Actor;
  };
  if (frame.cancel !== undefined) running.get(frame.cancel)?.abort();
  else if (running.size < 32) void invoke(frame);
  else send({ id: frame.id, error: { code: "busy", message: "Too many operations" } });
}
for (const abort of running.values()) abort.abort();
process.exit(0);
