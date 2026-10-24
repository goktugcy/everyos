import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";

// Regenerate the synthetic fixture with: node tests/e2e/make-video-fixture.ts
// Browser tests consume the committed bytes and do not need a recorder, encoder or network.
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const recording = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d")!;
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp8",
      videoBitsPerSecond: 100000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    let frame = 0;
    const draw = () => {
      context.fillStyle = "#103b49";
      context.fillRect(0, 0, 640, 360);
      context.fillStyle = "#7dd3fc";
      context.fillRect((frame++ * 10) % 640, 180, 100, 90);
      context.fillStyle = "white";
      context.font = "28px sans-serif";
      context.fillText("EveryOS synthetic video fixture", 30, 80);
    };
    draw();
    const timer = setInterval(draw, 100);
    const start = performance.now();
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 8000));
    recorder.stop();
    await stopped;
    const ms = performance.now() - start;
    clearInterval(timer);
    stream.getTracks().forEach((track) => track.stop());
    return { bytes: [...new Uint8Array(await new Blob(chunks).arrayBuffer())], ms };
  });
  const raw = Buffer.from(recording.bytes);
  // Streaming MediaRecorder omits Duration. Add it inside Info so this owned fixture is seekable.
  // https://www.matroska.org/technical/elements.html: Duration uses TimestampScale-based ticks.
  const info = raw.indexOf(Buffer.from([0x15, 0x49, 0xa9, 0x66]));
  if (info < 0) throw new Error("Recorder did not emit Info");
  const vint = (offset: number) => {
    let width = 1;
    let marker = 0x80;
    while (!(raw[offset]! & marker)) {
      width++;
      marker >>= 1;
    }
    let value = BigInt(raw[offset]! & (marker - 1));
    for (let i = 1; i < width; i++) value = value * 256n + BigInt(raw[offset + i]!);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsupported Info size");
    return { width, value: Number(value) };
  };
  const size = vint(info + 4);
  const dataStart = info + 4 + size.width;
  const dataEnd = dataStart + size.value;
  const scaleAt = raw.indexOf(Buffer.from([0x2a, 0xd7, 0xb1]), dataStart);
  if (scaleAt < 0 || scaleAt >= dataEnd) throw new Error("Missing TimestampScale");
  const scaleSize = vint(scaleAt + 3);
  const scale = raw.readUIntBE(scaleAt + 3 + scaleSize.width, scaleSize.value);
  const duration = Buffer.alloc(11);
  duration.set([0x44, 0x89, 0x88]);
  duration.writeDoubleBE((recording.ms * 1000000) / scale, 3);
  let width = size.width;
  while (size.value + duration.length >= 2 ** (7 * width) - 1) width++;
  let encoded = BigInt(size.value + duration.length);
  const sizeBytes = Buffer.alloc(width);
  for (let i = width - 1; i >= 0; i--) {
    sizeBytes[i] = Number(encoded & 255n);
    encoded >>= 8n;
  }
  sizeBytes[0] = sizeBytes[0]! | (1 << (8 - width));
  const bytes = Buffer.concat([
    raw.subarray(0, info + 4),
    sizeBytes,
    raw.subarray(dataStart, dataEnd),
    duration,
    raw.subarray(dataEnd),
  ]);
  const decoded = await page.evaluate(
    async (data) => {
      const video = document.createElement("video");
      video.src = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: "video/webm" }));
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("Fixture cannot decode"));
      });
      return { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
    },
    [...bytes],
  );
  if (!Number.isFinite(decoded.duration) || decoded.width !== 640)
    throw new Error("Fixture metadata is invalid");
  await writeFile(new URL("./fixtures/media/demo.webm", import.meta.url), bytes);
  console.log({ bytes: bytes.length, ...decoded });
} finally {
  await browser.close();
}
