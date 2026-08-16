import ytdl from "@distube/ytdl-core";
import ffmpeg from "fluent-ffmpeg";
// @ts-expect-error - ffmpeg-static has no type declarations, it just exports a binary path string.
import ffmpegPath from "ffmpeg-static";
import { createWriteStream } from "fs";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath as unknown as string);
}

// Hard safety cap so a bad start/end pair (or a runaway clip) can never turn
// into a multi-minute download + encode inside a serverless function.
const MAX_CLIP_SECONDS = 120;

export type RenderAspect = "9:16" | "1:1" | "16:9";

/** One focus sample at an absolute source-video timestamp (seconds). */
export type FocusKeyframe = {
  time: number;
  focusX: number;
  focusY: number;
};

export interface CropFocus {
  /** 0 = left edge, 1 = right edge. Defaults to 0.5 (center). */
  focusX?: number;
  /** 0 = top edge, 1 = bottom edge. Defaults to 0.5 (center). */
  focusY?: number;
  /** Optional time-varying speaker track (absolute source times). */
  focusKeyframes?: FocusKeyframe[] | null;
  /** Absolute clip start used to make keyframe times filter-relative. */
  clipStartSeconds?: number;
}

export interface RenderClipParams {
  url: string;
  startSeconds: number;
  endSeconds: number;
  /** Output framing. Defaults to YouTube Shorts 9:16. */
  aspect?: RenderAspect;
  /** Where the crop window should stay locked. Defaults to center. */
  focusX?: number;
  focusY?: number;
  /** Time-varying speaker track (absolute source times). */
  focusKeyframes?: FocusKeyframe[] | null;
}

export interface RenderClipResult {
  buffer: Buffer;
  filename: string;
}

function clamp01(value: number, fallback = 0.5): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function toRelativeFocusKeyframes(
  keyframes: FocusKeyframe[] | null | undefined,
  clipStartSeconds: number,
): FocusKeyframe[] {
  if (!keyframes || keyframes.length === 0) return [];
  const start = Math.max(0, Number(clipStartSeconds) || 0);
  return keyframes.map((frame) => ({
    time: Math.max(0, Number(frame.time) - start || 0),
    focusX: clamp01(frame.focusX),
    focusY: clamp01(frame.focusY),
  }));
}

function isDynamicTrack(keyframes: FocusKeyframe[] | null | undefined): boolean {
  if (!keyframes || keyframes.length < 2) return false;
  const first = keyframes[0];
  return keyframes.some(
    (frame) =>
      Math.abs(frame.focusX - first.focusX) > 0.03 || Math.abs(frame.focusY - first.focusY) > 0.03,
  );
}

/**
 * Build an ffmpeg expression that linearly interpolates a 0–1 focus channel
 * across clip-relative keyframes.
 */
function buildFocusExpression(
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

  const build = (index: number): string => {
    if (index >= sorted.length - 1) {
      return sorted[sorted.length - 1].v.toFixed(4);
    }
    const a = sorted[index];
    const b = sorted[index + 1];
    const span = Math.max(1e-6, b.t - a.t);
    const lerp = `${a.v.toFixed(4)}+(${b.v.toFixed(4)}-${a.v.toFixed(4)})*(t-${a.t.toFixed(3)})/${span.toFixed(3)}`;
    if (index === sorted.length - 2) {
      return `if(lt(t\\,${a.t.toFixed(3)})\\,${a.v.toFixed(4)}\\,if(lt(t\\,${b.t.toFixed(3)})\\,${lerp}\\,${b.v.toFixed(4)}))`;
    }
    return `if(lt(t\\,${b.t.toFixed(3)})\\,if(lt(t\\,${a.t.toFixed(3)})\\,${a.v.toFixed(4)}\\,${lerp})\\,${build(index + 1)})`;
  };

  return build(0);
}

/**
 * Scale-to-cover + crop filter for Shorts / Reels / square / landscape.
 * Static focus locks the window; optional keyframes animate it so the crop
 * can follow speaker changes over the clip.
 */
export function aspectVideoFilter(
  aspect: RenderAspect = "9:16",
  focus: CropFocus = {},
): string {
  const fallbackX = clamp01(focus.focusX ?? 0.5);
  const fallbackY = clamp01(focus.focusY ?? 0.5);
  const relative = toRelativeFocusKeyframes(
    focus.focusKeyframes,
    focus.clipStartSeconds ?? 0,
  );

  let x: string;
  let y: string;

  if (isDynamicTrack(relative)) {
    const fxExpr = buildFocusExpression(relative, "focusX", fallbackX);
    const fyExpr = buildFocusExpression(relative, "focusY", fallbackY);
    x = `(iw-ow)*(${fxExpr})`;
    y = `(ih-oh)*(${fyExpr})`;
  } else {
    const fx = relative.length > 0 ? clamp01(relative[0].focusX) : fallbackX;
    const fy = relative.length > 0 ? clamp01(relative[0].focusY) : fallbackY;
    x = `(iw-ow)*${fx.toFixed(4)}`;
    y = `(ih-oh)*${fy.toFixed(4)}`;
  }

  if (aspect === "1:1") {
    return `scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080:${x}:${y},setsar=1`;
  }
  if (aspect === "16:9") {
    return `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080:${x}:${y},setsar=1`;
  }
  return `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:${x}:${y},setsar=1`;
}

