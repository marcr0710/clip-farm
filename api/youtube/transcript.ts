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

const SENTENCE_END_RE = /[.!?]["')\]]*$/;
const CLAUSE_END_RE = /[,;:]["')\]]*$/;
// Natural breath / topic break between caption lines.
const PAUSE_BREAK_SECONDS = 0.55;
const TARGET_WINDOW_SECONDS = 28;
const MIN_WINDOW_SECONDS = 10;
const MAX_WINDOW_SECONDS = 48;

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
  const regex = /<text start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    const start = Number(match[1]);
    const dur = match[2] !== undefined ? Number(match[2]) : NaN;
    const text = decodeHtmlEntities(match[3]);
    if (!text || !Number.isFinite(start)) continue;
    const endSeconds = Number.isFinite(dur) && dur > 0 ? start + dur : start + 2;
    cues.push({ startSeconds: start, endSeconds, text });
  }

  // Fill missing ends from the next cue start so boundaries stay continuous.
  for (let i = 0; i < cues.length; i += 1) {
    const next = cues[i + 1];
    if (next && cues[i].endSeconds > next.startSeconds) {
      cues[i].endSeconds = next.startSeconds;
    } else if (next && cues[i].endSeconds <= cues[i].startSeconds) {
      cues[i].endSeconds = next.startSeconds;
    } else if (!next && cues[i].endSeconds <= cues[i].startSeconds) {
      cues[i].endSeconds = cues[i].startSeconds + 2;
    }
  }

  return cues;
}

function endsCompleteThought(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return SENTENCE_END_RE.test(trimmed);
}

function endsSoftBreak(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return SENTENCE_END_RE.test(trimmed) || CLAUSE_END_RE.test(trimmed);
}

/**
 * Groups caption cues into speech windows that prefer natural boundaries:
 * sentence endings, clause endings, and pauses — not a fixed wall-clock cut.
 * This keeps AI prompts and later snap logic from landing mid-sentence.
 */
function groupIntoWindows(cues: TranscriptCue[]): TranscriptCue[] {
  if (cues.length === 0) return [];

  const windows: TranscriptCue[] = [];
  let buffer: TranscriptCue[] = [];
  let windowStart = cues[0].startSeconds;
  let windowEnd = cues[0].endSeconds;

  const flush = () => {
    if (buffer.length === 0) return;
    windows.push({
      startSeconds: windowStart,
      endSeconds: windowEnd,
      text: buffer.map((cue) => cue.text).join(" ").replace(/\s+/g, " ").trim(),
    });
    buffer = [];
  };

  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const next = cues[index + 1];
    const pauseBefore = buffer.length > 0 ? Math.max(0, cue.startSeconds - windowEnd) : 0;

    // Start a new window on a clear pause once we already have enough speech.
    if (
      buffer.length > 0 &&
      pauseBefore >= PAUSE_BREAK_SECONDS &&
      windowEnd - windowStart >= MIN_WINDOW_SECONDS
    ) {
      flush();
      windowStart = cue.startSeconds;
    }

    if (buffer.length === 0) {
      windowStart = cue.startSeconds;
    }

    buffer.push(cue);
    windowEnd = Math.max(windowEnd, cue.endSeconds);

    const span = windowEnd - windowStart;
    const textSoFar = buffer.map((item) => item.text).join(" ");
    const atSentence = endsCompleteThought(cue.text) || endsCompleteThought(textSoFar);
    const atSoftBreak = endsSoftBreak(cue.text);
    const pauseAfter = next ? Math.max(0, next.startSeconds - cue.endSeconds) : PAUSE_BREAK_SECONDS;
    const nearTarget = span >= TARGET_WINDOW_SECONDS;
    const overMax = span >= MAX_WINDOW_SECONDS;

    const shouldClose =
      buffer.length > 0 &&
      (
        // Hard cap — still prefer waiting for a soft break when possible.
        (overMax && (atSoftBreak || pauseAfter >= PAUSE_BREAK_SECONDS || !next)) ||
        // Ideal close: reached target length on a finished sentence.
        (nearTarget && atSentence) ||
        // Good close: target length + pause or clause break.
        (nearTarget && (pauseAfter >= PAUSE_BREAK_SECONDS || atSoftBreak)) ||
        // End of transcript.
        !next
      );

    if (shouldClose) {
      flush();
      if (next) {
        windowStart = next.startSeconds;
        windowEnd = next.startSeconds;
      }
    }
  }

  flush();
  return windows.filter((window) => window.text.length > 0 && window.endSeconds > window.startSeconds);
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
    } catch {
      // Same datacenter-IP bot-check that blocks downloads can also block
      // metadata lookups. Report it as a soft "no transcript" case (200,
      // empty windows) so the UI falls back to sample windows instead of
      // surfacing this as a hard error.
      return res.status(200).json({ windows: [], cues: [], reason: "blocked" });
    }

    const tracks = (info.player_response as { captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } } })
      ?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!tracks || tracks.length === 0) {
      return res.status(200).json({ windows: [], cues: [], reason: "no-captions" });
    }

    const track =
      tracks.find((t) => t.languageCode?.startsWith("en") && t.kind !== "asr") ??
      tracks.find((t) => t.languageCode?.startsWith("en")) ??
      tracks[0];

    const captionRes = await fetch(track.baseUrl);
    if (!captionRes.ok) {
      return res.status(200).json({ windows: [], cues: [], reason: "fetch-failed" });
    }

    const xml = await captionRes.text();
    const cues = parseTimedText(xml);
    const windows = groupIntoWindows(cues);

    // Return fine-grained cues so the client can snap clip edges onto
    // complete sentences instead of coarse window walls.
    return res.status(200).json({
      windows,
      cues,
      reason: windows.length ? "ok" : "empty",
    });
  } catch (error) {
    return res.status(200).json({
      windows: [],
      cues: [],
      reason: "error",
      error: error instanceof Error ? error.message : "Transcript fetch failed.",
    });
  }
}
