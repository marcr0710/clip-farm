import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Crosshair,
  LoaderCircle,
  RotateCcw,
  ScanFace,
  Scissors,
  Upload,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { detectSpeakerFocus, focusToObjectPosition } from "@/lib/face-focus";
import { cn } from "@/lib/utils";

export type PreviewClip = {
  id: number;
  title: string;
  hook: string;
  reason: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  originalStartSeconds: number;
  originalEndSeconds: number;
  /** 0 = left, 1 = right. Where the vertical crop window is locked. */
  focusX: number;
  /** 0 = top, 1 = bottom. Where the horizontal crop window is locked. */
  focusY: number;
  score: number;
  format: string;
  captionStyle: string;
  transcriptExcerpt: string;
};

type ClipPreviewDialogProps = {
  clip: PreviewClip;
  videoTitle?: string;
  currentVideoId: string;
  uploadedPreviewUrl: string;
  thumbnailUrl?: string;
  hasUploadedFile: boolean;
  hasYouTubeLink: boolean;
  getClipEmbedUrl: (videoId: string, clip: Pick<PreviewClip, "startSeconds" | "endSeconds">) => string;
  formatTime: (seconds: number) => string;
  formatTimePrecise: (seconds: number, fractionDigits?: number) => string;
  parseTimestamp: (value: string) => number | null;
  mediaDurationSeconds?: number;
  onUpdateTiming: (clipId: number, startSeconds: number, endSeconds: number) => void;
  onResetTiming: (clipId: number) => void;
  onUpdateFocus: (clipId: number, focusX: number, focusY: number) => void;
  onResetFocus: (clipId: number) => void;
  onRender: (clip: PreviewClip) => void;
  onDownloadBrief: (clip: PreviewClip) => void;
  onUploadClick: () => void;
  renderState: "idle" | "rendering" | "error";
  renderError?: string;
  renderStatus?: string;
};

const MIN_GAP = 1;
const FOCUS_EPS = 0.02;

