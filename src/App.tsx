import { useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Film,
  Gauge,
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

import { ThemeToggle } from "@/components/theme-toggle";
import { downloadBlob } from "@/lib/download";
import { Badge } from "@/components/ui/badge";
import { BlurFade } from "@/components/ui/blur-fade";
import { BorderBeam } from "@/components/ui/border-beam";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import { Separator } from "@/components/ui/separator";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { useCompletion } from "@/lib/devs-ai/use-completion";

interface TranscriptWindow {
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
];

const isYouTubeUrl = (value: string) => /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/i.test(value.trim());

const formatTime = (totalSeconds: number) => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  if (hours > 0) {
    return [hours, minutes, seconds].map((value) => value.toString().padStart(2, "0")).join(":");
  }

  return [minutes, seconds].map((value) => value.toString().padStart(2, "0")).join(":");
};

const findBestWindowIndex = (windows: TranscriptWindow[], seconds: number) => {
  const directMatch = windows.findIndex((window) => seconds >= window.startSeconds && seconds <= window.endSeconds);
  if (directMatch >= 0) return directMatch;

  return windows.reduce((bestIndex, window, index) => {
    const midpoint = (window.startSeconds + window.endSeconds) / 2;
    const bestMidpoint = (windows[bestIndex].startSeconds + windows[bestIndex].endSeconds) / 2;
    return Math.abs(midpoint - seconds) < Math.abs(bestMidpoint - seconds) ? index : bestIndex;
  }, 0);
};

const deriveClipTiming = (candidate: AICandidate, windows: TranscriptWindow[]) => {
  if (windows.length === 0) {
    const endSeconds = Math.max(candidate.endSeconds, candidate.startSeconds + 15);
    return {
      startSeconds: candidate.startSeconds,
      endSeconds,
      durationSeconds: endSeconds - candidate.startSeconds,
      transcriptExcerpt: candidate.hook,
    };
  }

  let startIndex = findBestWindowIndex(windows, candidate.startSeconds);
  let endIndex = findBestWindowIndex(windows, candidate.endSeconds);

  if (endIndex < startIndex) {
    [startIndex, endIndex] = [endIndex, startIndex];
  }

  let startSeconds = Math.min(candidate.startSeconds, windows[startIndex].startSeconds);
  let endSeconds = Math.max(candidate.endSeconds, windows[endIndex].endSeconds);

  while (endSeconds - startSeconds < 18 && endIndex < windows.length - 1) {
    endIndex += 1;
    endSeconds = windows[endIndex].endSeconds;
  }

  while (endSeconds - startSeconds < 18 && startIndex > 0) {
    startIndex -= 1;
    startSeconds = windows[startIndex].startSeconds;
  }

  while (endSeconds - startSeconds > 70 && endIndex > startIndex) {
    endIndex -= 1;
    endSeconds = Math.max(candidate.endSeconds, windows[endIndex].endSeconds);
  }

  const transcriptExcerpt = windows
    .slice(startIndex, endIndex + 1)
    .map((window) => window.text)
    .join(" ");

  return {
    startSeconds,
    endSeconds,
    durationSeconds: endSeconds - startSeconds,
    transcriptExcerpt,
  };
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

const buildPrompt = (meta: VideoMeta | null, windows: TranscriptWindow[], sourceLabel = "video transcript") => {
  const transcript = windows
    .map((window, index) => `${index + 1}. ${formatTime(window.startSeconds)}-${formatTime(window.endSeconds)} | ${window.text}`)
    .join("\n");

  return `You are ranking viral short-form clip candidates from a ${sourceLabel}.\n\nVideo title: ${meta?.title ?? "Unknown"}\nChannel: ${meta?.author ?? "Unknown"}\nDuration: ${meta?.durationSeconds ? formatTime(meta.durationSeconds) : "unknown"}\n\nRules:\n- Pick the 3 best standalone clips.\n- Determine natural clip lengths from the content itself; do not force a fixed duration.\n- Never cut off setup, payoff, or the final key sentence.\n- Favor strong hooks, tension, surprise, emotional payoff, concrete lessons, disagreement potential, and replay value.\n- Keep clips between 15 and 70 seconds when possible.\n- Prefer moments spread across the timeline rather than clustering near the start.\n- Return valid JSON only in this exact shape:\n{\n  "clips": [\n    {\n      "title": "...",\n      "hook": "...",\n      "reason": "...",\n      "startSeconds": 0,\n      "endSeconds": 0,\n      "score": 0\n    }\n  ]\n}\n\nTimeline windows:\n${transcript}`;
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

async function fetchYouTubeTranscript(videoId: string): Promise<TranscriptWindow[] | null> {
  if (!videoId) return null;

  try {
    const response = await fetch("/api/youtube/transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId }),
    });
    if (!response.ok) return null;

    const data = await response.json();
    if (Array.isArray(data.windows) && data.windows.length > 0) {
      return data.windows as TranscriptWindow[];
    }
    return null;
  } catch {
    return null;
  }
}

// Full-length transcripts can run for hours; capped, evenly-spaced sampling
// keeps the prompt a sane size while still giving the AI visibility into the
// beginning, middle, and end of the video instead of only its first chunk.
const sampleWindowsAcrossTimeline = (windows: TranscriptWindow[], maxCount: number): TranscriptWindow[] => {
  if (windows.length <= maxCount) return windows;
  const step = windows.length / maxCount;
  const sampled: TranscriptWindow[] = [];
  for (let i = 0; i < maxCount; i += 1) {
    sampled.push(windows[Math.floor(i * step)]);
  }
  return sampled;
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

const parseAIClipPayload = (raw: string): AICandidate[] | null => {
  const cleaned = raw.trim();
  const jsonCandidate = cleaned.match(/\{[\s\S]*\}/)?.[0] ?? cleaned;

  try {
    const parsed = JSON.parse(jsonCandidate) as { clips?: AICandidate[] };
    if (!Array.isArray(parsed.clips)) return null;
    return parsed.clips
      .filter((clip) => typeof clip.title === "string" && typeof clip.hook === "string")
      .map((clip) => ({
        title: clip.title,
        hook: clip.hook,
        reason: clip.reason,
        startSeconds: Number(clip.startSeconds),
        endSeconds: Number(clip.endSeconds),
        score: Number(clip.score),
      }))
      .filter((clip) => Number.isFinite(clip.startSeconds) && Number.isFinite(clip.endSeconds) && clip.endSeconds > clip.startSeconds)
      .slice(0, 3);
  } catch {
    return null;
  }
};

const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "clip";

// Server-rendering needs raw bytes, but the dev/prod API proxy already reads
// every request body as JSON — sending the file as a base64 string keeps the
// upload path on the exact same request/response shape as every other route
// in this app instead of introducing a separate multipart parser.
const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });

const formatFileSize = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// Vercel serverless functions cap request bodies to a few MB; base64 also
// inflates size ~33%. This client-side cap fails fast with a clear message
// instead of letting a large upload silently 413 on the server.
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    return window.localStorage.getItem("clipcraft-theme") === "dark" ? "dark" : "light";
  });
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [platform, setPlatform] = useState("shorts");
  const [captionPreset, setCaptionPreset] = useState("bold");
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

  const buildClipCards = (candidates: AICandidate[], timingWindows: TranscriptWindow[]) => {
    return candidates.map((candidate, index) => {
      const timing = deriveClipTiming(candidate, timingWindows);
      return {
        id: index + 1,
        title: candidate.title,
        hook: candidate.hook,
        reason: candidate.reason,
        startSeconds: timing.startSeconds,
        endSeconds: timing.endSeconds,
        durationSeconds: timing.durationSeconds,
        score: Math.max(1, Math.min(99, Math.round(candidate.score))),
        format: getFormatForPlatform(platform),
        captionStyle: getCaptionLabel(captionPreset),
        transcriptExcerpt: timing.transcriptExcerpt,
      } satisfies Clip;
    });
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
        start: formatTime(clip.startSeconds),
        end: formatTime(clip.endSeconds),
        duration: formatTime(clip.durationSeconds),
        score: clip.score,
        format: clip.format,
        captionStyle: clip.captionStyle,
        transcriptExcerpt: clip.transcriptExcerpt,
        previewUrl: currentVideoId ? getClipEmbedUrl(currentVideoId, clip) : null,
        youtubeUrl: currentVideoId
          ? `https://www.youtube.com/watch?v=${currentVideoId}&t=${Math.floor(clip.startSeconds)}s`
          : null,
      },
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    downloadBlob(blob, `${slugify(clip.title)}-clip-brief.json`);
  };

  // Trims the clip directly from a user-uploaded source video. This never
  // touches YouTube's servers, so it works for upload-only sessions and as a
  // reliable fallback when YouTube bot-checks the datacenter download path.
  const handleRenderFromUpload = async (clip: Clip) => {
    if (!uploadedFile) return;

    setUploadRenderState((prev) => ({ ...prev, [clip.id]: "rendering" }));
    setRenderState((prev) => ({ ...prev, [clip.id]: "rendering" }));
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
      if (uploadedFile.size > MAX_UPLOAD_BYTES) {
        throw new Error(
          `That file is ${formatFileSize(uploadedFile.size)} — larger than the ${formatFileSize(MAX_UPLOAD_BYTES)} limit for this preview. Trim the source file shorter, or lower its resolution, before uploading.`,
        );
      }

      const fileBase64 = await fileToBase64(uploadedFile);
      const response = await fetch("/api/clip/render-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileBase64,
          mimeType: uploadedFile.type || "video/mp4",
          startSeconds: clip.startSeconds,
          endSeconds: clip.endSeconds,
          title: clip.title,
        }),
      });

      if (!response.ok) {
        let message = `Rendering from the uploaded file failed (${response.status}).`;
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
      setUploadRenderState((prev) => ({ ...prev, [clip.id]: "idle" }));
      setRenderState((prev) => ({ ...prev, [clip.id]: "idle" }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Rendering from the uploaded file failed.";
      setUploadRenderState((prev) => ({ ...prev, [clip.id]: "error" }));
      setRenderState((prev) => ({ ...prev, [clip.id]: "error" }));
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
        if (uploadedFile.size > MAX_UPLOAD_BYTES) {
          throw new Error(
            `That file is ${formatFileSize(uploadedFile.size)} — larger than the ${formatFileSize(MAX_UPLOAD_BYTES)} limit for this preview. Trim the source file shorter, or lower its resolution, before uploading.`,
          );
        }

        setStageIndex(1);
        const meta = await readUploadedVideoMeta(uploadedFile);
        setVideoMeta(meta);

        setStageIndex(2);
        setAiSummary("Building clip windows from the uploaded file timeline...");
        const transcriptWindows = buildTimelineWindowsFromDuration(meta.durationSeconds ?? 180);

        setStageIndex(3);
        const prompt = buildPrompt(meta, transcriptWindows, "uploaded local video file");
        const aiOutput = aiModel ? await complete(prompt) : "";

        const parsed = parseAIClipPayload(aiOutput || "");
        // Scale fallback sample timestamps into the uploaded file's duration so
        // the UI still produces usable ranges without a YouTube link.
        const duration = meta.durationSeconds ?? 180;
        const fallbackCandidates = FALLBACK_CLIPS.map((candidate, index) => {
          const span = Math.min(36, Math.max(18, Math.floor(duration / 5)));
          const startSeconds = Math.min(
            Math.max(0, Math.floor(duration * ((index + 1) / (FALLBACK_CLIPS.length + 1))) - Math.floor(span / 2)),
            Math.max(0, Math.floor(duration) - span),
          );
          return {
            ...candidate,
            startSeconds,
            endSeconds: startSeconds + span,
          };
        });
        const candidates = parsed?.length ? parsed : fallbackCandidates;
        const timingWindows = parsed?.length ? transcriptWindows : buildTimelineWindowsFromDuration(duration);

        setStageIndex(4);
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        setClips(buildClipCards(candidates, timingWindows));
        setAiSummary(
          parsed?.length
            ? "Claude Sonnet 5 scored the uploaded video's timeline and kept clip lengths flexible so each cut ends on a full idea. No YouTube link was needed."
            : "AI scaffolding is active, and the UI fell back to local timeline moments from your uploaded file because a structured response was not available for this run.",
        );
        return;
      }

      const meta = await fetchYouTubeMeta(currentVideoId);
      setVideoMeta(meta);
      setStageIndex(1);

      setAiSummary("Fetching this video's real captions so AI scores actual content instead of samples...");
      const realTranscript = await fetchYouTubeTranscript(currentVideoId);
      const usedRealTranscript = Boolean(realTranscript?.length);
      const transcriptWindows = usedRealTranscript
        ? sampleWindowsAcrossTimeline(realTranscript as TranscriptWindow[], 80)
        : SAMPLE_WINDOWS;
      setStageIndex(2);

      const prompt = buildPrompt(meta, transcriptWindows, "YouTube video transcript");
      setStageIndex(3);
      const aiOutput = aiModel ? await complete(prompt) : "";

      const parsed = parseAIClipPayload(aiOutput || "");
      const candidates = parsed?.length ? parsed : FALLBACK_CLIPS;
      // Fallback candidates carry timestamps written against SAMPLE_WINDOWS;
      // only time real AI picks against the (possibly real) transcript windows.
      const timingWindows = parsed?.length ? transcriptWindows : SAMPLE_WINDOWS;

      setStageIndex(4);
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      setClips(buildClipCards(candidates, timingWindows));
      setAiSummary(parsed?.length
        ? usedRealTranscript
          ? "Claude Sonnet 5 scored this video's real transcript and kept clip lengths flexible so each cut ends on a full idea."
          : "No captions were available for this video, so Claude Sonnet 5 scored representative sample transcript windows instead of the real timeline."
        : "AI scaffolding is active, and the UI fell back to local sample moments because a structured response was not available for this run.");
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

        <section className="mx-auto max-w-7xl px-4 pb-8 pt-10 sm:px-6 lg:px-8 lg:pt-16">
          <div className="grid gap-8 lg:grid-cols-[1.18fr_0.82fr] lg:items-start">
            <BlurFade inView className="space-y-6">
              <Badge className="rounded-full bg-primary/10 px-3 py-1 text-primary hover:bg-primary/10">
                AI clip finder · content-aware duration
              </Badge>
              <div className="space-y-4">
                <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
                  Find <span className="text-primary">viral moments</span> from a link or an uploaded video.
                </h1>
                <p className="max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
                  Paste a YouTube URL or upload a video file you own. AI ranks the best complete moments, sizes each clip to the payoff, and lets you preview and download without forcing both inputs.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <MagicCard className="rounded-3xl border border-border/60 bg-card/80 p-5 shadow-sm">
                  <p className="text-sm text-muted-foreground">AI-scored moments</p>
                  <p className="mt-3 text-3xl font-semibold tracking-tight"><NumberTicker value={3} /></p>
                  <p className="mt-2 text-sm text-muted-foreground">Best complete clips selected from the full transcript timeline.</p>
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

            <BlurFade inView delay={0.1} className="relative">
              <Card className="relative overflow-hidden rounded-[28px] border border-primary/20 bg-card/90 shadow-2xl shadow-primary/10 backdrop-blur">
                <BorderBeam size={280} duration={9} delay={1} />
                <CardHeader className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <CardTitle className="text-2xl tracking-tight">Clip session</CardTitle>
                      <CardDescription>
                        Upload a video file or paste a YouTube link. AI identifies viral segments and lets you preview and download each cut — a link is optional once a file is uploaded.
                      </CardDescription>
                    </div>
                    <div className="rounded-2xl border border-border/70 bg-secondary px-3 py-2 text-right text-sm">
                      <p className="font-medium">Progress</p>
                      <p className="text-muted-foreground">{progress}%</p>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="space-y-2 rounded-2xl border border-dashed border-primary/25 bg-primary/5 p-4">
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
                      className="h-10 w-full justify-start gap-2 rounded-xl border-border/70 bg-background/80 text-left"
                      onClick={() => uploadInputRef.current?.click()}
                    >
                      <Upload className="size-4" />
                      {uploadedFile ? uploadedFile.name : "Upload a video to analyze"}
                    </Button>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {uploadedFile
                        ? `${formatFileSize(uploadedFile.size)} ready. You can generate clips and download trims from this file alone — no YouTube link required.`
                        : "Upload a file you own the rights to. Once it's here, analysis and downloads work without a YouTube link."}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">YouTube link <span className="font-normal text-muted-foreground">(optional if a file is uploaded)</span></label>
                    <Input
                      value={youtubeUrl}
                      onChange={(event) => {
                        setYoutubeUrl(event.target.value);
                        setError("");
                      }}
                      placeholder="https://www.youtube.com/watch?v=..."
                      className="h-12 rounded-2xl border-border/70 bg-background/80"
                    />
                    <p className="text-xs leading-5 text-muted-foreground">
                      {uploadedFile
                        ? "Optional. Leave blank to analyze and render from the uploaded file only. Add a link if you also want captions and YouTube embeds."
                        : "Optional if you upload a video below. Use only videos you own or are authorized to repurpose."}
                    </p>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Output preset</label>
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
                          <SelectItem value="bold">Bold punch captions</SelectItem>
                          <SelectItem value="bar">Creator subtitle bar</SelectItem>
                          <SelectItem value="clean">Clean lower thirds</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="rounded-3xl border border-primary/15 bg-primary/6 p-4 text-sm">
                    <p className="font-medium text-foreground">Auto-fit clip length is enabled</p>
                    <p className="mt-1 leading-6 text-muted-foreground">
                      The app now chooses clip duration from the moment itself. Instead of forcing 20/30/45-second cuts, it expands just enough to preserve the hook, the context needed for meaning, and the final payoff.
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
                        {isProcessing ? "Analyzing" : clips.length ? "Clips ready" : "Waiting for run"}
                      </Badge>
                    </div>
                    <div className="space-y-3">
                      {isProcessing ? (
                        activeStages.map((stage, index) => {
                          const complete = index < stageIndex;
                          const current = index === stageIndex;
                          return (
                            <div key={stage} className="flex items-start gap-3 rounded-2xl border border-border/60 bg-card/80 p-3">
                              {complete ? (
                                <CheckCircle2 className="mt-0.5 size-4 text-primary" />
                              ) : current ? (
                                <Clock3 className="mt-0.5 size-4 animate-pulse text-primary" />
                              ) : (
                                <Gauge className="mt-0.5 size-4 text-muted-foreground" />
                              )}
                              <div>
                                <p className="text-sm font-medium">{stage}</p>
                                <p className="text-xs text-muted-foreground">
                                  {current ? "Currently processing this stage." : complete ? "Completed." : "Queued next."}
                                </p>
                              </div>
                            </div>
                          );
                        })
                      ) : clips.length ? (
                        <div className="rounded-2xl border border-primary/20 bg-primary/8 p-4">
                          <p className="text-sm font-medium">AI analysis complete</p>
                          <p className="mt-1 text-sm text-muted-foreground">{aiSummary}</p>
                        </div>
                      ) : (
                        <div className="rounded-2xl border border-dashed border-border/70 bg-card/60 p-4">
                          <p className="text-sm font-medium">No analysis running yet</p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            Start a session to see transcript scoring, AI ranking, and preview-ready clip candidates.
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
          <div className="grid gap-6 lg:grid-cols-[0.82fr_1.18fr]">
            <BlurFade inView delay={0.15}>
              <Card className="rounded-[28px] border-border/70 bg-card/85 shadow-sm">
                <CardHeader>
                  <CardTitle className="text-2xl tracking-tight">How the upgraded local flow works</CardTitle>
                  <CardDescription>
                    The product direction now supports AI ranking, content-aware clip sizing, and working preview embeds without introducing a database.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
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
                      <p className="text-sm font-semibold">AI scoring is implemented</p>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      The app now talks to a server-side AI proxy and asks the model to return structured clip candidates based on transcript windows. For production, the only missing piece is feeding it a real transcript instead of sample windows.
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
                    <CardDescription>Preview the moments the system would cut after AI transcript scoring.</CardDescription>
                  </div>
                  <Badge variant="outline" className="rounded-full px-3 py-1 text-xs">
                    Previewable embedded renders
                  </Badge>
                </CardHeader>
                <CardContent>
                  {isProcessing ? (
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {Array.from({ length: 3 }).map((_, index) => (
                        <div key={index} className="overflow-hidden rounded-[24px] border border-border/60 bg-background/70 p-4">
                          <div className="aspect-[9/16] rounded-[18px] bg-muted/80" />
                          <div className="mt-4 space-y-3">
                            <div className="h-4 w-3/4 rounded-full bg-muted" />
                            <div className="h-4 w-1/2 rounded-full bg-muted" />
                            <div className="h-20 rounded-2xl bg-muted/80" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : clips.length === 0 ? (
                    <div className="flex min-h-[340px] flex-col items-center justify-center rounded-[28px] border border-dashed border-border/70 bg-background/60 px-6 text-center">
                      <Film className="mb-4 size-10 text-muted-foreground" />
                      <h3 className="text-xl font-semibold tracking-tight">No clips generated yet</h3>
                      <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                        Upload a video or paste a YouTube link, then run AI analysis. Ranked moments will appear here with local or embedded previews.
                      </p>
                    </div>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {clips.map((clip) => (
                        <MagicCard key={clip.id} className="rounded-[24px] border border-border/70 bg-background/80 p-4 shadow-sm">
                          <div className="relative overflow-hidden rounded-[20px] border border-primary/15 bg-[linear-gradient(180deg,rgba(66,112,240,0.18),rgba(66,112,240,0.04))]">
                            {videoMeta?.thumbnailUrl ? (
                              <img src={videoMeta.thumbnailUrl} alt={videoMeta.title} className="aspect-[9/16] w-full object-cover opacity-70" />
                            ) : uploadedPreviewUrl ? (
                              <video src={uploadedPreviewUrl} className="aspect-[9/16] w-full object-cover opacity-70" muted playsInline preload="metadata" />
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
                                </p>
                              </div>
                              <PlayCircle className="mt-1 size-5 text-primary" />
                            </div>
                            <p className="text-sm leading-6 text-muted-foreground">{clip.reason}</p>
                            <Separator />
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">Caption preset</span>
                              <span className="font-medium">{clip.captionStyle}</span>
                            </div>
                            <Dialog>
                              <DialogTrigger asChild>
                                <Button
                                  variant="outline"
                                  className="h-11 w-full rounded-2xl border-border/70 bg-background/70"
                                >
                                  Preview render
                                  <ArrowRight className="size-4" />
                                </Button>
                              </DialogTrigger>
                              <DialogContent className="max-h-[85vh] w-full max-w-3xl sm:max-w-3xl overflow-y-auto rounded-[28px] border-border/70 p-0">
                                <DialogHeader className="border-b border-border/70 px-6 py-5 text-left">
                                  <DialogTitle className="text-xl tracking-tight">{clip.title}</DialogTitle>
                                  <DialogDescription>
                                    {videoMeta?.title ?? uploadedFile?.name ?? "Clip preview"} · {formatTime(clip.startSeconds)} to {formatTime(clip.endSeconds)} · auto-fit duration {formatTime(clip.durationSeconds)}
                                  </DialogDescription>
                                </DialogHeader>
                                <div>
                                    <div className="aspect-video w-full bg-black">
                                        {currentVideoId ? (
                                          <iframe
                                            key={`${clip.id}-${clip.startSeconds}-${clip.endSeconds}`}
                                            src={getClipEmbedUrl(currentVideoId, clip)}
                                            title={clip.title}
                                            className="h-full w-full"
                                            loading="lazy"
                                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                                            referrerPolicy="strict-origin-when-cross-origin"
                                            allowFullScreen
                                          />
                                        ) : uploadedPreviewUrl ? (
                                          <video
                                            key={`${clip.id}-${clip.startSeconds}-${clip.endSeconds}-local`}
                                            src={`${uploadedPreviewUrl}#t=${Math.max(0, Math.floor(clip.startSeconds))},${Math.max(Math.ceil(clip.endSeconds), Math.floor(clip.startSeconds) + 1)}`}
                                            className="h-full w-full"
                                            controls
                                            playsInline
                                            preload="metadata"
                                          />
                                        ) : (
                                          <div className="flex h-full w-full items-center justify-center text-white/70">Upload a video or add a YouTube link to preview this clip.</div>
                                        )}
                                    </div>
                                    <div className="bg-background">
                                      <div className="space-y-4 px-6 py-5">
                                        <div>
                                          <p className="text-sm font-medium text-muted-foreground">Why AI picked this</p>
                                          <p className="mt-2 text-sm leading-6">{clip.reason}</p>
                                        </div>
                                        <div>
                                          <p className="text-sm font-medium text-muted-foreground">Transcript excerpt used for sizing</p>
                                          <p className="mt-2 text-sm leading-6 text-muted-foreground">{clip.transcriptExcerpt}</p>
                                        </div>
                                        <div className="grid grid-cols-2 gap-3 text-sm">
                                          <div className="rounded-2xl border border-border/70 bg-card p-4">
                                            <p className="text-muted-foreground">Start</p>
                                            <p className="mt-1 font-semibold">{formatTime(clip.startSeconds)}</p>
                                          </div>
                                          <div className="rounded-2xl border border-border/70 bg-card p-4">
                                            <p className="text-muted-foreground">End</p>
                                            <p className="mt-1 font-semibold">{formatTime(clip.endSeconds)}</p>
                                          </div>
                                          <div className="rounded-2xl border border-border/70 bg-card p-4">
                                            <p className="text-muted-foreground">Duration</p>
                                            <p className="mt-1 font-semibold">{formatTime(clip.durationSeconds)}</p>
                                          </div>
                                          <div className="rounded-2xl border border-border/70 bg-card p-4">
                                            <p className="text-muted-foreground">Score</p>
                                            <p className="mt-1 font-semibold">{clip.score}/99</p>
                                          </div>
                                        </div>
                                        <div className="rounded-2xl border border-primary/15 bg-primary/6 p-4 text-sm text-muted-foreground">
                                          {currentVideoId
                                            ? "This preview uses a real YouTube embed with exact start and end parameters."
                                            : uploadedFile
                                              ? "This preview plays your uploaded file locally. No YouTube link is required to review or download the cut."
                                              : "Add a YouTube link or upload a video file to preview this clip."}
                                        </div>
                                      </div>
                                      <div className="border-t border-border/70 bg-background/95 px-6 py-4">
                                        <div className="flex flex-col gap-3 sm:flex-row">
                                          <Button
                                            className="h-11 flex-1 rounded-2xl"
                                            onClick={() => handleRenderClip(clip)}
                                            disabled={renderState[clip.id] === "rendering" || uploadRenderState[clip.id] === "rendering" || (!uploadedFile && !hasYouTubeLink)}
                                          >
                                            {renderState[clip.id] === "rendering" || uploadRenderState[clip.id] === "rendering" ? (
                                              <span className="inline-flex items-center gap-2">
                                                <LoaderCircle className="size-4 animate-spin" />
                                                {uploadedFile ? "Trimming uploaded file…" : "Rendering clip…"}
                                              </span>
                                            ) : uploadedFile ? (
                                              <span className="inline-flex items-center gap-2">
                                                <Upload className="size-4" />
                                                Trim uploaded file & download
                                              </span>
                                            ) : (
                                              "Render & download clip"
                                            )}
                                          </Button>
                                          {currentVideoId ? (
                                            <Button asChild variant="outline" className="h-11 flex-1 rounded-2xl border-border/70 bg-background/80">
                                              <a href={`https://www.youtube.com/watch?v=${currentVideoId}&t=${Math.floor(clip.startSeconds)}s`} target="_blank" rel="noreferrer noopener">
                                                Open on YouTube
                                              </a>
                                            </Button>
                                          ) : null}
                                        </div>

                                        {renderState[clip.id] === "error" || uploadRenderState[clip.id] === "error" ? (
                                          <div className="mt-3 flex items-start gap-2 rounded-2xl border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive">
                                            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                                            <div>
                                              <p>{uploadRenderErrors[clip.id] ?? renderErrors[clip.id] ?? "Clip rendering failed."}</p>
                                              {!uploadedFile ? (
                                                <button
                                                  type="button"
                                                  onClick={() => uploadInputRef.current?.click()}
                                                  className="mt-1 font-medium underline underline-offset-2"
                                                >
                                                  Upload a video file instead
                                                </button>
                                              ) : null}
                                            </div>
                                          </div>
                                        ) : (
                                          <p className="mt-2 text-xs text-muted-foreground">
                                            {uploadedFile
                                              ? "Trims directly from your uploaded file — no YouTube link required."
                                              : "Downloads a real cut of the video, re-encoded to this clip's exact start and end time."}
                                          </p>
                                        )}

                                        {!uploadedFile && hasYouTubeLink ? (
                                          <>
                                            <Separator className="my-4" />
                                            <div className="flex items-center justify-between gap-3 rounded-2xl border border-dashed border-border/70 bg-background/60 p-3">
                                              <p className="text-xs leading-5 text-muted-foreground">
                                                If YouTube blocks the download above, upload your own copy of this video to trim it reliably — no link required after that.
                                              </p>
                                              <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="h-8 shrink-0 rounded-xl border-border/70 bg-background/80 text-xs"
                                                onClick={() => uploadInputRef.current?.click()}
                                              >
                                                <Upload className="mr-1.5 size-3.5" />
                                                Upload video
                                              </Button>
                                            </div>
                                          </>
                                        ) : null}

                                        <div className="mt-3 flex items-center justify-end">
                                          <button
                                            type="button"
                                            onClick={() => handleDownloadClipBrief(clip)}
                                            className="whitespace-nowrap text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
                                          >
                                            Clip brief (JSON)
                                          </button>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                              </DialogContent>
                            </Dialog>
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
