import { useCallback, useEffect, useRef, useState } from "react";
import api from "../lib/axios";
import type { Gender, GenderVerifyResult } from "../lib/types";

const FRAME_COUNT = 7;
const FRAME_GAP_MS = 220;
/** Give the camera a moment to expose and focus before sampling. */
const WARMUP_MS = 1500;

export interface DetectState {
  /** What the model concluded, once it has. */
  detected: Gender | null;
  /** True while frames are being captured or scored. */
  busy: boolean;
  /** Set once per session after an attempt, successful or not. */
  attempted: boolean;
}

interface Status {
  declared: string;
  verified: string | null;
  effectiveGender: string;
  usingVerified: boolean;
}

/**
 * Detect the user's gender from their own camera, quietly.
 *
 * This used to be a tab the user pressed. It now runs once when the camera
 * comes up, because the result is only ever used to pick a sensible default
 * for who they get matched with — asking someone to click through a
 * verification step for that is friction with nothing behind it.
 *
 * Nothing is uploaded before the camera is already running for the call
 * itself, seven stills go in one request, and the server discards them after
 * scoring. The UI still says plainly that this happens.
 */
export function useGenderDetect(localStream: MediaStream | null) {
  const [state, setState] = useState<DetectState>({
    detected: null,
    busy: false,
    attempted: false,
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** Guards against a second run when the stream object identity changes. */
  const ranRef = useRef(false);

  // If the server already holds a fresh reading, use it and skip the capture.
  useEffect(() => {
    let cancelled = false;
    api
      .get<Status>("/meta/gender-status")
      .then((res) => {
        if (cancelled) return;
        const verified = res.data?.verified;
        if (verified === "male" || verified === "female") {
          ranRef.current = true;
          setState({ detected: verified, busy: false, attempted: true });
        }
      })
      .catch(() => {
        // No backend, or not signed in — the capture below still tries.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const capture = useCallback(async (stream: MediaStream) => {
    setState((s) => ({ ...s, busy: true }));

    // An offscreen element: we only need frames, not something on screen.
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    videoRef.current = video;

    try {
      await video.play();
      await new Promise((r) => setTimeout(r, WARMUP_MS));
      if (video.videoWidth === 0) throw new Error("no video");

      const width = 640;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = Math.round(video.videoHeight * (width / video.videoWidth));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no canvas context");

      const frames: string[] = [];
      for (let i = 0; i < FRAME_COUNT; i++) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push(canvas.toDataURL("image/jpeg", 0.85));
        if (i < FRAME_COUNT - 1) await new Promise((r) => setTimeout(r, FRAME_GAP_MS));
      }

      const { data } = await api.post<GenderVerifyResult>("/meta/verify-gender", {
        images: frames,
      });

      setState({
        detected: data.ok && data.gender ? data.gender : null,
        busy: false,
        attempted: true,
      });
    } catch {
      // A failed read is not worth surfacing: matching falls back to the
      // gender the user declared at sign-up.
      setState({ detected: null, busy: false, attempted: true });
    } finally {
      video.srcObject = null;
      videoRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!localStream || ranRef.current) return;
    ranRef.current = true;
    void capture(localStream);
  }, [localStream, capture]);

  return state;
}
