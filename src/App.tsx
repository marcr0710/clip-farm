import { useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Clock3,
  Film,
  Link2,
  LoaderCircle,
  PlayCircle,
  ScanSearch,
  Scissors,
  Sparkles,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";

import { ClipPreviewDialog } from "@/components/clip-preview-dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import type { ShortsAspect } from "@/lib/client-trim";
import { downloadBlob } from "@/lib/download";
import { Badge } from "@/components/ui/badge";
import { BlurFade } from "@/components/ui/blur-fade";
import { BorderBeam } from "@/components/ui/border-beam";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DotPattern } from "@/components/ui/dot-pattern";
import { Input } from "@/components/ui/input";
import { MagicCard } from "@/components/ui/magic-card";
import { NumberTicker } from "@/components/ui/number-ticker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { useCompletion } from "@/lib/devs-ai/use-completion";

interface TranscriptWindow {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

interface TranscriptCue {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

interface Clip {
  id: number;
  title: string;
  hook: string;
  reason: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  /** AI-proposed start, kept so the user can reset a manual trim. */
  originalStartSeconds: number;
  /** AI-proposed end, kept so the user can reset a manual trim. */
  originalEndSeconds: number;
  /** 0 = left, 1 = right. Crop window lock for speaker-aware framing. */
  focusX: number;
  /** 0 = top, 1 = bottom. Crop window lock for speaker-aware framing. */
  focusY: number;
  /** Time-varying speaker track (absolute source times). Empty = static focus. */
  focusKeyframes: Array<{ time: number; focusX: number; focusY: number }>;
  score: number;
  format: string;
  captionStyle: string;
  transcriptExcerpt: string;
}

interface VideoMeta {
  title: string;
  author: string;
  thumbnailUrl: string;
  videoId: string;
  source: "youtube" | "upload";
  durationSeconds?: number;
}

interface AICandidate {
  title: string;
  hook: string;
  reason: string;
  startSeconds: number;
  endSeconds: number;
  score: number;
}

interface TranscriptBundle {
  windows: TranscriptWindow[];
  cues: TranscriptCue[];
}

const MIN_CLIP_SECONDS = 18;
const MAX_CLIP_SECONDS = 58;
const IDEAL_MIN_CLIP_SECONDS = 22;
const IDEAL_MAX_CLIP_SECONDS = 45;
const SENTENCE_END_RE = /[.!?]["')\]]*$/;
const WEAK_OPENER_RE = /^(and|but|so|because|which|that|then|also|or|if|when|while|although|though|plus)\b/i;
const WEAK_CLOSER_RE = /\b(and|but|so|because|which|that|or|if|when|while)\s*$/i;

const YOUTUBE_STAGES = [
  "Validating the YouTube link",
  "Loading metadata and embedded preview",
  "Building transcript windows for the full timeline",
  "AI scoring viral hooks, payoff, surprise, and replay value",
  "Preparing preview-ready clip ranges and captions",
];

const UPLOAD_STAGES = [
  "Reading the uploaded video file",
  "Loading local video metadata",
  "Building clip windows from the file timeline",
  "AI scoring viral hooks, payoff, surprise, and replay value",
  "Preparing preview-ready clip ranges and captions",
];

const SAMPLE_WINDOWS: TranscriptWindow[] = [
  {
    startSeconds: 94,
    endSeconds: 126,
    text: "Most creators think the intro should explain everything first, but the opposite is what keeps attention. The first eight seconds only need one thing: tension. If the viewer already understands the point, they stop scrolling past you but they also stop watching you.",
  },
  {
    startSeconds: 522,
    endSeconds: 557,
    text: "If your video starts with context, you've buried the actual story. The fastest-growing channels front-load conflict, then pay off the explanation after the audience is emotionally invested. That single change is why controversial edits often trigger comments.",
  },
  {
    startSeconds: 1028,
    endSeconds: 1072,
    text: "We changed one edit: we moved the outcome before the explanation. Retention doubled in the first thirty seconds and the same audience suddenly watched until the end. Nothing else about the content changed, only the sequence of the payoff.",
  },
  {
    startSeconds: 1315,
    endSeconds: 1362,
    text: "The moment a speaker gives a surprising number, a strong claim, or a hard-earned lesson, that's usually your clip start. The clip should end when the idea fully lands, not when a preset timer says to stop. That's how you avoid cutting the payoff out of the moment.",
  },
];

const FALLBACK_CLIPS: AICandidate[] = [
  {
    title: "The 8-second hook that keeps viewers watching",
    hook: "Most creators lose the audience before the first sentence ends.",
    reason: "Strong opening tension and a clear promise make this a natural short-form hook.",
    startSeconds: 94,
    endSeconds: 126,
    score: 94,
  },
  {
    title: "The contrarian take that sparks comments",
    hook: "If your video starts with context, you've already buried the story.",
    reason: "Disagreement potential is high and the claim resolves quickly enough to clip cleanly.",
    startSeconds: 522,
    endSeconds: 557,
    score: 91,
  },
  {
    title: "The payoff edit that doubled retention",
    hook: "One edit doubled retention without changing the content.",
    reason: "Outcome-first storytelling with a measurable result tends to earn replays and shares.",
    startSeconds: 1028,
    endSeconds: 1072,
    score: 89,
  },
  {
    title: "The surprising number that stops the scroll",
    hook: "One number made the whole argument land harder.",
    reason: "Concrete figures create instant credibility and make the cut feel complete on its own.",
    startSeconds: 1315,
    endSeconds: 1362,
    score: 87,
  },
  {
    title: "The lesson viewers will replay",
    hook: "The advice only works if you reverse the order.",
    reason: "A clear lesson with a twist ending gives short-form audiences a reason to rewatch.",
    startSeconds: 700,
    endSeconds: 745,
    score: 85,
  },
  {
    title: "The tension build before the reveal",
    hook: "Hold the answer just long enough to force a comment.",
    reason: "Delayed payoff and unresolved tension drive watch-through and discussion.",
    startSeconds: 300,
    endSeconds: 340,
    score: 84,
  },
  {
    title: "The mistake everyone makes first",
    hook: "This is the part most people skip — and it costs them views.",
    reason: "Mistake-then-fix patterns convert well because viewers self-identify with the problem.",
    startSeconds: 180,
    endSeconds: 220,
    score: 83,
  },
  {
    title: "The clean close that invites a share",
    hook: "If you only remember one thing from this, make it this.",
    reason: "A punchy closer with a memorable line is easy to clip and easy to share.",
    startSeconds: 1180,
    endSeconds: 1220,
    score: 82,
  },
];

const CLIP_COUNT_OPTIONS = [3, 5, 8, 12] as const;
type ClipCount = (typeof CLIP_COUNT_OPTIONS)[number];

const buildFallbackCandidates = (count: number, durationSeconds?: number): AICandidate[] => {
  const safeCount = Math.max(1, Math.min(12, Math.floor(count) || 3));
  const duration = durationSeconds && durationSeconds > 0 ? durationSeconds : undefined;

  return Array.from({ length: safeCount }, (_, index) => {
    const template = FALLBACK_CLIPS[index % FALLBACK_CLIPS.length];
    const score = Math.max(70, template.score - index);

    if (duration) {
      const span = Math.min(36, Math.max(18, Math.floor(duration / Math.max(5, safeCount + 1))));
      const startSeconds = Math.min(
        Math.max(0, Math.floor(duration * ((index + 1) / (safeCount + 1))) - Math.floor(span / 2)),
        Math.max(0, Math.floor(duration) - span),
      );
      return {
        ...template,
        title: index < FALLBACK_CLIPS.length ? template.title : `${template.title} (${index + 1})`,
        startSeconds,
        endSeconds: startSeconds + span,
        score,
      };
    }

    const baseStart = template.startSeconds + Math.floor(index / FALLBACK_CLIPS.length) * 90;
    const baseEnd = template.endSeconds + Math.floor(index / FALLBACK_CLIPS.length) * 90;
    return {
      ...template,
      title: index < FALLBACK_CLIPS.length ? template.title : `${template.title} (${index + 1})`,
      startSeconds: baseStart,
      endSeconds: Math.max(baseEnd, baseStart + 18),
      score,
    };
  });
};

const isYouTubeUrl = (value: string) => /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/i.test(value.trim());

const formatTime = (totalSeconds: number) => {
  const safe = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);

  if (hours > 0) {
    return [hours, minutes, seconds].map((value) => value.toString().padStart(2, "0")).join(":");
  }

  return [minutes, seconds].map((value) => value.toString().padStart(2, "0")).join(":");
};

/** Precise timestamp for trim inputs (mm:ss or h:mm:ss, with optional decimals). */
const formatTimePrecise = (totalSeconds: number, fractionDigits = 1) => {
  const safe = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const secStr = seconds.toFixed(fractionDigits).padStart(fractionDigits > 0 ? 3 + fractionDigits : 2, "0");

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secStr}`;
  }
  return `${minutes}:${secStr.padStart(fractionDigits > 0 ? 3 + fractionDigits : 2, "0")}`;
};

/** Parse "m:ss", "mm:ss.s", "h:mm:ss", or a plain seconds number into seconds. */
const parseTimestamp = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const asNumber = Number(trimmed);
    return Number.isFinite(asNumber) ? asNumber : null;
  }

  const parts = trimmed.split(":");
  if (parts.length < 2 || parts.length > 3) return null;

  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;

  if (nums.length === 2) {
    const [minutes, seconds] = nums;
    if (seconds >= 60) return null;
    return minutes * 60 + seconds;
  }

  const [hours, minutes, seconds] = nums;
  if (minutes >= 60 || seconds >= 60) return null;
  return hours * 3600 + minutes * 60 + seconds;
};

const MIN_MANUAL_CLIP_SECONDS = 1;
const MAX_MANUAL_CLIP_SECONDS = 120;

const clampClipRange = (
  startSeconds: number,
  endSeconds: number,
  mediaDuration?: number,
): { startSeconds: number; endSeconds: number; durationSeconds: number } => {
  const maxBound =
    mediaDuration && Number.isFinite(mediaDuration) && mediaDuration > 0
      ? mediaDuration
      : Number.POSITIVE_INFINITY;

  let start = Math.max(0, Number(startSeconds) || 0);
  let end = Math.max(0, Number(endSeconds) || 0);

  if (end <= start) {
    end = Math.min(maxBound, start + MIN_MANUAL_CLIP_SECONDS);
    if (end <= start) {
      start = Math.max(0, end - MIN_MANUAL_CLIP_SECONDS);
    }
  }

  if (end - start > MAX_MANUAL_CLIP_SECONDS) {
    end = start + MAX_MANUAL_CLIP_SECONDS;
  }

  if (end > maxBound) {
    end = maxBound;
    if (end - start < MIN_MANUAL_CLIP_SECONDS) {
      start = Math.max(0, end - MIN_MANUAL_CLIP_SECONDS);
    }
  }

  if (start > maxBound - MIN_MANUAL_CLIP_SECONDS) {
    start = Math.max(0, maxBound - MIN_MANUAL_CLIP_SECONDS);
  }

  start = Number(start.toFixed(2));
  end = Number(Math.max(start + MIN_MANUAL_CLIP_SECONDS, end).toFixed(2));
  if (end > maxBound && Number.isFinite(maxBound)) {
    end = Number(maxBound.toFixed(2));
    start = Number(Math.max(0, end - MIN_MANUAL_CLIP_SECONDS).toFixed(2));
  }

  return {
    startSeconds: start,
    endSeconds: end,
    durationSeconds: Number((end - start).toFixed(2)),
  };
};

const aspectFromFormat = (format: string): ShortsAspect => {
  if (format === "16:9" || format === "1:1" || format === "9:16") return format;
  return "9:16";
};

const endsCompleteThought = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return SENTENCE_END_RE.test(trimmed);
};

const normalizeSpeech = (text: string) => text.replace(/\s+/g, " ").trim();

const findBestWindowIndex = (windows: TranscriptWindow[], seconds: number) => {
  if (windows.length === 0) return 0;
  const directMatch = windows.findIndex((window) => seconds >= window.startSeconds && seconds <= window.endSeconds);
  if (directMatch >= 0) return directMatch;

  return windows.reduce((bestIndex, window, index) => {
    const midpoint = (window.startSeconds + window.endSeconds) / 2;
    const bestMidpoint = (windows[bestIndex].startSeconds + windows[bestIndex].endSeconds) / 2;
    return Math.abs(midpoint - seconds) < Math.abs(bestMidpoint - seconds) ? index : bestIndex;
  }, 0);
};

const findNearestCueIndex = (cues: TranscriptCue[], seconds: number, prefer: "start" | "end") => {
  if (cues.length === 0) return -1;

  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const anchor = prefer === "start" ? cue.startSeconds : cue.endSeconds;
    const distance = Math.abs(anchor - seconds);
    // Slightly prefer cues that already contain the timestamp.
    const containmentBonus = seconds >= cue.startSeconds && seconds <= cue.endSeconds ? 0.35 : 0;
    const adjusted = distance - containmentBonus;
    if (adjusted < bestDistance) {
      bestDistance = adjusted;
      bestIndex = index;
    }
  }

  return bestIndex;
};

const excerptFromCues = (cues: TranscriptCue[], startIndex: number, endIndex: number) =>
  normalizeSpeech(
    cues
      .slice(Math.max(0, startIndex), Math.min(cues.length - 1, endIndex) + 1)
      .map((cue) => cue.text)
      .join(" "),
  );

const scoreBoundaryPair = (
  cues: TranscriptCue[],
  startIndex: number,
  endIndex: number,
  targetStart: number,
  targetEnd: number,
) => {
  if (startIndex < 0 || endIndex < startIndex || endIndex >= cues.length) return Number.NEGATIVE_INFINITY;

  const start = cues[startIndex].startSeconds;
  const end = cues[endIndex].endSeconds;
  const duration = end - start;
  if (duration < MIN_CLIP_SECONDS - 0.5 || duration > MAX_CLIP_SECONDS + 1) return Number.NEGATIVE_INFINITY;

  const startText = normalizeSpeech(cues[startIndex].text);
  const endText = normalizeSpeech(cues[endIndex].text);
  const excerpt = excerptFromCues(cues, startIndex, endIndex);
  if (!excerpt) return Number.NEGATIVE_INFINITY;

  let score = 100;

  // Prefer staying close to the AI's chosen moment.
  score -= Math.abs(start - targetStart) * 1.35;
  score -= Math.abs(end - targetEnd) * 1.55;

  // Duration sweet spot for short-form.
  if (duration >= IDEAL_MIN_CLIP_SECONDS && duration <= IDEAL_MAX_CLIP_SECONDS) score += 18;
  else if (duration < IDEAL_MIN_CLIP_SECONDS) score -= (IDEAL_MIN_CLIP_SECONDS - duration) * 1.8;
  else score -= (duration - IDEAL_MAX_CLIP_SECONDS) * 1.4;

  // Clean linguistic edges beat raw timestamp proximity.
  if (endsCompleteThought(endText) || endsCompleteThought(excerpt)) score += 28;
  else if (WEAK_CLOSER_RE.test(endText)) score -= 24;
  else score -= 14;

  if (!WEAK_OPENER_RE.test(startText)) score += 12;
  else score -= 18;

  // Tiny breath of silence before/after usually means a natural edit point.
  const prev = cues[startIndex - 1];
  const next = cues[endIndex + 1];
  if (prev && cues[startIndex].startSeconds - prev.endSeconds >= 0.35) score += 6;
  if (next && next.startSeconds - cues[endIndex].endSeconds >= 0.35) score += 8;

  // Avoid ultra-short dangling final words.
  if (endText.split(/\s+/).length <= 2 && !endsCompleteThought(endText)) score -= 10;

  return score;
};

/**
 * Snap an AI-proposed range onto nearby caption cues so cuts open on a fresh
 * thought and close after a finished sentence — never mid-clause.
 */
const snapRangeToSpeechBoundaries = (
  cues: TranscriptCue[],
  startSeconds: number,
  endSeconds: number,
) => {
  if (cues.length === 0) {
    const start = Math.max(0, startSeconds);
    const end = Math.max(start + MIN_CLIP_SECONDS, endSeconds);
    return { startSeconds: start, endSeconds: end, startIndex: -1, endIndex: -1 };
  }

  const seedStart = findNearestCueIndex(cues, startSeconds, "start");
  const seedEnd = findNearestCueIndex(cues, endSeconds, "end");
  const targetStart = Math.max(0, startSeconds);
  const targetEnd = Math.max(targetStart + MIN_CLIP_SECONDS, endSeconds);

  let best = {
    startIndex: Math.min(seedStart, seedEnd),
    endIndex: Math.max(seedStart, seedEnd),
    score: Number.NEGATIVE_INFINITY,
  };

  const startFrom = Math.max(0, seedStart - 10);
  const startTo = Math.min(cues.length - 1, seedStart + 8);

  for (let startIndex = startFrom; startIndex <= startTo; startIndex += 1) {
    // Walk outward from the seed end so nearby sentence endings win first.
    for (let radius = 0; radius <= 18; radius += 1) {
      const candidates = radius === 0
        ? [seedEnd]
        : [seedEnd - radius, seedEnd + radius];

      for (const rawEnd of candidates) {
        const endIndex = Math.max(startIndex, Math.min(cues.length - 1, rawEnd));
        const score = scoreBoundaryPair(cues, startIndex, endIndex, targetStart, targetEnd);
        if (score > best.score) {
          best = { startIndex, endIndex, score };
        }
      }
    }
  }

  // If scoring failed (degenerate cues), fall back to a padded seed range.
  if (!Number.isFinite(best.score) || best.score === Number.NEGATIVE_INFINITY) {
    let startIndex = Math.max(0, Math.min(seedStart, seedEnd));
    let endIndex = Math.max(startIndex, Math.max(seedStart, seedEnd));
    while (cues[endIndex].endSeconds - cues[startIndex].startSeconds < MIN_CLIP_SECONDS && endIndex < cues.length - 1) {
      endIndex += 1;
    }
    while (cues[endIndex].endSeconds - cues[startIndex].startSeconds > MAX_CLIP_SECONDS && endIndex > startIndex) {
      endIndex -= 1;
    }
    best = { startIndex, endIndex, score: 0 };
  }

  // Final pass: if the chosen end is mid-sentence, stretch to the next full stop
  // when that still keeps us inside the max duration.
  let { startIndex, endIndex } = best;
  const currentExcerpt = excerptFromCues(cues, startIndex, endIndex);
  if (!endsCompleteThought(currentExcerpt) && !endsCompleteThought(cues[endIndex]?.text ?? "")) {
    for (let probe = endIndex + 1; probe < Math.min(cues.length, endIndex + 12); probe += 1) {
      const duration = cues[probe].endSeconds - cues[startIndex].startSeconds;
      if (duration > MAX_CLIP_SECONDS) break;
      endIndex = probe;
      if (endsCompleteThought(cues[probe].text) || endsCompleteThought(excerptFromCues(cues, startIndex, probe))) {
        break;
      }
    }
  }

  // If the opening cue is a weak continuation, try nudging forward a cue or two.
  for (let probe = 0; probe < 3; probe += 1) {
    const startText = normalizeSpeech(cues[startIndex]?.text ?? "");
    if (!WEAK_OPENER_RE.test(startText)) break;
    if (startIndex >= endIndex) break;
    const nextDuration = cues[endIndex].endSeconds - cues[startIndex + 1].startSeconds;
    if (nextDuration < MIN_CLIP_SECONDS) break;
    startIndex += 1;
  }

  return {
    startSeconds: cues[startIndex].startSeconds,
    endSeconds: cues[endIndex].endSeconds,
    startIndex,
    endIndex,
  };
};

const deriveClipTimingFromWindows = (candidate: AICandidate, windows: TranscriptWindow[]) => {
  if (windows.length === 0) {
    const startSeconds = Math.max(0, candidate.startSeconds);
    const endSeconds = Math.max(startSeconds + MIN_CLIP_SECONDS, candidate.endSeconds);
    return {
      startSeconds,
      endSeconds,
      durationSeconds: endSeconds - startSeconds,
      transcriptExcerpt: candidate.hook,
    };
  }

  let startIndex = findBestWindowIndex(windows, candidate.startSeconds);
  let endIndex = findBestWindowIndex(windows, candidate.endSeconds);

  if (endIndex < startIndex) {
    [startIndex, endIndex] = [endIndex, startIndex];
  }

  // Prefer opening at the window that contains the hook, and closing only after
  // a window whose text finishes a thought.
  let startSeconds = windows[startIndex].startSeconds;
  let endSeconds = windows[endIndex].endSeconds;

  const expandForMin = () => {
    while (endSeconds - startSeconds < MIN_CLIP_SECONDS && endIndex < windows.length - 1) {
      endIndex += 1;
      endSeconds = windows[endIndex].endSeconds;
    }
    while (endSeconds - startSeconds < MIN_CLIP_SECONDS && startIndex > 0) {
      startIndex -= 1;
      startSeconds = windows[startIndex].startSeconds;
    }
  };

  expandForMin();

  // Stretch the end until the joined excerpt ends on punctuation, when possible.
  while (
    endIndex < windows.length - 1 &&
    endSeconds - startSeconds < MAX_CLIP_SECONDS &&
    !endsCompleteThought(windows[endIndex].text) &&
    !endsCompleteThought(
      windows
        .slice(startIndex, endIndex + 1)
        .map((window) => window.text)
        .join(" "),
    )
  ) {
    endIndex += 1;
    endSeconds = windows[endIndex].endSeconds;
  }

  while (endSeconds - startSeconds > MAX_CLIP_SECONDS && endIndex > startIndex) {
    // Shrink from the side that keeps a sentence-final ending when possible.
    const shrinkEnd = endIndex - 1;
    const shrunkEnd = windows[shrinkEnd].endSeconds;
    if (shrunkEnd - startSeconds >= MIN_CLIP_SECONDS) {
      endIndex = shrinkEnd;
      endSeconds = shrunkEnd;
      continue;
    }
    break;
  }

  // Avoid weak openers when the next window is still inside the idea.
  while (
    startIndex < endIndex &&
    WEAK_OPENER_RE.test(normalizeSpeech(windows[startIndex].text)) &&
    endSeconds - windows[startIndex + 1].startSeconds >= MIN_CLIP_SECONDS
  ) {
    startIndex += 1;
    startSeconds = windows[startIndex].startSeconds;
  }

  const transcriptExcerpt = normalizeSpeech(
    windows
      .slice(startIndex, endIndex + 1)
      .map((window) => window.text)
      .join(" "),
  );

  return {
    startSeconds,
    endSeconds,
    durationSeconds: endSeconds - startSeconds,
    transcriptExcerpt: transcriptExcerpt || candidate.hook,
  };
};

const deriveClipTiming = (
  candidate: AICandidate,
  windows: TranscriptWindow[],
  cues: TranscriptCue[] = [],
) => {
  const targetStart = Math.max(0, candidate.startSeconds);
  const targetEnd = Math.max(targetStart + MIN_CLIP_SECONDS, candidate.endSeconds);

  if (cues.length > 0) {
    const snapped = snapRangeToSpeechBoundaries(cues, targetStart, targetEnd);
    const transcriptExcerpt =
      snapped.startIndex >= 0 && snapped.endIndex >= snapped.startIndex
        ? excerptFromCues(cues, snapped.startIndex, snapped.endIndex)
        : candidate.hook;

    return {
      startSeconds: Number(snapped.startSeconds.toFixed(2)),
      endSeconds: Number(snapped.endSeconds.toFixed(2)),
      durationSeconds: Number((snapped.endSeconds - snapped.startSeconds).toFixed(2)),
      transcriptExcerpt: transcriptExcerpt || candidate.hook,
    };
  }

  return deriveClipTimingFromWindows(
    { ...candidate, startSeconds: targetStart, endSeconds: targetEnd },
    windows,
  );
};

/** Drop overlapping weaker clips so the board doesn't repeat the same moment. */
const dedupeCandidates = (candidates: AICandidate[], maxClips: number): AICandidate[] => {
  const ranked = [...candidates].sort((a, b) => {
    const scoreDelta = (Number(b.score) || 0) - (Number(a.score) || 0);
    if (scoreDelta !== 0) return scoreDelta;
    return a.startSeconds - b.startSeconds;
  });

  const accepted: AICandidate[] = [];
  for (const candidate of ranked) {
    const overlaps = accepted.some((other) => {
      const overlapStart = Math.max(candidate.startSeconds, other.startSeconds);
      const overlapEnd = Math.min(candidate.endSeconds, other.endSeconds);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      const shorter = Math.max(
        1,
        Math.min(candidate.endSeconds - candidate.startSeconds, other.endSeconds - other.startSeconds),
      );
      return overlap / shorter > 0.45;
    });
    if (!overlaps) accepted.push(candidate);
    if (accepted.length >= maxClips) break;
  }

  return accepted.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
};

const getVideoId = (url: string) => {
  try {
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    const parsed = new URL(normalized);

    if (parsed.hostname.includes("youtu.be")) {
      return parsed.pathname.replace("/", "").trim();
    }

    if (parsed.hostname.includes("youtube.com")) {
      const shortId = parsed.searchParams.get("v");
      if (shortId) return shortId;
      const shortsMatch = parsed.pathname.match(/\/shorts\/([^/?]+)/);
      if (shortsMatch?.[1]) return shortsMatch[1];
      const embedMatch = parsed.pathname.match(/\/embed\/([^/?]+)/);
      if (embedMatch?.[1]) return embedMatch[1];
    }
  } catch {
    return "";
  }

  return "";
};

const getFormatForPlatform = (platform: string) => {
  if (platform === "podcast") return "16:9";
  if (platform === "square") return "1:1";
  return "9:16";
};

const getClipEmbedUrl = (videoId: string, clip?: Pick<Clip, "startSeconds" | "endSeconds"> | null) => {
  if (!videoId) return "";

  const params = new URLSearchParams({
    rel: "0",
    modestbranding: "1",
  });

  if (clip) {
    params.set("start", String(Math.max(0, Math.floor(clip.startSeconds))));
    params.set("end", String(Math.max(Math.ceil(clip.endSeconds), Math.floor(clip.startSeconds) + 1)));
  }

  return `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`;
};

const getCaptionLabel = (captionPreset: string) => {
  if (captionPreset === "clean") return "Clean lower thirds";
  if (captionPreset === "bar") return "Creator subtitle bar";
  return "Bold punch captions";
};

const buildPrompt = (
  meta: VideoMeta | null,
  windows: TranscriptWindow[],
  sourceLabel = "video transcript",
  clipCount = 3,
) => {
  const transcript = windows
    .map((window, index) => `${index + 1}. [${formatTime(window.startSeconds)} → ${formatTime(window.endSeconds)}] ${window.text}`)
    .join("\n");
  const count = Math.max(1, Math.min(12, Math.floor(clipCount) || 3));

  return `You are a short-form clip editor ranking the best standalone moments from a ${sourceLabel}.

Video title: ${meta?.title ?? "Unknown"}
Channel: ${meta?.author ?? "Unknown"}
Duration: ${meta?.durationSeconds ? formatTime(meta.durationSeconds) : "unknown"}

Your job is NOT to force fixed timers. Your job is to cut clean, complete moments that feel intentional when watched alone.

Hard rules for every clip:
- Pick exactly ${count} clips. Return exactly ${count} items in the clips array.
- Each clip MUST be a self-contained story beat: setup → tension/turn → payoff.
- startSeconds MUST land at the beginning of a fresh thought or sentence — never mid-sentence, never on a filler continuation like "and", "but", "so", "because".
- endSeconds MUST land AFTER the final key sentence fully finishes — include the closing word and punctuation beat. Never stop mid-clause or before the punchline lands.
- Prefer ending on a period, question mark, exclamation, laugh, or clear pause — not a comma or trailing "and/so/but".
- Ideal length is ${IDEAL_MIN_CLIP_SECONDS}-${IDEAL_MAX_CLIP_SECONDS}s. Hard bounds: ${MIN_CLIP_SECONDS}-${MAX_CLIP_SECONDS}s. Stretch or shrink to protect complete sentences.
- If a strong idea needs 40s to finish cleanly, use 40s. If it lands in 24s, stop there.
- Use ONLY timestamps that appear in the timeline windows below (or clearly inside those ranges). Do not invent times far outside the provided windows.
- Prefer moments spread across the full timeline, not clustered in the first two minutes.
- Prefer speaker-forward moments that will reframe cleanly as vertical Shorts: one clear talker, direct address, reaction, or A-roll face time. Deprioritize wide multi-person panels, dense slide decks, and B-roll-only stretches unless the line is exceptional.
- In reason, briefly note why the moment works on camera for a vertical crop (e.g. single speaker, strong delivery, visual punch).
- Rank by viral potential (hook strength, surprise, emotion, concrete lesson, disagreement, replay value, and how well it will look as a 9:16 talking-head short). Highest score first.
- title: short editorial label for the moment.
- hook: the exact opening line or promise the viewer hears first.
- reason: one sentence on why this cut works as a standalone short.
- score: integer 1-99.

Return valid JSON only in this exact shape:
{
  "clips": [
    {
      "title": "...",
      "hook": "...",
      "reason": "...",
      "startSeconds": 0,
      "endSeconds": 0,
      "score": 0
    }
  ]
}

Timeline windows (use these speech boundaries):
${transcript}`;
};

// When the user only has a local file (no YouTube captions), build evenly
// spaced timing windows from the file duration so AI still has a full-timeline
// structure to rank against instead of inventing unbounded timestamps.
const buildTimelineWindowsFromDuration = (durationSeconds: number): TranscriptWindow[] => {
  const safeDuration = Math.max(30, Math.floor(durationSeconds) || 180);
  const windowCount = Math.min(12, Math.max(4, Math.floor(safeDuration / 45)));
  const windowLength = Math.max(18, Math.min(45, Math.floor(safeDuration / windowCount)));
  const windows: TranscriptWindow[] = [];

  for (let index = 0; index < windowCount; index += 1) {
    const startSeconds = Math.min(safeDuration - 15, Math.floor((index / windowCount) * safeDuration));
    const endSeconds = Math.min(safeDuration, startSeconds + windowLength);
    if (endSeconds <= startSeconds) continue;
    windows.push({
      startSeconds,
      endSeconds,
      text: `Local video segment ${index + 1} from ${formatTime(startSeconds)} to ${formatTime(endSeconds)}. Look for a self-contained hook, tension, and payoff inside this range.`,
    });
  }

  return windows.length > 0 ? windows : SAMPLE_WINDOWS;
};

const readUploadedVideoMeta = (file: File): Promise<VideoMeta> =>
  new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;

    const cleanup = () => {
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
    };

    const finish = (durationSeconds?: number) => {
      cleanup();
      resolve({
        title: file.name.replace(/\.[^.]+$/, "") || "Uploaded video",
        author: "Local upload",
        thumbnailUrl: "",
        videoId: "",
        source: "upload",
        durationSeconds,
      });
    };

    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : undefined;
      finish(duration);
    };
    video.onerror = () => finish(undefined);
    video.src = objectUrl;
  });

async function fetchYouTubeTranscript(videoId: string): Promise<TranscriptBundle | null> {
  if (!videoId) return null;

  try {
    const response = await fetch("/api/youtube/transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId }),
    });
    if (!response.ok) return null;

    const data = await response.json();
    const windows = Array.isArray(data.windows) ? (data.windows as TranscriptWindow[]) : [];
    const cues = Array.isArray(data.cues)
      ? (data.cues as TranscriptCue[])
          .filter(
            (cue) =>
              typeof cue.text === "string" &&
              Number.isFinite(Number(cue.startSeconds)) &&
              Number.isFinite(Number(cue.endSeconds)) &&
              Number(cue.endSeconds) > Number(cue.startSeconds),
          )
          .map((cue) => ({
            startSeconds: Number(cue.startSeconds),
            endSeconds: Number(cue.endSeconds),
            text: normalizeSpeech(cue.text),
          }))
      : [];

    if (windows.length === 0 && cues.length === 0) return null;

    // If the API only returned cues (or windows failed grouping), rebuild
    // coarse windows client-side so the prompt still has readable chunks.
    const resolvedWindows =
      windows.length > 0
        ? windows.map((window) => ({
            startSeconds: Number(window.startSeconds),
            endSeconds: Number(window.endSeconds),
            text: normalizeSpeech(window.text),
          }))
        : buildWindowsFromCues(cues);

    return { windows: resolvedWindows, cues };
  } catch {
    return null;
  }
}

/** Coarse prompt windows from fine cues when the API only returns cues. */
const buildWindowsFromCues = (cues: TranscriptCue[], targetSeconds = 28): TranscriptWindow[] => {
  if (cues.length === 0) return [];
  const windows: TranscriptWindow[] = [];
  let startIndex = 0;

  for (let index = 0; index < cues.length; index += 1) {
    const span = cues[index].endSeconds - cues[startIndex].startSeconds;
    const atEnd = index === cues.length - 1;
    const atSentence = endsCompleteThought(cues[index].text);
    if ((span >= targetSeconds && atSentence) || span >= 48 || atEnd) {
      windows.push({
        startSeconds: cues[startIndex].startSeconds,
        endSeconds: cues[index].endSeconds,
        text: excerptFromCues(cues, startIndex, index),
      });
      startIndex = index + 1;
    }
  }

  return windows.filter((window) => window.text && window.endSeconds > window.startSeconds);
};

// Full-length transcripts can run for hours; capped, density-aware sampling
// keeps the prompt a sane size while still covering beginning, middle, and end
// and preserving local sentence context around each kept window.
const sampleWindowsAcrossTimeline = (windows: TranscriptWindow[], maxCount: number): TranscriptWindow[] => {
  if (windows.length <= maxCount) return windows;

  const sampled: TranscriptWindow[] = [];
  const used = new Set<number>();

  // Always keep the first and last windows for cold-open / closer coverage.
  const anchors = [0, windows.length - 1];
  for (let i = 1; i < maxCount - 1; i += 1) {
    anchors.push(Math.round((i / (maxCount - 1)) * (windows.length - 1)));
  }

  for (const index of anchors) {
    const safeIndex = Math.max(0, Math.min(windows.length - 1, index));
    if (used.has(safeIndex)) continue;
    used.add(safeIndex);
    sampled.push(windows[safeIndex]);
    if (sampled.length >= maxCount) break;
  }

  return sampled.sort((a, b) => a.startSeconds - b.startSeconds);
};


async function fetchYouTubeMeta(videoId: string): Promise<VideoMeta | null> {
  if (!videoId) return null;

  try {
    const response = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (!response.ok) return null;
    const data = await response.json();
    return {
      title: data.title ?? "YouTube video",
      author: data.author_name ?? "Unknown creator",
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      videoId,
      source: "youtube",
    };
  } catch {
    return {
      title: "YouTube video",
      author: "Unknown creator",
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      videoId,
      source: "youtube",
    };
  }
}

const parseAIClipPayload = (raw: string, maxClips = 12): AICandidate[] | null => {
  const cleaned = raw.trim();
  const jsonCandidate = cleaned.match(/\{[\s\S]*\}/)?.[0] ?? cleaned;
  const limit = Math.max(1, Math.min(12, Math.floor(maxClips) || 3));

  try {
    const parsed = JSON.parse(jsonCandidate) as { clips?: AICandidate[] };
    if (!Array.isArray(parsed.clips)) return null;

    const normalized = parsed.clips
      .filter((clip) => typeof clip.title === "string" && typeof clip.hook === "string")
      .map((clip) => {
        const startSeconds = Number(clip.startSeconds);
        const endSeconds = Number(clip.endSeconds);
        const score = Number(clip.score);
        return {
          title: normalizeSpeech(clip.title),
          hook: normalizeSpeech(clip.hook),
          reason: typeof clip.reason === "string" && clip.reason.trim()
            ? normalizeSpeech(clip.reason)
            : "Strong standalone moment with a clear hook and payoff.",
          startSeconds,
          endSeconds,
          score: Number.isFinite(score) ? score : 80,
        } satisfies AICandidate;
      })
      .filter((clip) =>
        Number.isFinite(clip.startSeconds) &&
        Number.isFinite(clip.endSeconds) &&
        clip.endSeconds > clip.startSeconds &&
        clip.title.length > 0 &&
        clip.hook.length > 0,
      )
      // Reject absurd ultra-short or multi-minute AI mistakes before snap.
      .filter((clip) => {
        const duration = clip.endSeconds - clip.startSeconds;
        return duration >= 8 && duration <= 120;
      })
      .map((clip) => {
        // Soft-clamp outrageous lengths; sentence snap refines further.
        const duration = clip.endSeconds - clip.startSeconds;
        if (duration < MIN_CLIP_SECONDS) {
          return { ...clip, endSeconds: clip.startSeconds + MIN_CLIP_SECONDS };
        }
        if (duration > MAX_CLIP_SECONDS + 20) {
          return { ...clip, endSeconds: clip.startSeconds + MAX_CLIP_SECONDS };
        }
        return clip;
      });

    if (normalized.length === 0) return null;
    return dedupeCandidates(normalized, limit);
  } catch {
    return null;
  }
};

const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "clip";

const formatFileSize = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    return window.localStorage.getItem("clipcraft-theme") === "dark" ? "dark" : "light";
  });
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [platform, setPlatform] = useState("shorts");
  const [captionPreset, setCaptionPreset] = useState("bold");
  const [clipCount, setClipCount] = useState<ClipCount>(5);
  const [stageIndex, setStageIndex] = useState(-1);
  const [isProcessing, setIsProcessing] = useState(false);
  const [clips, setClips] = useState<Clip[]>([]);
  const [error, setError] = useState("");
  const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);
  const [aiSummary, setAiSummary] = useState("AI will analyze a YouTube link or an uploaded video timeline to find the moments most likely to hold attention, trigger comments, and deliver a clean payoff.");
  const [renderState, setRenderState] = useState<Record<number, "idle" | "rendering" | "error">>({});
  const [renderErrors, setRenderErrors] = useState<Record<number, string>>({});
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [uploadedPreviewUrl, setUploadedPreviewUrl] = useState("");
  const [uploadRenderState, setUploadRenderState] = useState<Record<number, "idle" | "rendering" | "error">>({});
  const [uploadRenderErrors, setUploadRenderErrors] = useState<Record<number, string>>({});
  const [uploadRenderStatus, setUploadRenderStatus] = useState<Record<number, string>>({});
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const aiModel = import.meta.env.VITE_AI_AGENT_ID;
  const { complete, isLoading: isAILoading, error: aiError } = useCompletion({ model: aiModel });

  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark") !== (theme === "dark")) {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }

  if (typeof window !== "undefined" && window.localStorage.getItem("clipcraft-theme") !== theme) {
    window.localStorage.setItem("clipcraft-theme", theme);
  }

  const hasYouTubeLink = isYouTubeUrl(youtubeUrl);
  const hasUploadedFile = Boolean(uploadedFile);
  const canGenerate = hasYouTubeLink || hasUploadedFile;
  const analysisSource: "youtube" | "upload" | null = hasUploadedFile && !hasYouTubeLink
    ? "upload"
    : hasYouTubeLink
      ? "youtube"
      : hasUploadedFile
        ? "upload"
        : null;
  const activeStages = analysisSource === "upload" ? UPLOAD_STAGES : YOUTUBE_STAGES;

  const progress = useMemo(() => {
    if (!isProcessing) return clips.length > 0 ? 100 : 0;
    return Math.round(((stageIndex + 1) / activeStages.length) * 100);
  }, [activeStages.length, clips.length, isProcessing, stageIndex]);

  const currentVideoId = useMemo(() => (hasYouTubeLink ? getVideoId(youtubeUrl) : ""), [hasYouTubeLink, youtubeUrl]);

  const clearUploadedFile = () => {
    setUploadedFile(null);
    setUploadedPreviewUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return "";
    });
    if (uploadInputRef.current) uploadInputRef.current.value = "";
  };

  const handleUploadSelected = (file: File | null) => {
    setUploadedPreviewUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return file ? URL.createObjectURL(file) : "";
    });
    setUploadedFile(file);
    setError("");
  };

  const buildClipCards = (
    candidates: AICandidate[],
    timingWindows: TranscriptWindow[],
    timingCues: TranscriptCue[] = [],
  ) => {
    const cards = candidates.map((candidate) => {
      const timing = deriveClipTiming(candidate, timingWindows, timingCues);
      return {
        id: 0,
        title: candidate.title,
        hook: candidate.hook,
        reason: candidate.reason,
        startSeconds: timing.startSeconds,
        endSeconds: timing.endSeconds,
        durationSeconds: timing.durationSeconds,
        originalStartSeconds: timing.startSeconds,
        originalEndSeconds: timing.endSeconds,
        // Center until the user pans or auto face-detect builds a speaker track.
        focusX: 0.5,
        focusY: 0.5,
        focusKeyframes: [],
        score: Math.max(1, Math.min(99, Math.round(Number(candidate.score) || 80))),
        format: getFormatForPlatform(platform),
        captionStyle: getCaptionLabel(captionPreset),
        transcriptExcerpt: timing.transcriptExcerpt,
      } satisfies Clip;
    });

    // Re-dedupe after boundary snap in case two AI picks collapsed onto the same beat.
    const accepted: Clip[] = [];
    for (const card of cards.sort((a, b) => b.score - a.score)) {
      const overlaps = accepted.some((other) => {
        const overlapStart = Math.max(card.startSeconds, other.startSeconds);
        const overlapEnd = Math.min(card.endSeconds, other.endSeconds);
        const overlap = Math.max(0, overlapEnd - overlapStart);
        const shorter = Math.max(1, Math.min(card.durationSeconds, other.durationSeconds));
        return overlap / shorter > 0.5;
      });
      if (!overlaps) accepted.push(card);
    }

    return accepted
      .sort((a, b) => b.score - a.score)
      .map((clip, index) => ({ ...clip, id: index + 1 }));
  };

  const mediaDurationSeconds = videoMeta?.durationSeconds;

  const updateClipTiming = (clipId: number, nextStart: number, nextEnd: number) => {
    setClips((previous) =>
      previous.map((clip) => {
        if (clip.id !== clipId) return clip;
        const range = clampClipRange(nextStart, nextEnd, mediaDurationSeconds);
        return {
          ...clip,
          startSeconds: range.startSeconds,
          endSeconds: range.endSeconds,
          durationSeconds: range.durationSeconds,
        };
      }),
    );
  };

  const resetClipTiming = (clipId: number) => {
    setClips((previous) =>
      previous.map((clip) => {
        if (clip.id !== clipId) return clip;
        const range = clampClipRange(
          clip.originalStartSeconds,
          clip.originalEndSeconds,
          mediaDurationSeconds,
        );
        return {
          ...clip,
          startSeconds: range.startSeconds,
          endSeconds: range.endSeconds,
          durationSeconds: range.durationSeconds,
        };
      }),
    );
  };

  const clampFocus = (value: number) => {
    if (!Number.isFinite(value)) return 0.5;
    return Math.min(1, Math.max(0, value));
  };

  const updateClipFocus = (
    clipId: number,
    focusX: number,
    focusY: number,
    focusKeyframes?: Array<{ time: number; focusX: number; focusY: number }> | null,
  ) => {
    setClips((previous) =>
      previous.map((clip) => {
        if (clip.id !== clipId) return clip;
        const nextKeyframes = Array.isArray(focusKeyframes)
          ? focusKeyframes
              .map((frame) => ({
                time: Math.max(0, Number(frame.time) || 0),
                focusX: clampFocus(frame.focusX),
                focusY: clampFocus(frame.focusY),
              }))
              .sort((a, b) => a.time - b.time)
          : focusKeyframes === null
            ? []
            : clip.focusKeyframes;
        return {
          ...clip,
          focusX: clampFocus(focusX),
          focusY: clampFocus(focusY),
          focusKeyframes: nextKeyframes,
        };
      }),
    );
  };

  const resetClipFocus = (clipId: number) => {
    setClips((previous) =>
      previous.map((clip) =>
        clip.id === clipId
          ? { ...clip, focusX: 0.5, focusY: 0.5, focusKeyframes: [] }
          : clip,
      ),
    );
  };

  const handleDownloadClipBrief = (clip: Clip) => {
    const payload = {
      exportedAt: new Date().toISOString(),
      video: {
        source: videoMeta?.source ?? (currentVideoId ? "youtube" : "upload"),
        sourceUrl: currentVideoId ? youtubeUrl : uploadedFile?.name ?? "",
        videoId: currentVideoId || null,
        title: videoMeta?.title ?? uploadedFile?.name ?? "Clip source",
        author: videoMeta?.author ?? (uploadedFile ? "Local upload" : "Unknown creator"),
        durationSeconds: videoMeta?.durationSeconds ?? null,
      },
      clip: {
        title: clip.title,
        hook: clip.hook,
        reason: clip.reason,
        startSeconds: clip.startSeconds,
        endSeconds: clip.endSeconds,
        durationSeconds: clip.durationSeconds,
        originalStartSeconds: clip.originalStartSeconds,
        originalEndSeconds: clip.originalEndSeconds,
        start: formatTime(clip.startSeconds),
        end: formatTime(clip.endSeconds),
        duration: formatTime(clip.durationSeconds),
        score: clip.score,
        format: clip.format,
        aspect: aspectFromFormat(clip.format),
        focusX: clip.focusX,
        focusY: clip.focusY,
        focusKeyframes: clip.focusKeyframes,
        captionStyle: clip.captionStyle,
        transcriptExcerpt: clip.transcriptExcerpt,
        manuallyTrimmed:
          Math.abs(clip.startSeconds - clip.originalStartSeconds) > 0.05 ||
          Math.abs(clip.endSeconds - clip.originalEndSeconds) > 0.05,
        reframed:
          Math.abs(clip.focusX - 0.5) > 0.02 ||
          Math.abs(clip.focusY - 0.5) > 0.02 ||
          clip.focusKeyframes.length > 0,
        speakerTracking: clip.focusKeyframes.length > 1,
        previewUrl: currentVideoId ? getClipEmbedUrl(currentVideoId, clip) : null,
        youtubeUrl: currentVideoId
          ? `https://www.youtube.com/watch?v=${currentVideoId}&t=${Math.floor(clip.startSeconds)}s`
          : null,
      },
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    downloadBlob(blob, `${slugify(clip.title)}-clip-brief.json`);
  };

  // Trims the clip in the browser with ffmpeg.wasm. The full file never leaves
  // the device, so large uploads (100 MB+) work without the old 60 MB server
  // body cap — and YouTube is never contacted.
  const handleRenderFromUpload = async (clip: Clip) => {
    if (!uploadedFile) return;

    setUploadRenderState((prev) => ({ ...prev, [clip.id]: "rendering" }));
    setRenderState((prev) => ({ ...prev, [clip.id]: "rendering" }));
    setUploadRenderStatus((prev) => ({ ...prev, [clip.id]: "Starting local trim…" }));
    setUploadRenderErrors((prev) => {
      const next = { ...prev };
      delete next[clip.id];
      return next;
    });
    setRenderErrors((prev) => {
      const next = { ...prev };
      delete next[clip.id];
      return next;
    });

    try {
      // Lazy-load ffmpeg.wasm only when the user actually trims a clip.
      const { trimVideoInBrowser } = await import("@/lib/client-trim");
      const blob = await trimVideoInBrowser({
        file: uploadedFile,
        startSeconds: clip.startSeconds,
        endSeconds: clip.endSeconds,
        aspect: aspectFromFormat(clip.format),
        focusX: clip.focusX,
        focusY: clip.focusY,
        focusKeyframes: clip.focusKeyframes,
        onStatus: (message) => {
          setUploadRenderStatus((prev) => ({ ...prev, [clip.id]: message }));
        },
      });

      downloadBlob(blob, `${slugify(clip.title)}.mp4`);
      setUploadRenderState((prev) => ({ ...prev, [clip.id]: "idle" }));
      setRenderState((prev) => ({ ...prev, [clip.id]: "idle" }));
      setUploadRenderStatus((prev) => {
        const next = { ...prev };
        delete next[clip.id];
        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Local trim failed.";
      setUploadRenderState((prev) => ({ ...prev, [clip.id]: "error" }));
      setRenderState((prev) => ({ ...prev, [clip.id]: "error" }));
      setUploadRenderStatus((prev) => {
        const next = { ...prev };
        delete next[clip.id];
        return next;
      });
      setUploadRenderErrors((prev) => ({ ...prev, [clip.id]: message }));
      setRenderErrors((prev) => ({ ...prev, [clip.id]: message }));
    }
  };

  const handleRenderClip = async (clip: Clip) => {
    // Upload-first: if a local file is present, always render from it. A
    // YouTube link is optional and not required once the source is uploaded.
    if (uploadedFile) {
      await handleRenderFromUpload(clip);
      return;
    }

    if (!hasYouTubeLink) {
      setRenderState((prev) => ({ ...prev, [clip.id]: "error" }));
      setRenderErrors((prev) => ({
        ...prev,
        [clip.id]: "Upload a video file or paste a YouTube link before rendering this clip.",
      }));
      return;
    }

    setRenderState((prev) => ({ ...prev, [clip.id]: "rendering" }));
    setRenderErrors((prev) => {
      const next = { ...prev };
      delete next[clip.id];
      return next;
    });

    try {
      const response = await fetch("/api/clip/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: youtubeUrl,
          startSeconds: clip.startSeconds,
          endSeconds: clip.endSeconds,
          aspect: aspectFromFormat(clip.format),
          focusX: clip.focusX,
          focusY: clip.focusY,
          focusKeyframes: clip.focusKeyframes,
        }),
      });

      if (!response.ok) {
        let message = `Rendering failed (${response.status}).`;
        try {
          const body = await response.json();
          if (body?.error) message = body.error;
        } catch {
          // response wasn't JSON, keep the generic message
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      downloadBlob(blob, `${slugify(clip.title)}.mp4`);
      setRenderState((prev) => ({ ...prev, [clip.id]: "idle" }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Clip rendering failed.";
      setRenderState((prev) => ({ ...prev, [clip.id]: "error" }));
      setRenderErrors((prev) => ({ ...prev, [clip.id]: message }));
    }
  };

  const handleGenerate = async () => {
    if (!canGenerate) {
      setError("Upload a video file or paste a YouTube link to analyze.");
      setClips([]);
      setIsProcessing(false);
      setStageIndex(-1);
      return;
    }

    // Prefer the uploaded file when both are present only if the user didn't
    // provide a valid YouTube URL — otherwise keep the richer caption path.
    const useUploadOnly = Boolean(uploadedFile) && !hasYouTubeLink;

    setError("");
    setClips([]);
    setVideoMeta(null);
    setStageIndex(0);
    setIsProcessing(true);
    setAiSummary(
      useUploadOnly
        ? "Reading the uploaded video and building timeline windows for AI scoring..."
        : "Loading metadata and transcript windows for AI scoring...",
    );

    try {
      if (useUploadOnly && uploadedFile) {
        // Analysis only needs metadata + timeline windows. Trimming runs
        // client-side, so large files (100 MB+) are fully supported.
        setStageIndex(1);
        const meta = await readUploadedVideoMeta(uploadedFile);
        setVideoMeta(meta);

        setStageIndex(2);
        setAiSummary("Building clip windows from the uploaded file timeline...");
        const transcriptWindows = buildTimelineWindowsFromDuration(meta.durationSeconds ?? 180);

        setStageIndex(3);
        const prompt = buildPrompt(meta, transcriptWindows, "uploaded local video file", clipCount);
        const aiOutput = aiModel ? await complete(prompt) : "";

        const parsed = parseAIClipPayload(aiOutput || "", clipCount);
        // Scale fallback sample timestamps into the uploaded file's duration so
        // the UI still produces usable ranges without a YouTube link.
        const duration = meta.durationSeconds ?? 180;
        const fallbackCandidates = buildFallbackCandidates(clipCount, duration);
        const candidates = parsed?.length ? parsed : fallbackCandidates;
        const timingWindows = parsed?.length ? transcriptWindows : buildTimelineWindowsFromDuration(duration);

        setStageIndex(4);
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        const built = buildClipCards(candidates, timingWindows);
        setClips(built);
        setAiSummary(
          parsed?.length
            ? `Claude Sonnet 5 scored the uploaded video's timeline and returned ${built.length} clip${built.length === 1 ? "" : "s"} sized to complete thoughts. Upload-only mode has no captions, so boundaries follow timeline windows — add a YouTube link with captions for sentence-perfect cuts.`
            : `AI scaffolding is active, and the UI fell back to ${built.length} local timeline moment${built.length === 1 ? "" : "s"} from your uploaded file because a structured response was not available for this run.`,
        );
        return;
      }

      const meta = await fetchYouTubeMeta(currentVideoId);
      setVideoMeta(meta);
      setStageIndex(1);

      setAiSummary("Fetching this video's real captions so AI scores actual speech and cuts on full sentences...");
      const realTranscript = await fetchYouTubeTranscript(currentVideoId);
      const usedRealTranscript = Boolean(realTranscript?.windows.length);
      const fullWindows = usedRealTranscript ? realTranscript!.windows : SAMPLE_WINDOWS;
      const fullCues = usedRealTranscript ? realTranscript!.cues : [];
      // More windows = better moment diversity; cues stay available for snap.
      const transcriptWindows = usedRealTranscript
        ? sampleWindowsAcrossTimeline(fullWindows, 100)
        : SAMPLE_WINDOWS;
      setStageIndex(2);

      const prompt = buildPrompt(meta, transcriptWindows, "YouTube video transcript", clipCount);
      setStageIndex(3);
      const aiOutput = aiModel ? await complete(prompt) : "";

      const parsed = parseAIClipPayload(aiOutput || "", clipCount);
      const candidates = parsed?.length ? parsed : buildFallbackCandidates(clipCount);
      // Fallback candidates carry timestamps written against SAMPLE_WINDOWS;
      // only time real AI picks against the (possibly real) transcript windows.
      // Use the FULL cue list for snapping so edges can land on exact sentences
      // even when the prompt only saw a sampled subset of windows.
      const timingWindows = parsed?.length ? (usedRealTranscript ? fullWindows : transcriptWindows) : SAMPLE_WINDOWS;
      const snapCues = parsed?.length && usedRealTranscript ? fullCues : [];

      setStageIndex(4);
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      const built = buildClipCards(candidates, timingWindows, snapCues);
      setClips(built);
      setAiSummary(parsed?.length
        ? usedRealTranscript
          ? `Claude Sonnet 5 scored this video's real transcript and returned ${built.length} clip${built.length === 1 ? "" : "s"}. Each range was snapped onto caption cues so cuts open on a fresh thought and close after a finished sentence.`
          : `No captions were available for this video, so Claude Sonnet 5 scored representative sample windows and returned ${built.length} clip${built.length === 1 ? "" : "s"}.`
        : `AI scaffolding is active, and the UI fell back to ${built.length} local sample moment${built.length === 1 ? "" : "s"} because a structured response was not available for this run.`);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "The local analysis run failed.");
    } finally {
      setIsProcessing(false);
    }
  };

  const pipeline = [
    {
      title: "1. Ingest video locally",
      text: "Resolve the video ID, fetch metadata, and prepare a local source for transcription without adding a database.",
      icon: Link2,
    },
    {
      title: "2. Transcribe the full timeline",
      text: "Use Whisper or another speech-to-text engine so every sentence has precise timestamps.",
      icon: PlayCircle,
    },
    {
      title: "3. Score viral windows with AI",
      text: "Use AI to rank hooks, surprise, tension, payoff, and replay value across the entire transcript.",
      icon: ScanSearch,
    },
    {
      title: "4. Cut only complete moments",
      text: "Clip starts and ends should wrap whole thoughts so no payoff is chopped off by a fixed timer.",
      icon: Scissors,
    },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 shadow-sm shadow-primary/10">
              <img src="https://appdirect.com/shortcut-icon.ico" alt="App icon" className="size-6 rounded-sm" />
            </div>
            <div>
              <p className="font-display text-lg font-semibold tracking-tight">ClipCraft Local</p>
              <p className="text-sm text-muted-foreground">Devs.ai private clip workflow · AI-ranked viral moments</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="secondary" className="hidden rounded-full border border-border/70 px-3 py-1 text-xs sm:inline-flex">
              Local-only · AI assisted · No database
            </Badge>
            <ThemeToggle theme={theme} onToggle={() => setTheme((current) => (current === "light" ? "dark" : "light"))} />
          </div>
        </div>
      </header>

      <main className="relative overflow-hidden">
        <DotPattern className="pointer-events-none absolute inset-x-0 top-0 h-[540px] opacity-50 [mask-image:radial-gradient(ellipse_at_top,white,transparent_75%)]" />

        <section className="mx-auto max-w-7xl px-4 pb-8 pt-10 sm:px-6 lg:px-8 lg:pt-14">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)] lg:items-start">
            <BlurFade inView className="space-y-6">
              <Badge className="rounded-full bg-primary/10 px-3 py-1 text-primary hover:bg-primary/10">
                AI clip finder · content-aware duration
              </Badge>
              <div className="space-y-4">
                <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
                  Find <span className="text-primary">viral moments</span> from a link or an uploaded video.
                </h1>
                <p className="max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
                  Paste a YouTube URL or upload a video file you own. AI ranks the best complete moments, sizes each clip to the payoff, and lets you manually trim start/end times before exporting a 9:16 Shorts frame.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <MagicCard className="rounded-3xl border border-border/60 bg-card/80 p-5 shadow-sm">
                  <p className="text-sm text-muted-foreground">AI-scored moments</p>
                  <p className="mt-3 text-3xl font-semibold tracking-tight">
                    <NumberTicker value={clips.length > 0 ? clips.length : clipCount} />
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {clips.length > 0
                      ? "Complete clips ranked from this session’s timeline."
                      : `Up to ${clipCount} complete clips from the full timeline.`}
                  </p>
                </MagicCard>
                <MagicCard className="rounded-3xl border border-border/60 bg-card/80 p-5 shadow-sm">
                  <p className="text-sm text-muted-foreground">Clip runtime</p>
                  <p className="mt-3 text-3xl font-semibold tracking-tight">Auto-fit</p>
                  <p className="mt-2 text-sm text-muted-foreground">Durations expand or contract so the idea lands cleanly.</p>
                </MagicCard>
                <MagicCard className="rounded-3xl border border-border/60 bg-card/80 p-5 shadow-sm">
                  <p className="text-sm text-muted-foreground">Preview mode</p>
                  <p className="mt-3 text-3xl font-semibold tracking-tight"><NumberTicker value={100} />%</p>
                  <p className="mt-2 text-sm text-muted-foreground">YouTube embeds or local uploaded-file previews open per clip with exact start/end times.</p>
                </MagicCard>
              </div>
            </BlurFade>

            <BlurFade inView delay={0.1} className="relative lg:sticky lg:top-24">
              <Card className="relative overflow-hidden rounded-[28px] border border-primary/20 bg-card/90 shadow-2xl shadow-primary/10 backdrop-blur">
                <BorderBeam size={280} duration={9} delay={1} />
                <CardHeader className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="text-2xl tracking-tight">Clip session</CardTitle>
                      <CardDescription className="mt-1">
                        Upload a file or paste a YouTube link. AI ranks viral moments — both inputs are optional if the other is set.
                      </CardDescription>
                    </div>
                    <div className="shrink-0 rounded-2xl border border-border/70 bg-secondary px-3 py-2 text-right text-sm">
                      <p className="font-medium">Progress</p>
                      <p className="tabular-nums text-muted-foreground">{progress}%</p>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-3 rounded-2xl border border-dashed border-primary/25 bg-primary/5 p-4 transition-colors">
                    <div className="flex items-center justify-between gap-3">
                      <label className="text-sm font-medium">Video file</label>
                      {uploadedFile ? (
                        <button
                          type="button"
                          onClick={clearUploadedFile}
                          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
                        >
                          <X className="size-3" />
                          Remove
                        </button>
                      ) : null}
                    </div>
                    <input
                      ref={uploadInputRef}
                      type="file"
                      accept="video/*"
                      className="hidden"
                      onChange={(event) => handleUploadSelected(event.target.files?.[0] ?? null)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 w-full justify-start gap-2 overflow-hidden rounded-xl border-border/70 bg-background/80 text-left"
                      onClick={() => uploadInputRef.current?.click()}
                    >
                      <Upload className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        {uploadedFile ? uploadedFile.name : "Choose a video to analyze"}
                      </span>
                      {uploadedFile ? (
                        <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
                          {formatFileSize(uploadedFile.size)}
                        </span>
                      ) : null}
                    </Button>
                    <p className="min-h-[2.5rem] text-xs leading-5 text-muted-foreground">
                      {uploadedFile
                        ? "Ready on this device. Trimming runs in your browser — nothing is uploaded to a server."
                        : "Own the rights to the file. Large videos are fine; clips are cut locally in the browser."}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      YouTube link{" "}
                      <span className="font-normal text-muted-foreground">(optional with a file)</span>
                    </label>
                    <Input
                      value={youtubeUrl}
                      onChange={(event) => {
                        setYoutubeUrl(event.target.value);
                        setError("");
                      }}
                      placeholder="https://www.youtube.com/watch?v=..."
                      className="h-11 rounded-2xl border-border/70 bg-background/80"
                    />
                    <p className="min-h-[2.5rem] text-xs leading-5 text-muted-foreground">
                      {uploadedFile
                        ? "Optional. Leave blank for upload-only analysis, or add a link for captions and embeds."
                        : "Optional if you upload a file. Use only videos you own or are authorized to repurpose."}
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Moments</label>
                      <Select
                        value={String(clipCount)}
                        onValueChange={(value) => setClipCount(Number(value) as ClipCount)}
                      >
                        <SelectTrigger className="h-11 w-full rounded-2xl border-border/70 bg-background/80">
                          <SelectValue placeholder="How many" />
                        </SelectTrigger>
                        <SelectContent>
                          {CLIP_COUNT_OPTIONS.map((count) => (
                            <SelectItem key={count} value={String(count)}>
                              {count} clips
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Output</label>
                      <Select value={platform} onValueChange={setPlatform}>
                        <SelectTrigger className="h-11 w-full rounded-2xl border-border/70 bg-background/80">
                          <SelectValue placeholder="Select platform" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="shorts">YouTube Shorts</SelectItem>
                          <SelectItem value="reels">Instagram Reels</SelectItem>
                          <SelectItem value="square">Square social</SelectItem>
                          <SelectItem value="podcast">Landscape podcast</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Captions</label>
                      <Select value={captionPreset} onValueChange={setCaptionPreset}>
                        <SelectTrigger className="h-11 w-full rounded-2xl border-border/70 bg-background/80">
                          <SelectValue placeholder="Select captions" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="bold">Bold punch</SelectItem>
                          <SelectItem value="bar">Subtitle bar</SelectItem>
                          <SelectItem value="clean">Lower thirds</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-primary/15 bg-primary/6 px-4 py-3 text-sm">
                    <p className="font-medium text-foreground">Auto-fit length · {clipCount} moments</p>
                    <p className="mt-1 leading-5 text-muted-foreground">
                      AI ranks the top {clipCount} complete moments and sizes each cut to the payoff — not a fixed timer.
                    </p>
                  </div>

                  <div className="flex flex-col gap-3 sm:flex-row">
                    <ShimmerButton
                      className="h-12 rounded-2xl px-6 text-sm font-medium"
                      background="var(--color-primary)"
                      shimmerColor="#ffffff"
                      onClick={handleGenerate}
                      disabled={isProcessing || isAILoading || !canGenerate}
                    >
                      <span className="inline-flex items-center gap-2 text-primary-foreground">
                        {isProcessing || isAILoading ? <LoaderCircle className="size-4 animate-spin" /> : <WandSparkles className="size-4" />}
                        Search viral parts with AI
                      </span>
                    </ShimmerButton>
                    <Button
                      variant="outline"
                      className="h-12 rounded-2xl border-border/70 bg-background/70 px-6"
                      onClick={() => {
                        setClips([]);
                        setError("");
                        setIsProcessing(false);
                        setStageIndex(-1);
                        setVideoMeta(null);
                        setYoutubeUrl("");
                        setClipCount(5);
                        clearUploadedFile();
                        setAiSummary("AI will analyze a YouTube link or an uploaded video timeline to find the moments most likely to hold attention, trigger comments, and deliver a clean payoff.");
                      }}
                    >
                      Reset session
                    </Button>
                  </div>

                  {error ? (
                    <div className="flex items-start gap-3 rounded-2xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
                      <AlertCircle className="mt-0.5 size-4 shrink-0" />
                      <p>{error}</p>
                    </div>
                  ) : null}

                  {(aiError && !error) ? (
                    <div className="flex items-start gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300">
                      <AlertCircle className="mt-0.5 size-4 shrink-0" />
                      <p>
                        {aiError.includes("401")
                          ? "The AI connection (Claude Sonnet 5) was unauthorized for this run — the API key may need to be reconnected. Retry now, or the UI will continue with local sample moments."
                          : `The AI proxy (Claude Sonnet 5) responded with an error, so the app can fall back to local sample moments for UI testing: ${aiError}`}
                      </p>
                    </div>
                  ) : null}

                  <div className="rounded-3xl border border-border/70 bg-background/70 p-4">
                    <div className="mb-3 flex items-center justify-between gap-4">
                      <p className="text-sm font-medium">Session state</p>
                      <Badge variant={isProcessing ? "default" : clips.length ? "secondary" : "outline"} className="rounded-full px-3 py-1">
                        {isProcessing ? "Analyzing" : clips.length ? `${clips.length} ready` : "Waiting for run"}
                      </Badge>
                    </div>
                    <div className="min-h-[8.5rem] space-y-3">
                      {isProcessing ? (
                        <div className="rounded-2xl border border-border/60 bg-card/80 p-4">
                          <div className="mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                            <span>Step {Math.min(stageIndex + 1, activeStages.length)} of {activeStages.length}</span>
                            <span className="tabular-nums">{progress}%</span>
                          </div>
                          <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                              style={{ width: `${progress}%` }}
                            />
                          </div>
                          <div className="flex items-start gap-3">
                            <Clock3 className="mt-0.5 size-4 shrink-0 animate-pulse text-primary" />
                            <div className="min-w-0">
                              <p className="text-sm font-medium">{activeStages[Math.min(stageIndex, activeStages.length - 1)]}</p>
                              <p className="mt-1 text-xs text-muted-foreground">Scoring moments and preparing clip ranges…</p>
                            </div>
                          </div>
                        </div>
                      ) : clips.length ? (
                        <div className="rounded-2xl border border-primary/20 bg-primary/8 p-4">
                          <p className="text-sm font-medium">AI analysis complete · {clips.length} moments</p>
                          <p className="mt-1 text-sm leading-6 text-muted-foreground">{aiSummary}</p>
                        </div>
                      ) : (
                        <div className="rounded-2xl border border-dashed border-border/70 bg-card/60 p-4">
                          <p className="text-sm font-medium">No analysis running yet</p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            Pick a source and moment count, then run AI analysis for ranked clip candidates.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </BlurFade>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-start">
            <BlurFade inView delay={0.15} className="lg:sticky lg:top-24">
              <Card className="rounded-[28px] border-border/70 bg-card/85 shadow-sm">
                <CardHeader>
                  <CardTitle className="text-2xl tracking-tight">How the local flow works</CardTitle>
                  <CardDescription>
                    AI ranking, content-aware clip sizing, and working previews — all without a database.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {pipeline.map((item) => {
                    const Icon = item.icon;
                    return (
                      <div key={item.title} className="flex gap-4 rounded-2xl border border-border/60 bg-background/70 p-4">
                        <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                          <Icon className="size-5" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold">{item.title}</p>
                          <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.text}</p>
                        </div>
                      </div>
                    );
                  })}

                  <div className="rounded-2xl border border-border/60 bg-background/70 p-4">
                    <div className="flex items-center gap-3">
                      <Sparkles className="size-5 text-primary" />
                      <p className="text-sm font-semibold">AI scoring is live</p>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      Choose how many moments to return (3–12). The model ranks complete hooks from the timeline and sizes each cut to the payoff.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </BlurFade>

            <BlurFade inView delay={0.2}>
              <Card className="rounded-[28px] border-border/70 bg-card/85 shadow-sm">
                <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <CardTitle className="text-2xl tracking-tight">Clip candidates</CardTitle>
                    <CardDescription>
                      {clips.length > 0
                        ? `${clips.length} ranked moment${clips.length === 1 ? "" : "s"} ready to preview and download.`
                        : `Up to ${clipCount} moments after AI transcript scoring.`}
                    </CardDescription>
                  </div>
                  <Badge variant="outline" className="rounded-full px-3 py-1 text-xs">
                    {clips.length > 0 ? `${clips.length} clips` : `${clipCount} requested`}
                  </Badge>
                </CardHeader>
                <CardContent>
                  {isProcessing ? (
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                      {Array.from({ length: Math.min(clipCount, 6) }).map((_, index) => (
                        <div key={index} className="overflow-hidden rounded-[24px] border border-border/60 bg-background/70 p-4">
                          <div className="aspect-[9/16] animate-pulse rounded-[18px] bg-muted/80" />
                          <div className="mt-4 space-y-3">
                            <div className="h-4 w-3/4 animate-pulse rounded-full bg-muted" />
                            <div className="h-4 w-1/2 animate-pulse rounded-full bg-muted" />
                            <div className="h-20 animate-pulse rounded-2xl bg-muted/80" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : clips.length === 0 ? (
                    <div className="flex min-h-[280px] flex-col items-center justify-center rounded-[28px] border border-dashed border-border/70 bg-background/60 px-6 text-center">
                      <Film className="mb-4 size-10 text-muted-foreground" />
                      <h3 className="text-xl font-semibold tracking-tight">No clips generated yet</h3>
                      <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                        Upload a video or paste a YouTube link, pick how many moments you want, then run AI analysis.
                      </p>
                    </div>
                  ) : (
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                      {clips.map((clip) => (
                        <MagicCard key={clip.id} className="rounded-[24px] border border-border/70 bg-background/80 p-4 shadow-sm">
                          <div className="relative overflow-hidden rounded-[20px] border border-primary/15 bg-[linear-gradient(180deg,rgba(66,112,240,0.18),rgba(66,112,240,0.04))]">
                            {videoMeta?.thumbnailUrl ? (
                              <img
                                src={videoMeta.thumbnailUrl}
                                alt={videoMeta.title}
                                className="aspect-[9/16] w-full object-cover opacity-70"
                                style={{
                                  objectPosition: `${(clip.focusX * 100).toFixed(1)}% ${(clip.focusY * 100).toFixed(1)}%`,
                                }}
                              />
                            ) : uploadedPreviewUrl ? (
                              <video
                                src={uploadedPreviewUrl}
                                className="aspect-[9/16] w-full object-cover opacity-70"
                                style={{
                                  objectPosition: `${(clip.focusX * 100).toFixed(1)}% ${(clip.focusY * 100).toFixed(1)}%`,
                                }}
                                muted
                                playsInline
                                preload="metadata"
                              />
                            ) : (
                              <div className="aspect-[9/16] bg-muted/70" />
                            )}
                            <div className="absolute inset-0 flex flex-col justify-between p-4">
                              <div className="flex items-center justify-between gap-2">
                                <Badge className="rounded-full bg-background/90 px-3 py-1 text-foreground shadow-sm">{clip.format}</Badge>
                                <Badge variant="secondary" className="rounded-full px-3 py-1">Score {clip.score}</Badge>
                              </div>
                              <div className="rounded-2xl bg-background/78 p-3 backdrop-blur-sm">
                                <p className="text-xs uppercase tracking-[0.22em] text-primary/80">AI hook preview</p>
                                <p className="mt-2 text-lg font-semibold leading-6 tracking-tight">{clip.hook}</p>
                              </div>
                            </div>
                          </div>
                          <div className="mt-4 space-y-3">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <h3 className="text-lg font-semibold tracking-tight">{clip.title}</h3>
                                <p className="mt-1 text-sm text-muted-foreground">
                                  {formatTime(clip.startSeconds)} → {formatTime(clip.endSeconds)} · {formatTime(clip.durationSeconds)}
                                  {(Math.abs(clip.startSeconds - clip.originalStartSeconds) > 0.05 ||
                                    Math.abs(clip.endSeconds - clip.originalEndSeconds) > 0.05) && (
                                    <span className="ml-1.5 text-primary">· edited</span>
                                  )}
                                  {(clip.focusKeyframes.length > 1
                                    ? true
                                    : Math.abs(clip.focusX - 0.5) > 0.02 ||
                                      Math.abs(clip.focusY - 0.5) > 0.02) && (
                                    <span className="ml-1.5 text-primary">
                                      {clip.focusKeyframes.length > 1 ? "· tracking" : "· reframed"}
                                    </span>
                                  )}
                                </p>
                              </div>
                              <PlayCircle className="mt-1 size-5 text-primary" />
                            </div>
                            <p className="text-sm leading-6 text-muted-foreground">{clip.reason}</p>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">Caption preset</span>
                              <span className="font-medium">{clip.captionStyle}</span>
                            </div>
                            <ClipPreviewDialog
                              clip={clip}
                              videoTitle={videoMeta?.title ?? uploadedFile?.name}
                              currentVideoId={currentVideoId}
                              uploadedPreviewUrl={uploadedPreviewUrl}
                              thumbnailUrl={videoMeta?.thumbnailUrl}
                              hasUploadedFile={Boolean(uploadedFile)}
                              hasYouTubeLink={hasYouTubeLink}
                              getClipEmbedUrl={getClipEmbedUrl}
                              formatTime={formatTime}
                              formatTimePrecise={formatTimePrecise}
                              parseTimestamp={parseTimestamp}
                              mediaDurationSeconds={mediaDurationSeconds}
                              onUpdateTiming={updateClipTiming}
                              onResetTiming={resetClipTiming}
                              onUpdateFocus={updateClipFocus}
                              onResetFocus={resetClipFocus}
                              onRender={handleRenderClip}
                              onDownloadBrief={handleDownloadClipBrief}
                              onUploadClick={() => uploadInputRef.current?.click()}
                              renderState={
                                renderState[clip.id] === "rendering" || uploadRenderState[clip.id] === "rendering"
                                  ? "rendering"
                                  : renderState[clip.id] === "error" || uploadRenderState[clip.id] === "error"
                                    ? "error"
                                    : "idle"
                              }
                              renderError={uploadRenderErrors[clip.id] ?? renderErrors[clip.id]}
                              renderStatus={uploadRenderStatus[clip.id]}
                            />
                          </div>
                        </MagicCard>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </BlurFade>
          </div>
        </section>
      </main>
    </div>
  );
}