function getVideoId(url: string): string | null {
  try {
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    const parsed = new URL(normalized);

    if (parsed.hostname.includes("youtu.be")) {
      return parsed.pathname.replace("/", "").trim() || null;
    }

    if (parsed.hostname.includes("youtube.com")) {
      const idParam = parsed.searchParams.get("v");
      if (idParam) return idParam;
      const shortsMatch = parsed.pathname.match(/\/shorts\/([^/?]+)/);
      if (shortsMatch?.[1]) return shortsMatch[1];
      const embedMatch = parsed.pathname.match(/\/embed\/([^/?]+)/);
      if (embedMatch?.[1]) return embedMatch[1];
    }
  } catch {
    return null;
  }

  return null;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "clip"
  );
}

/**
 * Downloads the source YouTube video (progressive mp4, audio+video in one
 * stream) and cuts the requested [start, end) range with ffmpeg, re-encoding
 * and cropping to the target short-form aspect (default 9:16).
 */
export async function renderClip({
  url,
  startSeconds,
  endSeconds,
  aspect = "9:16",
  focusX = 0.5,
  focusY = 0.5,
  focusKeyframes = null,
}: RenderClipParams): Promise<RenderClipResult> {
  const videoId = getVideoId(url);
  if (!videoId) {
    throw new Error("Could not resolve a YouTube video ID from that URL.");
  }
  if (!ytdl.validateID(videoId)) {
    throw new Error("That does not look like a valid YouTube video ID.");
  }

  const start = Math.max(0, Number(startSeconds) || 0);
  const requestedEnd = Math.max(start + 0.25, Number(endSeconds) || start + 1);
  const duration = Math.min(requestedEnd - start, MAX_CLIP_SECONDS);
  const vf = aspectVideoFilter(aspect, {
    focusX,
    focusY,
    focusKeyframes,
    clipStartSeconds: start,
  });

  const BOT_CHECK_MESSAGE =
    "YouTube is blocking video downloads from this server (it shows YouTube's own \"Sign in to confirm you're not a bot\" check). This is a network-level block YouTube applies to datacenter/cloud IP ranges — it isn't something this app's code can fix. Use the clip brief export instead, or try again later.";

  let info: Awaited<ReturnType<typeof ytdl.getInfo>>;
  try {
    info = await ytdl.getInfo(videoId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/sign in to confirm|not a bot|status code:\s*(403|429)/i.test(message)) {
      throw new Error(BOT_CHECK_MESSAGE);
    }
    throw new Error(`Could not read video info: ${message}`);
  }

  const progressiveMp4 = info.formats.filter(
    (format) => format.hasVideo && format.hasAudio && format.container === "mp4",
  );
  const format =
    progressiveMp4.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0] ??
    ytdl.chooseFormat(info.formats, { filter: "audioandvideo" });

  if (!format) {
    throw new Error("No downloadable audio+video format was found for this video.");
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "clipcraft-"));
  const sourcePath = path.join(workDir, "source.mp4");
  const outputPath = path.join(workDir, "clip.mp4");

  try {
    await new Promise<void>((resolve, reject) => {
      const stream = ytdl.downloadFromInfo(info, { format });
      const writeStream = createWriteStream(sourcePath);
      stream.on("error", (err: Error & { statusCode?: number }) => {
        const message = err?.message ?? "";
        if (
          err?.statusCode === 403 ||
          err?.statusCode === 429 ||
          /status code:\s*(403|429)/i.test(message) ||
          /sign in to confirm|not a bot/i.test(message)
        ) {
          reject(new Error(BOT_CHECK_MESSAGE));
          return;
        }
        reject(err);
      });
      writeStream.on("error", reject);
      writeStream.on("finish", () => resolve());
      stream.pipe(writeStream);
    });

    await new Promise<void>((resolve, reject) => {
      ffmpeg(sourcePath)
        .setStartTime(start)
        .setDuration(duration)
        .videoFilters(vf)
        .outputOptions([
          "-movflags",
          "+faststart",
          "-preset",
          "veryfast",
          "-crf",
          "23",
          "-pix_fmt",
          "yuv420p",
        ])
        .videoCodec("libx264")
        .audioCodec("aac")
        .audioBitrate("128k")
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });

    const buffer = await readFile(outputPath);
    const safeTitle = slugify(info.videoDetails?.title ?? "clip");
    const startLabel = Math.floor(start);
    const endLabel = Math.floor(start + duration);
    return {
      buffer,
      filename: `${safeTitle}-${startLabel}s-${endLabel}s-${aspect.replace(":", "x")}.mp4`,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
