import type { PdfSession } from "./types.ts";

/** Print resolution: sharp text on paper without holding huge images in memory. */
export const PRINT_DPI = 150;

/**
 * Renders every page (as it is shown: rotated or not) into `target` for the browser's print
 * dialog, one page per sheet. Returns a function that frees the images. Stops on `signal`.
 */
export async function preparePrint(
  session: PdfSession,
  target: HTMLElement,
  onProgress: (done: number) => void,
  signal: AbortSignal,
): Promise<() => void> {
  const urls: string[] = [];
  const cleanup = () => {
    for (const url of urls) URL.revokeObjectURL(url);
    target.replaceChildren();
  };
  try {
    for (let page = 1; page <= session.pageCount; page += 1) {
      if (signal.aborted) throw new DOMException("Printing was cancelled", "AbortError");
      const url = URL.createObjectURL(await session.renderForPrint(page, PRINT_DPI));
      urls.push(url);
      const sheet = document.createElement("div");
      sheet.className = "pdf-print-page";
      const image = document.createElement("img");
      image.src = url;
      image.alt = "";
      sheet.append(image);
      target.append(sheet);
      onProgress(page);
    }
    // Every image ready before the dialog takes its snapshot.
    await Promise.all(
      [...target.querySelectorAll("img")].map((image) => image.decode?.().catch(() => undefined)),
    );
  } catch (error) {
    cleanup();
    throw error;
  }
  return cleanup;
}
