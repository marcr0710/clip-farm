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

export interface RenderClipParams {
  url: string;
  startSeconds: number;
  endSeconds: number;
}

export interface RenderClipResult {
  buffer: Buffer;
  filename: string;
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
 * so the trim points land exactly where requested. Returns the finished clip
 * as an in-memory buffer, ready to stream back as a file download.
 */
export async function renderClip({ url, startSeconds, endSeconds }: RenderClipParams): Promise<RenderClipResult> {
  const videoId = getVideoId(url);
  if (!videoId) {
    throw new Error("Could not resolve a YouTube video ID from that URL.");
  }
  if (!ytdl.validateID(videoId)) {
    throw new Error("That does not look like a valid YouTube video ID.");
  }

  const start = Math.max(0, Math.floor(startSeconds));
  const requestedEnd = Math.max(start + 1, Math.ceil(endSeconds));
  const duration = Math.min(requestedEnd - start, MAX_CLIP_SECONDS);

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
        .outputOptions(["-movflags", "+faststart", "-preset", "veryfast"])
        .videoCodec("libx264")
        .audioCodec("aac")
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });

    const buffer = await readFile(outputPath);
    const safeTitle = slugify(info.videoDetails?.title ?? "clip");
    return { buffer, filename: `${safeTitle}-${start}s-${start + duration}s.mp4` };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
