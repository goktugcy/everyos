import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

// An owned synthetic clip; regression tests use the committed bytes, not a live encoder.
// Regenerate with: node tests/e2e/make-mp4-fixture.ts
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const result = await page.evaluate(async () => {
    const mimeType = 'video/mp4;codecs="avc1.42001E"';
    if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error("MP4/H.264 recorder unavailable");
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const context = canvas.getContext("2d")!;
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 50000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = reject;
    });
    let frame = 0;
    const draw = () => {
      context.fillStyle = "#103b49";
      context.fillRect(0, 0, 160, 90);
      context.fillStyle = "#7dd3fc";
      context.fillRect((frame++ * 5) % 140, 30, 20, 30);
    };
    draw();
    const timer = setInterval(draw, 100);
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    recorder.stop();
    await stopped;
    clearInterval(timer);
    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(chunks, { type: "video/mp4" });
    const video = document.createElement("video");
    video.src = URL.createObjectURL(blob);
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("MP4 decode failed"));
    });
    const metadata = {
      width: video.videoWidth,
      height: video.videoHeight,
      duration: video.duration,
    };
    URL.revokeObjectURL(video.src);
    return { bytes: [...new Uint8Array(await blob.arrayBuffer())], metadata };
  });
  const bytes = Buffer.from(result.bytes);
  assert.equal(bytes.toString("ascii", 4, 8), "ftyp");
  assert.equal(result.metadata.width, 160);
  assert.equal(result.metadata.height, 90);
  assert(Number.isFinite(result.metadata.duration) && result.metadata.duration > 0);
  await writeFile(new URL("fixtures/media/demo.mp4", import.meta.url), bytes);
  console.log(JSON.stringify({ bytes: bytes.length, ...result.metadata, source: "simulated" }));
} finally {
  await browser.close();
}
