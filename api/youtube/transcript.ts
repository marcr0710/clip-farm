import type { VercelRequest, VercelResponse } from "@vercel/node";
import ytdl from "@distube/ytdl-core";

// Fetching + parsing captions is quick, but ytdl.getInfo() sometimes has to
// walk YouTube's player response; give it a little more room than a typical
// API route before Vercel kills the function.
export const config = { maxDuration: 30 };

interface TranscriptCue {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// YouTube's timedtext endpoint returns simple <text start="s" dur="s">cue</text>
// XML. No third-party captions library is needed for this shape.
function parseTimedText(xml: string): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  const regex = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    const start = Number(match[1]);
    const dur = Number(match[2]);
    const text = decodeHtmlEntities(match[3]);
    if (!text || !Number.isFinite(start) || !Number.isFinite(dur)) continue;
    cues.push({ startSeconds: start, endSeconds: start + dur, text });
  }
  return cues;
}

// Groups individual (often sub-5-second) caption cues into ~32s windows so
// the AI prompt sees coherent chunks of speech instead of one-line fragments
// — matching the shape of the app's SAMPLE_WINDOWS fallback.
function groupIntoWindows(cues: TranscriptCue[], windowSeconds = 32): TranscriptCue[] {
  if (cues.length === 0) return [];
  const windows: TranscriptCue[] = [];
  let windowStart = cues[0].startSeconds;
  let windowEnd = windowStart;
  let buffer: string[] = [];

  for (const cue of cues) {
    if (cue.startSeconds - windowStart > windowSeconds && buffer.length > 0) {
      windows.push({ startSeconds: windowStart, endSeconds: windowEnd, text: buffer.join(" ") });
      windowStart = cue.startSeconds;
      buffer = [];
    }
    buffer.push(cue.text);
    windowEnd = cue.endSeconds;
  }
  if (buffer.length > 0) {
    windows.push({ startSeconds: windowStart, endSeconds: windowEnd, text: buffer.join(" ") });
  }
  return windows;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { videoId } = req.body ?? {};
    if (typeof videoId !== "string" || !videoId.trim()) {
      return res.status(400).json({ error: "A YouTube videoId is required." });
    }
    if (!ytdl.validateID(videoId)) {
      return res.status(400).json({ error: "That does not look like a valid YouTube video ID." });
    }

    let info: Awaited<ReturnType<typeof ytdl.getInfo>>;
    try {
      info = await ytdl.getInfo(videoId);
    } catch (err) {
      // Same datacenter-IP bot-check that blocks downloads can also block
      // metadata lookups. Report it as a soft "no transcript" case (200,
      // empty windows) so the UI falls back to sample windows instead of
      // surfacing this as a hard error.
      return res.status(200).json({ windows: [], reason: "blocked" });
    }

    const tracks = (info.player_response as { captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } } })
      ?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!tracks || tracks.length === 0) {
      return res.status(200).json({ windows: [], reason: "no-captions" });
    }

    const track =
      tracks.find((t) => t.languageCode?.startsWith("en") && t.kind !== "asr") ??
      tracks.find((t) => t.languageCode?.startsWith("en")) ??
      tracks[0];

    const captionRes = await fetch(track.baseUrl);
    if (!captionRes.ok) {
      return res.status(200).json({ windows: [], reason: "fetch-failed" });
    }

    const xml = await captionRes.text();
    const cues = parseTimedText(xml);
    const windows = groupIntoWindows(cues);

    return res.status(200).json({ windows, reason: windows.length ? "ok" : "empty" });
  } catch (error) {
    return res.status(200).json({
      windows: [],
      reason: "error",
      error: error instanceof Error ? error.message : "Transcript fetch failed.",
    });
  }
}
