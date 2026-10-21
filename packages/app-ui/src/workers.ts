/**
 * Starts a Web Worker from one of the app's own files (an entry of `workers` in
 * everyos.config.json, built into one self-contained file). An app runs in an opaque origin, where
 * `new Worker(url)` is refused for its http(s) files; the worker starts from a blob URL of the same
 * code instead, which the app's content security policy allows (`worker-src 'self' blob:`).
 */
export async function startWorker(path: string, options: WorkerOptions = {}): Promise<Worker> {
  const response = await fetch(new URL(path, document.baseURI));
  if (!response.ok) throw new Error(`The worker ${path} could not be loaded (${response.status})`);
  const url = URL.createObjectURL(new Blob([await response.text()], { type: "text/javascript" }));
  const worker = new Worker(url, { type: "module", ...options });
  // The worker has fetched its code well before this.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return worker;
}
