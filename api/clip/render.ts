import type { VercelRequest, VercelResponse } from "@vercel/node";
import { renderClip, type RenderAspect } from "../_lib/clip-renderer.js";

// ffmpeg re-encoding a short clip is slower than a typical API route -
// give the function room to finish instead of getting cut off mid-render.
export const config = { maxDuration: 60 };

const ASPECTS = new Set<RenderAspect>(["9:16", "1:1", "16:9"]);

function resolveAspect(value: unknown): RenderAspect {
  if (typeof value === "string" && ASPECTS.has(value as RenderAspect)) {
    return value as RenderAspect;
  }
  return "9:16";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { url, startSeconds, endSeconds, aspect, focusX, focusY } = req.body ?? {};

    if (typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ error: "A YouTube url is required." });
    }

    const start = Number(startSeconds);
    const end = Number(endSeconds);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return res.status(400).json({ error: "Valid startSeconds and endSeconds are required." });
    }

    const fx = Number(focusX);
    const fy = Number(focusY);

    const { buffer, filename } = await renderClip({
      url,
      startSeconds: start,
      endSeconds: end,
      aspect: resolveAspect(aspect),
      focusX: Number.isFinite(fx) ? Math.min(1, Math.max(0, fx)) : 0.5,
      focusY: Number.isFinite(fy) ? Math.min(1, Math.max(0, fy)) : 0.5,
    });

    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": buffer.length,
    });
    res.end(buffer);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Clip rendering failed." });
  }
}
