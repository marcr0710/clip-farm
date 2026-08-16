/**
 * Detect speaker faces across a local video clip and return a time-varying
 * focus track so the crop can follow whoever is talking — not one locked point.
 *
 * Strategy:
 *  1. Sample frames densely across the clip window
 *  2. Prefer the Chromium FaceDetector API when available (fast, no deps)
 *  3. Fall back to a skin-tone heatmap so Safari/Firefox still get a useful lock
 *  4. Track faces across samples and pick the active speaker per beat
 *     (size + motion, with hysteresis so the crop doesn't flicker)
 *  5. Emit smoothed keyframes the preview and ffmpeg crop can interpolate
 */

export type FocusPoint = {
  focusX: number;
  focusY: number;
  /** How the focus was chosen. */
  source: "face-detector" | "skin-tone" | "center";
  /** Number of frames that contributed a detection. */
  samples: number;
};

/** One focus sample at an absolute source-video timestamp (seconds). */
export type FocusKeyframe = {
  time: number;
  focusX: number;
  focusY: number;
};

/**
 * Time-varying speaker focus for a clip. Preview + export interpolate between
 * keyframes so the crop can pan when the active speaker changes.
 */
export type FocusTrack = {
  keyframes: FocusKeyframe[];
  /** Representative static focus (for thumbnails / fallback). */
  focusX: number;
  focusY: number;
  source: FocusPoint["source"];
  samples: number;
  /** Distinct speaker locks detected across the clip (approx). */
  switches: number;
};

const DEFAULT_TRACK: FocusTrack = {
  keyframes: [
    { time: 0, focusX: 0.5, focusY: 0.5 },
  ],
  focusX: 0.5,
  focusY: 0.5,
  source: "center",
  samples: 0,
  switches: 0,
};

type DetectedBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
};

type FaceSample = {
  cx: number;
  cy: number;
  focusX: number;
  focusY: number;
  area: number;
  width: number;
  height: number;
  score: number;
};

type FrameSample = {
  time: number;
  faces: FaceSample[];
  source: FocusPoint["source"];
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
    return new window.FaceDetector({ fastMode: true, maxDetectedFaces: 6 });
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
 * Returns multiple local maxima so multi-person shots can still switch.
 */
function detectSkinToneFaces(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): DetectedBox[] {
  const width = canvas.width;
  const height = canvas.height;
  if (width < 8 || height < 8) return [];

  let image: ImageData;
  try {
    image = ctx.getImageData(0, 0, width, height);
  } catch {
    return [];
  }

  const data = image.data;
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

  const threshold = (width * height) / (cols * rows) / 90;
  const peaks: DetectedBox[] = [];
  const taken = new Set<number>();

  // Greedy local-maxima extraction for up to 3 subjects.
  for (let peak = 0; peak < 3; peak += 1) {
    let best = 0;
    let bestIndex = -1;
    for (let i = 0; i < heat.length; i += 1) {
      if (taken.has(i)) continue;
      if (heat[i] > best) {
        best = heat[i];
        bestIndex = i;
      }
    }
    if (bestIndex < 0 || best < threshold) break;

    const col = bestIndex % cols;
    const row = Math.floor(bestIndex / cols);
    // Suppress a neighborhood so the next peak is a different person.
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const c = col + dx;
        const r = row + dy;
        if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
        taken.add(r * cols + c);
      }
    }

    const expandX = cellW * 1.6;
    const expandY = cellH * 2.2;
    const cx = (col + 0.5) * cellW;
    const cy = (row + 0.5) * cellH;

    peaks.push({
      x: Math.max(0, cx - expandX / 2),
      y: Math.max(0, cy - expandY / 2),
      width: Math.min(width, expandX),
      height: Math.min(height, expandY),
      score: best,
    });
  }

  return peaks;
}

function boxToFaceSample(box: DetectedBox, width: number, height: number): FaceSample {
  // Bias a touch above the geometric center of the face box so eyes/forehead
  // sit comfortably in the upper third of a 9:16 frame.
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height * 0.42;
  const area = Math.max(1, box.width * box.height);
  return {
    cx,
    cy,
    focusX: clamp01(cx / Math.max(1, width)),
    focusY: clamp01(cy / Math.max(1, height)),
    area,
    width: box.width,
    height: box.height,
    score: box.score,
  };
}

function distanceNorm(a: Pick<FaceSample, "focusX" | "focusY">, b: Pick<FaceSample, "focusX" | "focusY">): number {
  const dx = a.focusX - b.focusX;
  const dy = a.focusY - b.focusY;
  return Math.hypot(dx, dy);
}

