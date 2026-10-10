import type { CapabilityReason } from "@otuken/shared";

/** A collector cannot run on this host; the reason is shown instead of fabricated data. */
export class UnavailableError extends Error {
  readonly reason: CapabilityReason;

  constructor(reason: CapabilityReason, message = `Unavailable: ${reason}`) {
    super(message);
    this.name = "UnavailableError";
    this.reason = reason;
  }
}
