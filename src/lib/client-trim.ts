import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

// Single-threaded core — works without COOP/COEP headers, which the
// sandbox preview iframe does not set. Multi-threaded core needs
// SharedArrayBuffer and would fail to load here.
const CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";

const MAX_CLIP_SECONDS = 120;

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

function extensionForMime(mime: string, fileName: string): string {
  if (mime.includes("webm") || fileName.endsWith(".webm")) return "webm";
  if (mime.includes("quicktime") || fileName.endsWith(".mov")) return "mov";
  if (mime.includes("matroska") || fileName.endsWith(".mkv")) return "mkv";
  if (fileName.endsWith(".m4v")) return "m4v";
  return "mp4";
}

async function getFFmpeg(onProgress?: (ratio: number) => void): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) {
    if (onProgress) {
      ffmpegInstance.on("progress", ({ progress }) => onProgress(Math.min(1, Math.max(0, progress))));
    }
    return ffmpegInstance;
  }

  if (!loadPromise) {
    loadPromise = (async () => {
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
      });
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    })().catch((error) => {
      // Allow a later call to retry if the first load failed (e.g. network blip).
      loadPromise = null;
      throw error;
    });
  }

  const ffmpeg = await loadPromise;
  if (onProgress) {
    ffmpeg.on("progress", ({ progress }) => onProgress(Math.min(1, Math.max(0, progress))));
  }
  return ffmpeg;
}

export type ShortsAspect = "9:16" | "1:1" | "16:9";

/** Normalized focus point inside the source frame. 0.5/0.5 = center. */
export type CropFocus = {
  /** 0 = left edge, 1 = right edge */
  focusX?: number;
  /** 0 = top edge, 1 = bottom edge */
  focusY?: number;
};

export type ClientTrimOptions = {
  file: File;
  startSeconds: number;
  endSeconds: number;
  /** Output framing. Defaults to YouTube Shorts 9:16. */
  aspect?: ShortsAspect;
  /** Where the crop window should stay locked. Defaults to center. */
  focusX?: number;
  focusY?: number;
  onStatus?: (message: string) => void;
  onProgress?: (ratio: number) => void;
};

function clamp01(value: number, fallback = 0.5): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/**
 * Scale-to-cover + crop filter for Shorts / Reels / square / landscape.
 * `focusX` / `focusY` (0–1) shift the crop window toward the speaker
 * instead of always taking the geometric center.
 */
export function aspectFilter(
  aspect: ShortsAspect = "9:16",
  focus: CropFocus = {},
): string {
  const fx = clamp01(focus.focusX ?? 0.5);
  const fy = clamp01(focus.focusY ?? 0.5);
  // Keep expression compact for ffmpeg.wasm arg parsing.
  const x = `(iw-ow)*${fx.toFixed(4)}`;
  const y = `(ih-oh)*${fy.toFixed(4)}`;

  if (aspect === "1:1") {
    return `scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080:${x}:${y},setsar=1`;
  }
  if (aspect === "16:9") {
    return `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080:${x}:${y},setsar=1`;
  }
  // YouTube Shorts / Reels default
  return `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:${x}:${y},setsar=1`;
}

/**
 * Trim a clip from a local video file entirely in the browser and re-frame it
 * to the target short-form aspect (default 9:16). The full file never leaves
 * the device — no server upload, no 60 MB body cap.
 */
export async function trimVideoInBrowser({
  file,
  startSeconds,
  endSeconds,
  aspect = "9:16",
  focusX = 0.5,
  focusY = 0.5,
  onStatus,
  onProgress,
}: ClientTrimOptions): Promise<Blob> {
  const start = Math.max(0, Number(startSeconds) || 0);
  const requestedEnd = Math.max(start + 0.25, Number(endSeconds) || start + 1);
  const duration = Math.min(requestedEnd - start, MAX_CLIP_SECONDS);
  const vf = aspectFilter(aspect, { focusX, focusY });

  onStatus?.("Loading the local video engine (first run downloads ~25 MB)…");
  const ffmpeg = await getFFmpeg(onProgress);

  const ext = extensionForMime(file.type || "", file.name.toLowerCase());
  const inputName = `input.${ext}`;
  const outputName = "clip.mp4";

  try {
    onStatus?.("Reading your video into local memory…");
    await ffmpeg.writeFile(inputName, await fetchFile(file));

    // Always re-encode so we can crop/scale to Shorts 9:16 (or the chosen
    // aspect). Stream-copy can't apply a video filter.
    onStatus?.(`Trimming ${duration.toFixed(1)}s and framing to ${aspect}…`);
    const exitCode = await ffmpeg.exec([
      "-ss",
      start.toFixed(3),
      "-i",
      inputName,
      "-t",
      duration.toFixed(3),
      "-vf",
      vf,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "-pix_fmt",
      "yuv420p",
      outputName,
    ]);

    if (exitCode !== 0) {
      throw new Error("Local trim failed. Try a different video format (MP4 works best).");
    }

    const data = await ffmpeg.readFile(outputName);

    if (typeof data === "string") {
      throw new Error("Unexpected text output from the local video engine.");
    }

    // Copy into a fresh ArrayBuffer-backed Uint8Array so BlobPart typing is happy
    // (ffmpeg's FileData can be a SharedArrayBuffer view in some builds).
    const bytes = new Uint8Array(data.byteLength);
    bytes.set(data);

    return new Blob([bytes], { type: "video/mp4" });
  } finally {
    // Best-effort cleanup so repeated trims don't pile up in the virtual FS.
    for (const name of [inputName, outputName]) {
      try {
        await ffmpeg.deleteFile(name);
      } catch {
        // ignore missing files
      }
    }
  }
}
