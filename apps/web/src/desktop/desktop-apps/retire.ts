/**
 * How long the bridge of a closed app keeps answering. An app saves what is pending as its window
 * goes away (on `pagehide`); those requests are already on their way when the frame is removed
 * and must still be carried out before the bridge closes and the instance ends.
 */
export const RETIRE_GRACE_MS = 2000;

const pending = new Set<() => void>();
let listening = false;

/** Runs `finish` after the grace period, or at once if the desktop page itself is going away. */
export function retireLater(finish: () => void, target: Pick<Window, "addEventListener"> = window) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    pending.delete(run);
    finish();
  };
  const timer = setTimeout(run, RETIRE_GRACE_MS);
  pending.add(run);
  if (!listening) {
    listening = true;
    target.addEventListener("pagehide", () => {
      for (const retire of [...pending]) retire();
    });
  }
}
