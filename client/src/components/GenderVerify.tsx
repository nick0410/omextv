import { useCallback, useEffect, useRef, useState } from "react";
import api from "../lib/axios";
import { OUTCOME_COPY } from "../lib/types";
import type { GenderVerifyResult } from "../lib/types";

interface Status {
  declared: string;
  verified: string | null;
  confidence: number | null;
  isFresh: boolean;
  effectiveGender: string;
  usingVerified: boolean;
}

interface Props {
  localStream: MediaStream | null;
  onRequestCamera: () => Promise<MediaStream | null>;
}

/** Frames per verification, and the gap between them. */
const FRAME_COUNT = 7;
const FRAME_GAP_MS = 220;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2">
      <dt className="text-sm text-ink-500">{label}</dt>
      <dd className="text-sm font-medium capitalize text-ink-900">{value}</dd>
    </div>
  );
}

export function GenderVerify({ localStream, onRequestCamera }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [result, setResult] = useState<GenderVerifyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  const loadStatus = useCallback(() => {
    api
      .get<Status>("/meta/gender-status")
      .then((res) => setStatus(res.data))
      .catch(() => setStatus(null));
  }, []);

  useEffect(loadStatus, [loadStatus]);

  useEffect(() => {
    if (videoRef.current && videoRef.current.srcObject !== localStream) {
      videoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  const capture = async () => {
    let stream = localStream;
    if (!stream) stream = await onRequestCamera();
    if (!stream) return;

    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;

    setBusy(true);
    setResult(null);
    setProgress(0);
    try {
      const targetWidth = 640;
      const scale = targetWidth / video.videoWidth;
      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Several frames, not one. A single webcam still is a noisy sample; the
      // server averages them and refuses to answer when they disagree.
      const frames: string[] = [];
      for (let i = 0; i < FRAME_COUNT; i++) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push(canvas.toDataURL("image/jpeg", 0.85));
        setProgress(i + 1);
        if (i < FRAME_COUNT - 1) await new Promise((r) => setTimeout(r, FRAME_GAP_MS));
      }

      const { data } = await api.post<GenderVerifyResult>("/meta/verify-gender", {
        images: frames,
      });
      setResult(data);
      loadStatus();
    } catch (err: unknown) {
      const body = (err as { response?: { data?: GenderVerifyResult } })?.response?.data;
      setResult(
        body ?? {
          ok: false,
          outcome: "provider_unavailable",
          gender: null,
          confidence: 0,
          mismatch: false,
        },
      );
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  const verified = status?.usingVerified;

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto rounded-2xl bg-white p-4 ring-1 ring-ink-200">
      <div className="relative aspect-video overflow-hidden rounded-xl bg-ink-900">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="h-full w-full -scale-x-100 object-cover"
        />
        {verified && (
          <span className="absolute right-3 top-3 rounded-lg bg-success-500 px-2 py-1 text-[11px] font-semibold tracking-wide text-white">
            VERIFIED
          </span>
        )}
      </div>

      {status && (
        <dl className="divide-y divide-ink-200">
          <Row label="Declared" value={status.declared} />
          <Row
            label="Detected"
            value={
              status.verified
                ? `${status.verified}${
                    status.confidence != null
                      ? ` · ${(status.confidence * 100).toFixed(0)}%`
                      : ""
                  }`
                : "—"
            }
          />
          <Row label="Shown to others" value={status.effectiveGender} />
        </dl>
      )}

      {result && (
        <p
          className={`text-sm ${result.ok ? "text-success-500" : "text-ink-500"}`}
          aria-live="polite"
        >
          {OUTCOME_COPY[result.outcome]}
        </p>
      )}

      <button
        type="button"
        onClick={capture}
        disabled={busy}
        className="mt-auto w-full rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-600 disabled:opacity-50"
      >
        {busy
          ? progress > 0
            ? `${progress} / ${FRAME_COUNT}`
            : "Checking"
          : verified
            ? "Verify again"
            : "Verify"}
      </button>
    </div>
  );
}
