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

export type ClientTrimOptions = {
  file: File;
  startSeconds: number;
  endSeconds: number;
  onStatus?: (message: string) => void;
  onProgress?: (ratio: number) => void;
};

/**
 * Trim a clip from a local video file entirely in the browser.
 * The full file never leaves the device — no server upload, no 60 MB body cap.
 */
export async function trimVideoInBrowser({
  file,
  startSeconds,
  endSeconds,
  onStatus,
  onProgress,
}: ClientTrimOptions): Promise<Blob> {
  const start = Math.max(0, Math.floor(Number(startSeconds) || 0));
  const requestedEnd = Math.max(start + 1, Math.ceil(Number(endSeconds) || start + 1));
  const duration = Math.min(requestedEnd - start, MAX_CLIP_SECONDS);

  onStatus?.("Loading the local video engine (first run downloads ~25 MB)…");
  const ffmpeg = await getFFmpeg(onProgress);

  const ext = extensionForMime(file.type || "", file.name.toLowerCase());
  const inputName = `input.${ext}`;
  const outputName = "clip.mp4";

  try {
    onStatus?.("Reading your video into local memory…");
    await ffmpeg.writeFile(inputName, await fetchFile(file));

    // Fast path: stream-copy the segment (no re-encode). This is much faster
    // on large files and keeps quality identical to the source. Cuts land on
    // the nearest prior keyframe, which is fine for short social clips.
    onStatus?.(`Trimming ${duration}s locally…`);
    let exitCode = await ffmpeg.exec([
      "-ss",
      String(start),
      "-i",
      inputName,
      "-t",
      String(duration),
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "-avoid_negative_ts",
      "make_zero",
      outputName,
    ]);

    // If stream-copy produced nothing useful (odd containers / codecs), fall
    // back to a short re-encode so the user still gets a playable MP4.
    let data = await ffmpeg.readFile(outputName);
    const copyLooksEmpty =
      exitCode !== 0 ||
      (typeof data !== "string" && data.length < 1024);

    if (copyLooksEmpty) {
      try {
        await ffmpeg.deleteFile(outputName);
      } catch {
        // file may not exist
      }

      onStatus?.("Re-encoding the clip for compatibility…");
      exitCode = await ffmpeg.exec([
        "-ss",
        String(start),
        "-i",
        inputName,
        "-t",
        String(duration),
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
        outputName,
      ]);

      if (exitCode !== 0) {
        throw new Error("Local trim failed. Try a different video format (MP4 works best).");
      }
      data = await ffmpeg.readFile(outputName);
    }

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