function previewFrameClass(format: string) {
  if (format === "16:9") return "aspect-video w-full max-w-3xl";
  if (format === "1:1") return "aspect-square w-full max-w-[420px]";
  return "aspect-[9/16] w-full max-w-[320px]";
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function LocalClipPlayer({
  src,
  startSeconds,
  endSeconds,
  focusX,
  focusY,
  className,
}: {
  src: string;
  startSeconds: number;
  endSeconds: number;
  focusX: number;
  focusY: number;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const start = Math.max(0, startSeconds);
  const end = Math.max(start + 0.25, endSeconds);
  const objectPosition = focusToObjectPosition(focusX, focusY);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const seekToStart = () => {
      try {
        if (Math.abs(video.currentTime - start) > 0.15) {
          video.currentTime = start;
        }
      } catch {
        // ignore seek errors before metadata is ready
      }
    };

    const onTimeUpdate = () => {
      if (video.currentTime >= end - 0.05) {
        video.pause();
        video.currentTime = end;
      }
    };

    const onLoaded = () => seekToStart();

    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("timeupdate", onTimeUpdate);
    seekToStart();

    return () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [src, start, end]);

  return (
    <video
      ref={videoRef}
      key={`${src}-${start.toFixed(2)}-${end.toFixed(2)}`}
      src={src}
      className={cn("h-full w-full object-cover", className)}
      style={{ objectPosition }}
      controls
      playsInline
      preload="metadata"
    />
  );
}

function FocusPreview({
  src,
  poster,
  startSeconds,
  endSeconds,
  focusX,
  focusY,
  format,
  isYouTubeEmbed,
  embedUrl,
  title,
}: {
  src?: string;
  poster?: string;
  startSeconds: number;
  endSeconds: number;
  focusX: number;
  focusY: number;
  format: string;
  isYouTubeEmbed: boolean;
  embedUrl?: string;
  title: string;
}) {
  const frameClass = previewFrameClass(format);
  const objectPosition = focusToObjectPosition(focusX, focusY);

  // YouTube embeds can't be object-positioned. Show a framed still/thumbnail
  // with the live focus overlay, plus a small note that export uses the pan.
  if (isYouTubeEmbed && embedUrl) {
    return (
      <div
        className={cn(
          "relative overflow-hidden rounded-[28px] border border-white/10 bg-black shadow-2xl shadow-black/40",
          frameClass,
        )}
      >
        {poster ? (
          <img
            src={poster}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            style={{ objectPosition }}
            draggable={false}
          />
        ) : (
          <iframe
            key={`${title}-${startSeconds.toFixed(2)}-${endSeconds.toFixed(2)}`}
            src={embedUrl}
            title={title}
            className="absolute inset-0 h-full w-full opacity-80"
            loading="lazy"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-black/20" />
        <div
          className="pointer-events-none absolute size-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
          style={{ left: `${focusX * 100}%`, top: `${focusY * 100}%` }}
        >
          <div className="absolute inset-1 rounded-full bg-white/30" />
        </div>
      </div>
    );
  }

  if (src) {
    return (
      <div
        className={cn(
          "relative overflow-hidden rounded-[28px] border border-white/10 bg-black shadow-2xl shadow-black/40",
          frameClass,
        )}
      >
        <LocalClipPlayer
          src={src}
          startSeconds={startSeconds}
          endSeconds={endSeconds}
          focusX={focusX}
          focusY={focusY}
          className="absolute inset-0"
        />
        <div
          className="pointer-events-none absolute size-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
          style={{ left: `${focusX * 100}%`, top: `${focusY * 100}%` }}
        >
          <div className="absolute inset-1 rounded-full bg-white/25" />
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[28px] border border-white/10 bg-black shadow-2xl shadow-black/40",
        frameClass,
      )}
    >
      <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-white/70">
        Upload a video or add a YouTube link to preview this clip.
      </div>
    </div>
  );
}

export function ClipPreviewDialog({
  clip,
  videoTitle,
  currentVideoId,
  uploadedPreviewUrl,
  thumbnailUrl,
  hasUploadedFile,
  hasYouTubeLink,
  getClipEmbedUrl,
  formatTime,
  formatTimePrecise,
  parseTimestamp,
  mediaDurationSeconds,
  onUpdateTiming,
  onResetTiming,
  onUpdateFocus,
  onResetFocus,
  onRender,
  onDownloadBrief,
  onUploadClick,
  renderState,
  renderError,
  renderStatus,
}: ClipPreviewDialogProps) {
  const [startDraft, setStartDraft] = useState(formatTimePrecise(clip.startSeconds));
  const [endDraft, setEndDraft] = useState(formatTimePrecise(clip.endSeconds));
  const [open, setOpen] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectNote, setDetectNote] = useState<string | null>(null);
  const detectAbortRef = useRef<AbortController | null>(null);

  // Keep draft inputs in sync when the parent clip range changes (slider / reset).
  useEffect(() => {
    setStartDraft(formatTimePrecise(clip.startSeconds));
    setEndDraft(formatTimePrecise(clip.endSeconds));
  }, [clip.startSeconds, clip.endSeconds, formatTimePrecise]);

  // Auto-detect speaker focus once when the dialog opens with a local file
  // and the user hasn't already panned away from center.
  useEffect(() => {
    if (!open || !uploadedPreviewUrl) return;
    const isDefaultFocus =
      Math.abs(clip.focusX - 0.5) < FOCUS_EPS && Math.abs(clip.focusY - 0.5) < FOCUS_EPS;
    if (!isDefaultFocus) return;

    const controller = new AbortController();
    detectAbortRef.current = controller;
    setDetecting(true);
    setDetectNote("Finding the speaker…");

    detectSpeakerFocus({
      src: uploadedPreviewUrl,
      startSeconds: clip.startSeconds,
      endSeconds: clip.endSeconds,
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.source === "center" || result.samples === 0) {
          setDetectNote("Couldn't lock a face — drag the focus or use the sliders.");
          return;
        }
        onUpdateFocus(clip.id, result.focusX, result.focusY);
        setDetectNote(
          result.source === "face-detector"
            ? "Speaker locked from face detection."
            : "Speaker locked from visual analysis.",
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setDetectNote("Face detect unavailable — pan manually.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetecting(false);
      });

    return () => {
      controller.abort();
      detectAbortRef.current = null;
    };
    // Only re-run when the dialog opens or the source clip identity changes —
    // not on every focus tweak the user makes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, uploadedPreviewUrl, clip.id, clip.startSeconds, clip.endSeconds]);

  useEffect(() => {
    return () => {
      detectAbortRef.current?.abort();
    };
  }, []);

  const maxBound = useMemo(() => {
    if (mediaDurationSeconds && mediaDurationSeconds > 0) return mediaDurationSeconds;
    // Give the dual-range scrubber room past the current end when duration is unknown.
    return Math.max(clip.endSeconds + 30, clip.originalEndSeconds + 30, 60);
  }, [mediaDurationSeconds, clip.endSeconds, clip.originalEndSeconds]);

  const isEdited =
    Math.abs(clip.startSeconds - clip.originalStartSeconds) > 0.05 ||
    Math.abs(clip.endSeconds - clip.originalEndSeconds) > 0.05;

  const isFocusEdited =
    Math.abs(clip.focusX - 0.5) > FOCUS_EPS || Math.abs(clip.focusY - 0.5) > FOCUS_EPS;

  const startPct = Math.min(100, Math.max(0, (clip.startSeconds / maxBound) * 100));
  const endPct = Math.min(100, Math.max(0, (clip.endSeconds / maxBound) * 100));

  const commitStartDraft = () => {
    const parsed = parseTimestamp(startDraft);
    if (parsed === null) {
      setStartDraft(formatTimePrecise(clip.startSeconds));
      return;
    }
    onUpdateTiming(clip.id, parsed, clip.endSeconds);
  };

  const commitEndDraft = () => {
    const parsed = parseTimestamp(endDraft);
    if (parsed === null) {
      setEndDraft(formatTimePrecise(clip.endSeconds));
      return;
    }
    onUpdateTiming(clip.id, clip.startSeconds, parsed);
  };

  const nudge = (which: "start" | "end", delta: number) => {
    if (which === "start") {
      onUpdateTiming(clip.id, clip.startSeconds + delta, clip.endSeconds);
    } else {
      onUpdateTiming(clip.id, clip.startSeconds, clip.endSeconds + delta);
    }
  };

  const runDetect = async () => {
    if (!uploadedPreviewUrl) {
      setDetectNote("Upload a video file to auto-detect the speaker.");
      return;
    }
    detectAbortRef.current?.abort();
    const controller = new AbortController();
    detectAbortRef.current = controller;
    setDetecting(true);
    setDetectNote("Scanning frames for a face…");
    try {
      const result = await detectSpeakerFocus({
        src: uploadedPreviewUrl,
        startSeconds: clip.startSeconds,
        endSeconds: clip.endSeconds,
        sampleCount: 6,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (result.source === "center" || result.samples === 0) {
        setDetectNote("No clear face found — pan the focus manually.");
        return;
      }
      onUpdateFocus(clip.id, result.focusX, result.focusY);
      setDetectNote(
        result.source === "face-detector"
          ? "Speaker locked from face detection."
          : "Speaker locked from visual analysis.",
      );
    } catch {
      if (!controller.signal.aborted) setDetectNote("Detection failed — pan manually.");
    } finally {
      if (!controller.signal.aborted) setDetecting(false);
    }
  };

  const embedUrl = currentVideoId ? getClipEmbedUrl(currentVideoId, clip) : undefined;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className="h-11 w-full rounded-2xl border-border/70 bg-background/70"
        >
          Preview & trim
          <Scissors className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-[28px] border-border/70 p-0 sm:max-w-4xl">
        <DialogHeader className="border-b border-border/70 px-6 py-5 text-left">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <DialogTitle className="text-xl tracking-tight">{clip.title}</DialogTitle>
              <DialogDescription className="mt-1">
                {videoTitle ?? "Clip preview"} · {formatTime(clip.startSeconds)} → {formatTime(clip.endSeconds)} ·{" "}
                {formatTime(clip.durationSeconds)} · {clip.format} Shorts frame
              </DialogDescription>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Badge variant="secondary" className="rounded-full px-3 py-1">
                Score {clip.score}
              </Badge>
              <Badge className="rounded-full bg-primary/10 px-3 py-1 text-primary hover:bg-primary/10">
                {clip.format}
              </Badge>
              {isEdited ? (
                <Badge variant="outline" className="rounded-full px-3 py-1 text-xs">
                  Manually trimmed
                </Badge>
              ) : null}
              {isFocusEdited ? (
                <Badge variant="outline" className="rounded-full px-3 py-1 text-xs">
                  Reframed
                </Badge>
              ) : null}
            </div>
          </div>
        </DialogHeader>

        <div className="grid gap-0 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          {/* 9:16 (or selected format) phone-style preview */}
          <div className="flex flex-col items-center justify-center gap-3 border-b border-border/70 bg-zinc-950 px-4 py-6 lg:border-b-0 lg:border-r">
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-white/50">
              {clip.format === "9:16"
                ? "YouTube Shorts · 9:16"
                : clip.format === "1:1"
                  ? "Square · 1:1"
                  : "Landscape · 16:9"}
            </p>
            <FocusPreview
              src={uploadedPreviewUrl || undefined}
              poster={thumbnailUrl}
              startSeconds={clip.startSeconds}
              endSeconds={clip.endSeconds}
              focusX={clip.focusX}
              focusY={clip.focusY}
              format={clip.format}
              isYouTubeEmbed={Boolean(currentVideoId) && !uploadedPreviewUrl}
              embedUrl={embedUrl}
              title={clip.title}
            />
            <p className="max-w-[280px] text-center text-xs leading-5 text-white/45">
              Preview follows your speaker focus. Downloaded MP4s crop to the same point — not just the middle of the frame.
            </p>
          </div>

          {/* Trim editor + details */}
          <div className="bg-background">
            <div className="space-y-5 px-6 py-5">
              <div className="rounded-2xl border border-primary/15 bg-primary/5 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold tracking-tight">Manual trim</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Drag the handles or type exact start/end times. Preview and download use your edit.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0 gap-1.5 rounded-xl text-xs"
                    disabled={!isEdited}
                    onClick={() => onResetTiming(clip.id)}
                  >
                    <RotateCcw className="size-3.5" />
                    Reset AI cut
                  </Button>
                </div>

                {/* Dual-range scrubber */}
                <div className="relative mt-5 h-10 select-none">
                  <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-muted" />
                  <div
                    className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-primary/70"
                    style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
                  />
                  <input
                    type="range"
                    min={0}
                    max={maxBound}
                    step={0.1}
                    value={clip.startSeconds}
                    aria-label="Clip start"
                    className="pointer-events-none absolute inset-x-0 top-1/2 z-20 h-10 w-full -translate-y-1/2 appearance-none bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:cursor-ew-resize [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-primary [&::-moz-range-thumb]:bg-background [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:relative [&::-webkit-slider-thumb]:z-30 [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:cursor-ew-resize [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-primary [&::-webkit-slider-thumb]:bg-background"
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      const capped = Math.min(next, clip.endSeconds - MIN_GAP);
                      onUpdateTiming(clip.id, capped, clip.endSeconds);
                    }}
                  />
                  <input
                    type="range"
                    min={0}
                    max={maxBound}
                    step={0.1}
                    value={clip.endSeconds}
                    aria-label="Clip end"
                    className="pointer-events-none absolute inset-x-0 top-1/2 z-10 h-10 w-full -translate-y-1/2 appearance-none bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:cursor-ew-resize [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-primary [&::-moz-range-thumb]:bg-primary [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:relative [&::-webkit-slider-thumb]:z-20 [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:cursor-ew-resize [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-primary [&::-webkit-slider-thumb]:bg-primary"
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      const capped = Math.max(next, clip.startSeconds + MIN_GAP);
                      onUpdateTiming(clip.id, clip.startSeconds, capped);
                    }}
                  />
                </div>
                <div className="mt-1 flex items-center justify-between text-[11px] tabular-nums text-muted-foreground">
                  <span>0:00</span>
                  <span>
                    Selection {formatTimePrecise(clip.startSeconds)} – {formatTimePrecise(clip.endSeconds)} (
                    {formatTimePrecise(clip.durationSeconds)})
                  </span>
                  <span>{formatTime(maxBound)}</span>
                </div>

                {/* Numeric / timestamp inputs */}
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor={`start-${clip.id}`} className="text-xs font-medium">
                      Start time
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id={`start-${clip.id}`}
                        value={startDraft}
                        onChange={(event) => setStartDraft(event.target.value)}
                        onBlur={commitStartDraft}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.currentTarget.blur();
                          }
                        }}
                        placeholder="0:00.0"
                        className="h-10 rounded-xl border-border/70 bg-background font-mono text-sm tabular-nums"
                      />
                      <div className="flex shrink-0 gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-10 w-10 rounded-xl px-0 text-xs"
                          onClick={() => nudge("start", -0.5)}
                          aria-label="Nudge start earlier"
                        >
                          −0.5
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-10 w-10 rounded-xl px-0 text-xs"
                          onClick={() => nudge("start", 0.5)}
                          aria-label="Nudge start later"
                        >
                          +0.5
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`end-${clip.id}`} className="text-xs font-medium">
                      End time
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id={`end-${clip.id}`}
                        value={endDraft}
                        onChange={(event) => setEndDraft(event.target.value)}
                        onBlur={commitEndDraft}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.currentTarget.blur();
                          }
                        }}
                        placeholder="0:30.0"
                        className="h-10 rounded-xl border-border/70 bg-background font-mono text-sm tabular-nums"
                      />
                      <div className="flex shrink-0 gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-10 w-10 rounded-xl px-0 text-xs"
                          onClick={() => nudge("end", -0.5)}
                          aria-label="Nudge end earlier"
                        >
                          −0.5
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-10 w-10 rounded-xl px-0 text-xs"
                          onClick={() => nudge("end", 0.5)}
                          aria-label="Nudge end later"
                        >
                          +0.5
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
                <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
                  Accepts <span className="font-mono">m:ss</span>, <span className="font-mono">h:mm:ss</span>, or raw
                  seconds. Min length {MIN_GAP}s · max {MAX_MANUAL_LABEL}.
                </p>
              </div>

              {/* Speaker focus / reframing */}
              <div className="rounded-2xl border border-border/70 bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="inline-flex items-center gap-1.5 text-sm font-semibold tracking-tight">
                      <Crosshair className="size-3.5 text-primary" />
                      Speaker focus
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Shift the {clip.format} crop onto the person talking instead of dead-center.
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 rounded-xl text-xs"
                      disabled={detecting || !uploadedPreviewUrl}
                      onClick={() => void runDetect()}
                    >
                      {detecting ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : (
                        <ScanFace className="size-3.5" />
                      )}
                      {detecting ? "Detecting…" : "Auto-detect"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1.5 rounded-xl text-xs"
                      disabled={!isFocusEdited}
                      onClick={() => {
                        onResetFocus(clip.id);
                        setDetectNote(null);
                      }}
                    >
                      <RotateCcw className="size-3.5" />
                      Center
                    </Button>
                  </div>
                </div>

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor={`focus-x-${clip.id}`} className="text-xs font-medium">
                        Horizontal
                      </Label>
                      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                        {clip.focusX < 0.4 ? "Left" : clip.focusX > 0.6 ? "Right" : "Center"} ·{" "}
                        {(clip.focusX * 100).toFixed(0)}%
                      </span>
                    </div>
                    <input
                      id={`focus-x-${clip.id}`}
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={clip.focusX}
                      aria-label="Horizontal focus"
                      className="h-2 w-full cursor-ew-resize appearance-none rounded-full bg-muted accent-primary"
                      onChange={(event) =>
                        onUpdateFocus(clip.id, clamp01(Number(event.target.value)), clip.focusY)
                      }
                    />
                    <div className="flex justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
                      <span>Left</span>
                      <span>Right</span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor={`focus-y-${clip.id}`} className="text-xs font-medium">
                        Vertical
                      </Label>
                      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                        {clip.focusY < 0.4 ? "Up" : clip.focusY > 0.6 ? "Down" : "Middle"} ·{" "}
                        {(clip.focusY * 100).toFixed(0)}%
                      </span>
                    </div>
                    <input
                      id={`focus-y-${clip.id}`}
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={clip.focusY}
                      aria-label="Vertical focus"
                      className="h-2 w-full cursor-ns-resize appearance-none rounded-full bg-muted accent-primary"
                      onChange={(event) =>
                        onUpdateFocus(clip.id, clip.focusX, clamp01(Number(event.target.value)))
                      }
                    />
                    <div className="flex justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
                      <span>Up</span>
                      <span>Down</span>
                    </div>
                  </div>
                </div>

                {detectNote ? (
                  <p className="mt-3 text-[11px] leading-4 text-muted-foreground">{detectNote}</p>
                ) : !uploadedPreviewUrl ? (
                  <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
                    Upload a local video for auto face-lock. YouTube-only previews still honor the manual pan on export.
                  </p>
                ) : (
                  <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
                    Auto-detect samples frames in this trim range and locks onto the largest face.
                  </p>
                )}
              </div>

              <div>
                <p className="text-sm font-medium text-muted-foreground">Why AI picked this</p>
                <p className="mt-2 text-sm leading-6">{clip.reason}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Transcript excerpt</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{clip.transcriptExcerpt}</p>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div className="rounded-2xl border border-border/70 bg-card p-3">
                  <p className="text-xs text-muted-foreground">Start</p>
                  <p className="mt-1 font-semibold tabular-nums">{formatTimePrecise(clip.startSeconds)}</p>
                </div>
                <div className="rounded-2xl border border-border/70 bg-card p-3">
                  <p className="text-xs text-muted-foreground">End</p>
                  <p className="mt-1 font-semibold tabular-nums">{formatTimePrecise(clip.endSeconds)}</p>
                </div>
                <div className="rounded-2xl border border-border/70 bg-card p-3">
                  <p className="text-xs text-muted-foreground">Duration</p>
                  <p className="mt-1 font-semibold tabular-nums">{formatTimePrecise(clip.durationSeconds)}</p>
                </div>
                <div className="rounded-2xl border border-border/70 bg-card p-3">
                  <p className="text-xs text-muted-foreground">Export</p>
                  <p className="mt-1 font-semibold">{clip.format}</p>
                </div>
              </div>
            </div>

            <div className="border-t border-border/70 bg-background/95 px-6 py-4">
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button
                  className="h-11 flex-1 rounded-2xl"
                  onClick={() => onRender(clip)}
                  disabled={renderState === "rendering" || (!hasUploadedFile && !hasYouTubeLink)}
                >
                  {renderState === "rendering" ? (
                    <span className="inline-flex items-center gap-2">
                      <LoaderCircle className="size-4 animate-spin" />
                      {hasUploadedFile ? "Trimming in browser…" : "Rendering clip…"}
                    </span>
                  ) : hasUploadedFile ? (
                    <span className="inline-flex items-center gap-2">
                      <Scissors className="size-4" />
                      Trim {clip.format} & download
                    </span>
                  ) : (
                    `Render ${clip.format} & download`
                  )}
                </Button>
                {currentVideoId ? (
                  <Button asChild variant="outline" className="h-11 flex-1 rounded-2xl border-border/70 bg-background/80">
                    <a
                      href={`https://www.youtube.com/watch?v=${currentVideoId}&t=${Math.floor(clip.startSeconds)}s`}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Open on YouTube
                    </a>
                  </Button>
                ) : null}
              </div>

              {renderState === "error" ? (
                <div className="mt-3 flex items-start gap-2 rounded-2xl border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                  <div>
                    <p>{renderError ?? "Clip rendering failed."}</p>
                    {!hasUploadedFile ? (
                      <button
                        type="button"
                        onClick={onUploadClick}
                        className="mt-1 font-medium underline underline-offset-2"
                      >
                        Upload a video file instead
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : renderState === "rendering" && renderStatus ? (
                <p className="mt-2 text-xs text-muted-foreground">{renderStatus}</p>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  {hasUploadedFile
                    ? `Exports a ${clip.format} MP4 from your local file using the trimmed range and speaker focus above.`
                    : `Downloads a real cut re-encoded to ${clip.format} with your trim and speaker focus.`}
                </p>
              )}

              {!hasUploadedFile && hasYouTubeLink ? (
                <>
                  <Separator className="my-4" />
                  <div className="flex items-center justify-between gap-3 rounded-2xl border border-dashed border-border/70 bg-background/60 p-3">
                    <p className="text-xs leading-5 text-muted-foreground">
                      Upload your own copy to auto-detect faces and trim more reliably if YouTube blocks the download.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0 rounded-xl border-border/70 bg-background/80 text-xs"
                      onClick={onUploadClick}
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
                  onClick={() => onDownloadBrief(clip)}
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
  );
}

const MAX_MANUAL_LABEL = "2:00";
