/**
 * Detect the dominant speaker/face in a local video clip and return a
 * normalized focus point (0–1) for speaker-aware short-form cropping.
 *
 * Strategy:
 *  1. Sample a few frames across the clip window
 *  2. Prefer the Chromium FaceDetector API when available (fast, no deps)
 *  3. Fall back to a skin-tone heatmap so Safari/Firefox still get a useful lock
 *  4. Average detections, weighted toward larger / more central faces
 */

export type FocusPoint = {
  focusX: number;
  focusY: number;
  /** How the focus was chosen. */
  source: "face-detector" | "skin-tone" | "center";
  /** Number of frames that contributed a detection. */
  samples: number;
};

const DEFAULT_FOCUS: FocusPoint = {
  focusX: 0.5,
  focusY: 0.5,
  source: "center",
  samples: 0,
};

type DetectedBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
};

type FaceDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<
    Array<{
      boundingBox: { x: number; y: number; width: number; height: number };
    }>
  >;
};

declare global {
  interface Window {
    FaceDetector?: new (options?: {
      fastMode?: boolean;
      maxDetectedFaces?: number;
    }) => FaceDetectorLike;
  }
}

function clamp01(value: number, fallback = 0.5): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function waitForEvent(target: EventTarget, event: string, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);

    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error(`Failed while waiting for ${event}`));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      target.removeEventListener(event, onOk);
      target.removeEventListener("error", onErr);
    };

    target.addEventListener(event, onOk, { once: true });
    target.addEventListener("error", onErr, { once: true });
  });
}

async function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  if (!Number.isFinite(time)) return;
  const target = Math.max(0, Math.min(time, Math.max(0, (video.duration || time) - 0.05)));
  if (Math.abs(video.currentTime - target) < 0.04) return;

  const seeked = waitForEvent(video, "seeked", 6000);
  try {
    video.currentTime = target;
  } catch {
    // Some browsers throw if seek is called before readyState is high enough.
  }
  await seeked;
}

function createDetector(): FaceDetectorLike | null {
  if (typeof window === "undefined" || typeof window.FaceDetector !== "function") {
    return null;
  }
  try {
    return new window.FaceDetector({ fastMode: true, maxDetectedFaces: 4 });
  } catch {
    return null;
  }
}

async function detectFacesWithApi(
  detector: FaceDetectorLike,
  canvas: HTMLCanvasElement,
): Promise<DetectedBox[]> {
  try {
    const faces = await detector.detect(canvas);
    return faces
      .map((face) => {
        const box = face.boundingBox;
        const area = Math.max(0, box.width) * Math.max(0, box.height);
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        // Prefer larger faces near the optical center of the frame.
        const centerBias =
          1 - Math.min(1, Math.hypot(cx / canvas.width - 0.5, cy / canvas.height - 0.45) * 1.4);
        return {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          score: area * (0.55 + centerBias * 0.45),
        };
      })
      .filter((box) => box.width > 8 && box.height > 8);
  } catch {
    return [];
  }
}

/**
 * Cheap skin-tone heatmap fallback. Not perfect, but reliably pulls focus
 * toward a talking-head subject when FaceDetector isn't available.
 */
function detectSkinToneFocus(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): DetectedBox | null {
  const width = canvas.width;
  const height = canvas.height;
  if (width < 8 || height < 8) return null;

  let image: ImageData;
  try {
    image = ctx.getImageData(0, 0, width, height);
  } catch {
    return null;
  }

  const data = image.data;
  // Coarse grid keeps this fast on large frames.
  const cols = 24;
  const rows = 18;
  const cellW = width / cols;
  const cellH = height / rows;
  const heat = new Float32Array(cols * rows);

  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      // Classic RGB skin-tone heuristic (works on a wide range of lighting).
      const isSkin =
        r > 95 &&
        g > 40 &&
        b > 20 &&
        r > g &&
        r > b &&
        Math.abs(r - g) > 12 &&
        r - Math.min(g, b) > 15;

      if (!isSkin) continue;
      const col = Math.min(cols - 1, Math.floor(x / cellW));
      const row = Math.min(rows - 1, Math.floor(y / cellH));
      // Bias slightly toward upper-middle of the frame (talking-head zone).
      const rowBias = 1.15 - Math.abs(row / (rows - 1) - 0.38) * 0.7;
      heat[row * cols + col] += rowBias;
    }
  }

  let best = 0;
  let bestIndex = -1;
  for (let i = 0; i < heat.length; i += 1) {
    if (heat[i] > best) {
      best = heat[i];
      bestIndex = i;
    }
  }

  // Require a minimum signal so empty/dark frames don't invent a subject.
  const threshold = (width * height) / (cols * rows) / 90;
  if (bestIndex < 0 || best < threshold) return null;

  const col = bestIndex % cols;
  const row = Math.floor(bestIndex / cols);
  // Expand a bit around the hottest cell so focus sits on the face, not a cheek pixel.
  const expandX = cellW * 1.6;
  const expandY = cellH * 2.2;
  const cx = (col + 0.5) * cellW;
  const cy = (row + 0.5) * cellH;

  return {
    x: Math.max(0, cx - expandX / 2),
    y: Math.max(0, cy - expandY / 2),
    width: Math.min(width, expandX),
    height: Math.min(height, expandY),
    score: best,
  };
}