/**
 * Pick the active speaker at each sample, tracking identities across time so
 * the crop can follow turn-taking instead of averaging everyone together.
 */
function buildSpeakerKeyframes(frames: FrameSample[]): {
  keyframes: FocusKeyframe[];
  switches: number;
  representative: { focusX: number; focusY: number };
} {
  if (frames.length === 0) {
    return {
      keyframes: [{ time: 0, focusX: 0.5, focusY: 0.5 }],
      switches: 0,
      representative: { focusX: 0.5, focusY: 0.5 },
    };
  }

  type Track = {
    id: number;
    focusX: number;
    focusY: number;
    area: number;
    lastTime: number;
    motion: number;
  };

  const tracks: Track[] = [];
  let nextId = 1;
  const chosen: FocusKeyframe[] = [];
  let prevTrackId: number | null = null;
  let switches = 0;

  for (const frame of frames) {
    if (frame.faces.length === 0) {
      // Hold the previous lock through brief detection gaps.
      if (chosen.length > 0) {
        chosen.push({
          time: frame.time,
          focusX: chosen[chosen.length - 1].focusX,
          focusY: chosen[chosen.length - 1].focusY,
        });
      }
      continue;
    }

    const unmatched = new Set(tracks.map((_, idx) => idx));
    const assignments: Array<{ face: FaceSample; trackIdx: number | null; dist: number }> = [];

    // Greedy match faces → existing tracks by normalized center distance.
    const pairs: Array<{ faceIdx: number; trackIdx: number; dist: number }> = [];
    frame.faces.forEach((face, faceIdx) => {
      tracks.forEach((track, trackIdx) => {
        pairs.push({
          faceIdx,
          trackIdx,
          dist: distanceNorm(face, track),
        });
      });
    });
    pairs.sort((a, b) => a.dist - b.dist);

    const usedFaces = new Set<number>();
    const usedTracks = new Set<number>();
    const matchByFace = new Map<number, number>();

    for (const pair of pairs) {
      if (pair.dist > 0.18) break;
      if (usedFaces.has(pair.faceIdx) || usedTracks.has(pair.trackIdx)) continue;
      usedFaces.add(pair.faceIdx);
      usedTracks.add(pair.trackIdx);
      matchByFace.set(pair.faceIdx, pair.trackIdx);
      unmatched.delete(pair.trackIdx);
    }

    frame.faces.forEach((face, faceIdx) => {
      const trackIdx = matchByFace.has(faceIdx) ? matchByFace.get(faceIdx)! : null;
      assignments.push({
        face,
        trackIdx,
        dist: trackIdx === null ? 1 : distanceNorm(face, tracks[trackIdx]),
      });
    });

    // Update matched tracks / spawn new ones.
    for (const assignment of assignments) {
      if (assignment.trackIdx === null) {
        tracks.push({
          id: nextId++,
          focusX: assignment.face.focusX,
          focusY: assignment.face.focusY,
          area: assignment.face.area,
          lastTime: frame.time,
          motion: 0,
        });
        assignment.trackIdx = tracks.length - 1;
      } else {
        const track = tracks[assignment.trackIdx];
        const dt = Math.max(0.001, frame.time - track.lastTime);
        const jump = distanceNorm(assignment.face, track);
        // Motion is a soft speaker cue (nodding, gesturing, mouth movement proxy).
        track.motion = track.motion * 0.55 + (jump / dt) * 0.45;
        track.focusX = track.focusX * 0.35 + assignment.face.focusX * 0.65;
        track.focusY = track.focusY * 0.35 + assignment.face.focusY * 0.65;
        track.area = track.area * 0.4 + assignment.face.area * 0.6;
        track.lastTime = frame.time;
      }
    }

    // Drop stale tracks that disappeared for a while.
    for (let i = tracks.length - 1; i >= 0; i -= 1) {
      if (frame.time - tracks[i].lastTime > 1.8) {
        tracks.splice(i, 1);
        // Fix assignment indices after splice — recompute chosen via ids below.
      }
    }

    // Score active speaker candidates among tracks updated this frame.
    const live = tracks.filter((track) => Math.abs(track.lastTime - frame.time) < 0.001);
    if (live.length === 0) continue;

    const maxArea = Math.max(...live.map((t) => t.area), 1);
    const maxMotion = Math.max(...live.map((t) => t.motion), 0.001);

    const scored = live.map((track) => {
      const sizeScore = track.area / maxArea;
      const motionScore = Math.min(1, track.motion / maxMotion);
      // Center bias keeps us from locking onto tiny corner faces.
      const centerBias =
        1 - Math.min(1, Math.hypot(track.focusX - 0.5, track.focusY - 0.42) * 1.25);
      let score = sizeScore * 0.62 + motionScore * 0.28 + centerBias * 0.1;
      // Hysteresis: stick with the current speaker unless someone else is clearly on.
      if (prevTrackId !== null && track.id === prevTrackId) {
        score *= 1.28;
      }
      return { track, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const winner = scored[0].track;

    if (prevTrackId !== null && winner.id !== prevTrackId) {
      // Only count a switch when the new speaker beats the old by a real margin.
      const prev = scored.find((s) => s.track.id === prevTrackId);
      if (!prev || scored[0].score > prev.score * 1.08) {
        switches += 1;
        prevTrackId = winner.id;
      } else {
        // Keep previous speaker — soft hold.
        const held = prev.track;
        chosen.push({
          time: frame.time,
          focusX: clamp01(held.focusX),
          focusY: clamp01(held.focusY),
        });
        continue;
      }
    } else {
      prevTrackId = winner.id;
    }

    chosen.push({
      time: frame.time,
      focusX: clamp01(winner.focusX),
      focusY: clamp01(winner.focusY),
    });
  }

  if (chosen.length === 0) {
    return {
      keyframes: [{ time: frames[0].time, focusX: 0.5, focusY: 0.5 }],
      switches: 0,
      representative: { focusX: 0.5, focusY: 0.5 },
    };
  }

  // Temporal smooth + collapse nearly-identical neighbors so ffmpeg exprs stay small.
  const smoothed: FocusKeyframe[] = [];
  let accX = chosen[0].focusX;
  let accY = chosen[0].focusY;
  for (let i = 0; i < chosen.length; i += 1) {
    const point = chosen[i];
    // Faster follow when the jump is large (speaker change); stickier otherwise.
    const jump = distanceNorm(point, { focusX: accX, focusY: accY });
    const alpha = jump > 0.12 ? 0.78 : 0.42;
    accX = accX * (1 - alpha) + point.focusX * alpha;
    accY = accY * (1 - alpha) + point.focusY * alpha;
    const next = {
      time: point.time,
      focusX: clamp01(accX),
      focusY: clamp01(accY),
    };

    const prev = smoothed[smoothed.length - 1];
    if (
      prev &&
      Math.abs(prev.focusX - next.focusX) < 0.018 &&
      Math.abs(prev.focusY - next.focusY) < 0.018
    ) {
      // Extend the held point in time instead of adding noise keyframes.
      prev.time = next.time;
      continue;
    }
    smoothed.push(next);
  }

  // Guarantee the track covers the first detection beat (export interpolates out).
  if (smoothed.length === 1) {
    // Duplicate endpoint so consumers always have a segment to lerp.
    smoothed.push({ ...smoothed[0], time: smoothed[0].time + 0.01 });
  }

  // Representative focus: median of keyframes (stable thumbnail lock).
  const xs = [...smoothed.map((k) => k.focusX)].sort((a, b) => a - b);
  const ys = [...smoothed.map((k) => k.focusY)].sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);

  return {
    keyframes: smoothed,
    switches,
    representative: {
      focusX: xs[mid],
      focusY: ys[mid],
    },
  };
}

export type DetectFocusOptions = {
  src: string;
  startSeconds: number;
  endSeconds: number;
  /** How many frames to sample across the clip. Default scales with duration. */
  sampleCount?: number;
  signal?: AbortSignal;
};

function sampleTimes(start: number, end: number, sampleCount: number): number[] {
  const duration = Math.max(0.3, end - start);
  const samples = Math.max(3, sampleCount);
  if (samples === 1) return [start + duration * 0.4];

  const times: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    // Stay off the exact cut points; sample the speaking body of the clip.
    const u = 0.06 + (i / (samples - 1)) * 0.88;
    times.push(start + duration * u);
  }
  return times;
}

function defaultSampleCount(duration: number): number {
  // ~2 Hz for short clips, capped so detect stays snappy on long ones.
  if (duration <= 8) return Math.max(6, Math.round(duration * 2));
  if (duration <= 20) return Math.max(12, Math.round(duration * 1.4));
  return Math.min(28, Math.max(16, Math.round(duration * 1.1)));
}

/**
 * Analyze a local video URL and return a time-varying speaker focus track.
 * The crop can pan between people as the active speaker changes.
 */
export async function detectSpeakerFocusTrack({
  src,
  startSeconds,
  endSeconds,
  sampleCount,
  signal,
}: DetectFocusOptions): Promise<FocusTrack> {
  if (!src) return { ...DEFAULT_TRACK, keyframes: [{ time: Math.max(0, startSeconds || 0), focusX: 0.5, focusY: 0.5 }] };

  const start = Math.max(0, Number(startSeconds) || 0);
  const end = Math.max(start + 0.3, Number(endSeconds) || start + 1);
  const duration = end - start;
  const count = Math.max(3, Math.min(28, Math.floor(sampleCount ?? defaultSampleCount(duration))));

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
    return {
      ...DEFAULT_TRACK,
      keyframes: [
        { time: start, focusX: 0.5, focusY: 0.5 },
        { time: end, focusX: 0.5, focusY: 0.5 },
      ],
    };
  }

  try {
    if (video.readyState < 1) {
      await waitForEvent(video, "loadedmetadata", 10000);
    }
    if (signal?.aborted) {
      return {
        ...DEFAULT_TRACK,
        keyframes: [
          { time: start, focusX: 0.5, focusY: 0.5 },
          { time: end, focusX: 0.5, focusY: 0.5 },
        ],
      };
    }

    // Cap analysis resolution for speed.
    const maxW = 480;
    const vw = video.videoWidth || maxW;
    const vh = video.videoHeight || Math.round(maxW * 0.56);
    const scale = Math.min(1, maxW / Math.max(1, vw));
    canvas.width = Math.max(32, Math.round(vw * scale));
    canvas.height = Math.max(32, Math.round(vh * scale));

    const detector = createDetector();
    const times = sampleTimes(start, end, count);
    const frames: FrameSample[] = [];
    let faceHits = 0;
    let skinHits = 0;

    for (const t of times) {
      if (signal?.aborted) break;

      try {
        await seekVideo(video, t);
      } catch {
        continue;
      }

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      let boxes: DetectedBox[] = [];
      let source: FocusPoint["source"] = "center";

      if (detector) {
        boxes = await detectFacesWithApi(detector, canvas);
        if (boxes.length > 0) {
          source = "face-detector";
          faceHits += 1;
        }
      }

      if (boxes.length === 0) {
        boxes = detectSkinToneFaces(canvas, ctx);
        if (boxes.length > 0) {
          source = "skin-tone";
          skinHits += 1;
        }
      }

      const faces = boxes
        .map((box) => boxToFaceSample(box, canvas.width, canvas.height))
        .sort((a, b) => b.score - a.score)
        .slice(0, 4);

      frames.push({ time: t, faces, source });
    }

    if (signal?.aborted) {
      return {
        ...DEFAULT_TRACK,
        keyframes: [
          { time: start, focusX: 0.5, focusY: 0.5 },
          { time: end, focusX: 0.5, focusY: 0.5 },
        ],
      };
    }

    const usable = frames.filter((frame) => frame.faces.length > 0);
    if (usable.length === 0) {
      return {
        ...DEFAULT_TRACK,
        keyframes: [
          { time: start, focusX: 0.5, focusY: 0.5 },
          { time: end, focusX: 0.5, focusY: 0.5 },
        ],
      };
    }

    const built = buildSpeakerKeyframes(usable);

    // Anchor keyframes to the full trim window so export covers the whole clip.
    const keyframes = [...built.keyframes];
    if (keyframes[0].time > start + 0.05) {
      keyframes.unshift({
        time: start,
        focusX: keyframes[0].focusX,
        focusY: keyframes[0].focusY,
      });
    } else {
      keyframes[0] = { ...keyframes[0], time: start };
    }
    const last = keyframes[keyframes.length - 1];
    if (last.time < end - 0.05) {
      keyframes.push({
        time: end,
        focusX: last.focusX,
        focusY: last.focusY,
      });
    } else {
      keyframes[keyframes.length - 1] = { ...last, time: end };
    }

    return {
      keyframes,
      focusX: built.representative.focusX,
      focusY: built.representative.focusY,
      source: faceHits > 0 ? "face-detector" : skinHits > 0 ? "skin-tone" : "center",
      samples: usable.length,
      switches: built.switches,
    };
  } catch {
    return {
      ...DEFAULT_TRACK,
      keyframes: [
        { time: start, focusX: 0.5, focusY: 0.5 },
        { time: end, focusX: 0.5, focusY: 0.5 },
      ],
    };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}

/**
 * Analyze a local video URL and return a single best speaker focus point.
 * Prefer `detectSpeakerFocusTrack` when the crop should follow turn-taking.
 */
export async function detectSpeakerFocus(options: DetectFocusOptions): Promise<FocusPoint> {
  const track = await detectSpeakerFocusTrack(options);
  return {
    focusX: track.focusX,
    focusY: track.focusY,
    source: track.source,
    samples: track.samples,
  };
}

/** Linear interpolation across absolute-time keyframes. */
export function interpolateFocus(
  keyframes: FocusKeyframe[] | null | undefined,
  time: number,
  fallbackX = 0.5,
  fallbackY = 0.5,
): { focusX: number; focusY: number } {
  if (!keyframes || keyframes.length === 0) {
    return { focusX: clamp01(fallbackX), focusY: clamp01(fallbackY) };
  }

  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  if (sorted.length === 1 || time <= sorted[0].time) {
    return { focusX: clamp01(sorted[0].focusX), focusY: clamp01(sorted[0].focusY) };
  }
  const last = sorted[sorted.length - 1];
  if (time >= last.time) {
    return { focusX: clamp01(last.focusX), focusY: clamp01(last.focusY) };
  }

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (time < a.time || time > b.time) continue;
    const span = Math.max(1e-6, b.time - a.time);
    const u = (time - a.time) / span;
    return {
      focusX: clamp01(a.focusX + (b.focusX - a.focusX) * u),
      focusY: clamp01(a.focusY + (b.focusY - a.focusY) * u),
    };
  }

  return { focusX: clamp01(fallbackX), focusY: clamp01(fallbackY) };
}

