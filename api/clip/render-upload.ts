import type { VercelRequest, VercelResponse } from "@vercel/node";
import ffmpeg from "fluent-ffmpeg";
// @ts-expect-error - ffmpeg-static has no type declarations, it just exports a binary path string.
import ffmpegPath from "ffmpeg-static";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath as unknown as string);
}

// ffmpeg re-encoding a short clip is slower than a typical API route -
// give the function room to finish instead of getting cut off mid-render.
export const config = { maxDuration: 60 };

// Hard safety cap so a bad start/end pair (or a runaway clip) can never turn
// into a multi-minute download + encode inside a serverless function.
const MAX_CLIP_SECONDS = 120;

function slugify(value: string): string {
  return (
    (value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "clip"
  );
}

function extensionForMime(mime: string): string {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("quicktime")) return "mov";
  if (mime.includes("matroska")) return "mkv";
  return "mp4";
}

/**
 * Trims [start, end) out of a user-uploaded source video with ffmpeg. Unlike
 * the YouTube-fetch render path, this never talks to YouTube's servers, so
 * it keeps working even when YouTube's bot-check blocks datacenter IPs.
 *
 * The file arrives as a base64 string in the JSON body (not multipart) so
 * this route works unchanged on both the local dev API proxy (which always
 * reads request bodies as JSON) and on Vercel in production.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "clipcraft-upload-"));

  try {
    const { fileBase64, mimeType, startSeconds, endSeconds, title } = req.body ?? {};

    if (typeof fileBase64 !== "string" || !fileBase64.trim()) {
      return res.status(400).json({ error: "No video file data was received." });
    }

    const start = Math.max(0, Math.floor(Number(startSeconds)));
    const requestedEnd = Math.max(start + 1, Math.ceil(Number(endSeconds)));
    if (!Number.isFinite(start) || !Number.isFinite(requestedEnd)) {
      return res.status(400).json({ error: "Valid startSeconds and endSeconds are required." });
    }
    const duration = Math.min(requestedEnd - start, MAX_CLIP_SECONDS);

    let sourceBuffer: Buffer;
    try {
      sourceBuffer = Buffer.from(fileBase64, "base64");
    } catch {
      return res.status(400).json({ error: "The uploaded file data could not be decoded." });
    }
    if (sourceBuffer.length === 0) {
      return res.status(400).json({ error: "The uploaded file was empty." });
    }

    const ext = extensionForMime(typeof mimeType === "string" ? mimeType : "");
    const sourcePath = path.join(workDir, `source.${ext}`);
    const outputPath = path.join(workDir, "clip.mp4");
    await writeFile(sourcePath, sourceBuffer);

    await new Promise<void>((resolve, reject) => {
      ffmpeg(sourcePath)
        .setStartTime(start)
        .setDuration(duration)
        .outputOptions(["-movflags", "+faststart", "-preset", "veryfast"])
        .videoCodec("libx264")
        .audioCodec("aac")
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(new Error(`ffmpeg could not trim that file: ${err.message}`)))
        .run();
    });

    const buffer = await readFile(outputPath);
    const safeTitle = slugify(typeof title === "string" ? title : "clip");

    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="${safeTitle}-${start}s-${start + duration}s.mp4"`,
      "Content-Length": buffer.length,
    });
    res.end(buffer);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Rendering from the uploaded file failed." });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