function pickBestBox(boxes: DetectedBox[]): DetectedBox | null {
  if (boxes.length === 0) return null;
  return boxes.reduce((best, box) => (box.score > best.score ? box : best), boxes[0]);
}

function boxToFocus(box: DetectedBox, width: number, height: number): { focusX: number; focusY: number } {
  // Bias a touch above the geometric center of the face box so eyes/forehead
  // sit comfortably in the upper third of a 9:16 frame.
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height * 0.42;
  return {
    focusX: clamp01(cx / Math.max(1, width)),
    focusY: clamp01(cy / Math.max(1, height)),
  };
}

export type DetectFocusOptions = {
  src: string;
  startSeconds: number;
  endSeconds: number;
  /** How many frames to sample across the clip. Default 5. */
  sampleCount?: number;
  signal?: AbortSignal;
};

/**
 * Analyze a local video URL and return the best speaker focus point for cropping.
 */
export async function detectSpeakerFocus({
  src,
  startSeconds,
  endSeconds,
  sampleCount = 5,
  signal,
}: DetectFocusOptions): Promise<FocusPoint> {
  if (!src) return { ...DEFAULT_FOCUS };

  const start = Math.max(0, Number(startSeconds) || 0);
  const end = Math.max(start + 0.3, Number(endSeconds) || start + 1);
  const duration = end - start;

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.src = src;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    video.src = "";
    return { ...DEFAULT_FOCUS };
  }

  try {
    if (video.readyState < 1) {
      await waitForEvent(video, "loadedmetadata", 10000);
    }
    if (signal?.aborted) return { ...DEFAULT_FOCUS };

    // Cap analysis resolution for speed.
    const maxW = 480;
    const vw = video.videoWidth || maxW;
    const vh = video.videoHeight || Math.round(maxW * 0.56);
    const scale = Math.min(1, maxW / Math.max(1, vw));
    canvas.width = Math.max(32, Math.round(vw * scale));
    canvas.height = Math.max(32, Math.round(vh * scale));

    const detector = createDetector();
    const samples = Math.max(3, Math.min(8, Math.floor(sampleCount) || 5));
    const points: Array<{ focusX: number; focusY: number; weight: number; source: FocusPoint["source"] }> = [];

    for (let i = 0; i < samples; i += 1) {
      if (signal?.aborted) break;

      // Sample across the clip, avoiding the very first/last frame (often a cut or reaction).
      const t =
        samples === 1
          ? start + duration * 0.4
          : start + duration * (0.12 + (i / (samples - 1)) * 0.76);

      try {
        await seekVideo(video, t);
      } catch {
        continue;
      }

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      let box: DetectedBox | null = null;
      let source: FocusPoint["source"] = "center";

      if (detector) {
        const faces = await detectFacesWithApi(detector, canvas);
        box = pickBestBox(faces);
        if (box) source = "face-detector";
      }

      if (!box) {
        box = detectSkinToneFocus(canvas, ctx);
        if (box) source = "skin-tone";
      }

      if (!box) continue;

      const focus = boxToFocus(box, canvas.width, canvas.height);
      // Weight later samples slightly less; early-mid clip usually holds the speaker.
      const weight = box.score * (1.1 - i * 0.05);
      points.push({ ...focus, weight, source });
    }

    if (points.length === 0) {
      return { ...DEFAULT_FOCUS };
    }

    let sumW = 0;
    let sumX = 0;
    let sumY = 0;
    let faceHits = 0;
    let skinHits = 0;

    for (const point of points) {
      sumW += point.weight;
      sumX += point.focusX * point.weight;
      sumY += point.focusY * point.weight;
      if (point.source === "face-detector") faceHits += 1;
      if (point.source === "skin-tone") skinHits += 1;
    }

    return {
      focusX: clamp01(sumX / Math.max(sumW, 1e-6)),
      focusY: clamp01(sumY / Math.max(sumW, 1e-6)),
      source: faceHits > 0 ? "face-detector" : skinHits > 0 ? "skin-tone" : "center",
      samples: points.length,
    };
  } catch {
    return { ...DEFAULT_FOCUS };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}

/** CSS object-position string from a normalized focus point. */
export function focusToObjectPosition(focusX = 0.5, focusY = 0.5): string {
  return `${(clamp01(focusX) * 100).toFixed(1)}% ${(clamp01(focusY) * 100).toFixed(1)}%`;
}