/** True when the track actually pans (not a single static lock). */
export function focusTrackIsDynamic(keyframes: FocusKeyframe[] | null | undefined): boolean {
  if (!keyframes || keyframes.length < 2) return false;
  const first = keyframes[0];
  return keyframes.some(
    (frame) =>
      Math.abs(frame.focusX - first.focusX) > 0.03 || Math.abs(frame.focusY - first.focusY) > 0.03,
  );
}

/** CSS object-position string from a normalized focus point. */
export function focusToObjectPosition(focusX = 0.5, focusY = 0.5): string {
  return `${(clamp01(focusX) * 100).toFixed(1)}% ${(clamp01(focusY) * 100).toFixed(1)}%`;
}

/**
 * Build an ffmpeg expression that linearly interpolates a 0–1 focus channel
 * across keyframes. Times must already be relative to the filtered timeline
 * origin (usually 0 at the clip start after `-ss`).
 */
export function buildFocusExpression(
  keyframes: FocusKeyframe[] | null | undefined,
  channel: "focusX" | "focusY",
  fallback = 0.5,
): string {
  const fb = clamp01(fallback).toFixed(4);
  if (!keyframes || keyframes.length === 0) return fb;

  const sorted = [...keyframes]
    .map((frame) => ({
      t: Math.max(0, Number(frame.time) || 0),
      v: clamp01(frame[channel]),
    }))
    .sort((a, b) => a.t - b.t);

  if (sorted.length === 1) return sorted[0].v.toFixed(4);

  // Nested if(lt(t,t1), lerp, if(...)) — ffmpeg expression syntax.
  const build = (index: number): string => {
    if (index >= sorted.length - 1) {
      return sorted[sorted.length - 1].v.toFixed(4);
    }
    const a = sorted[index];
    const b = sorted[index + 1];
    const span = Math.max(1e-6, b.t - a.t);
    const lerp = `${a.v.toFixed(4)}+(${b.v.toFixed(4)}-${a.v.toFixed(4)})*(t-${a.t.toFixed(3)})/${span.toFixed(3)}`;
    if (index === sorted.length - 2) {
      // Final segment: before a → hold a; between a/b → lerp; after b → hold b
      return `if(lt(t\\,${a.t.toFixed(3)})\\,${a.v.toFixed(4)}\\,if(lt(t\\,${b.t.toFixed(3)})\\,${lerp}\\,${b.v.toFixed(4)}))`;
    }
    return `if(lt(t\\,${b.t.toFixed(3)})\\,if(lt(t\\,${a.t.toFixed(3)})\\,${a.v.toFixed(4)}\\,${lerp})\\,${build(index + 1)})`;
  };

  return build(0);
}

/**
 * Convert absolute-time keyframes into clip-relative times for ffmpeg filters
 * that run after an input seek (`t = 0` at clip start).
 */
export function toRelativeFocusKeyframes(
  keyframes: FocusKeyframe[] | null | undefined,
  clipStartSeconds: number,
): FocusKeyframe[] {
  if (!keyframes || keyframes.length === 0) return [];
  const start = Math.max(0, Number(clipStartSeconds) || 0);
  return keyframes.map((frame) => ({
    time: Math.max(0, frame.time - start),
    focusX: clamp01(frame.focusX),
    focusY: clamp01(frame.focusY),
  }));
}
