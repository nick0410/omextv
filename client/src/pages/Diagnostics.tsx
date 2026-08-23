import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getApiUrl } from "../lib/apiConfig";
import { Logo } from "../components/Logo";

/**
 * Why a call did not connect.
 *
 * A failed call gives the user one bit of information — it did not work — and
 * the cause is usually invisible: a blocked camera, an unreachable API, or ICE
 * finding no usable path. Each of those needs a different fix, so this runs the
 * same steps a real call runs and reports which one broke, on the device that
 * broke. Both people open it and compare.
 */

type State = "pending" | "running" | "pass" | "warn" | "fail";

/**
 * Reject a promise that never settles.
 *
 * getUserMedia stays pending for as long as the permission prompt is on
 * screen, and if it is dismissed or ignored it never settles at all — the
 * test would sit on "Camera and microphone" forever with nothing to explain
 * why. Long enough for someone to read the prompt and tap Allow.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function readToken(): string | null {
  try {
    const raw = localStorage.getItem("omextv-auth");
    return raw ? (JSON.parse(raw)?.state?.token ?? null) : null;
  } catch {
    return null;
  }
}

interface Check {
  id: string;
  label: string;
  state: State;
  detail: string;
}

const INITIAL: Check[] = [
  { id: "secure", label: "Secure page", state: "pending", detail: "" },
  { id: "api", label: "Server reachable", state: "pending", detail: "" },
  { id: "media", label: "Camera and microphone", state: "pending", detail: "" },
  { id: "ice", label: "Network path", state: "pending", detail: "" },
  { id: "loopback", label: "Video connection", state: "pending", detail: "" },
];

const DOT: Record<State, string> = {
  pending: "bg-ink-300",
  running: "bg-brand-400 animate-pulse",
  pass: "bg-emerald-500",
  warn: "bg-amber-500",
  fail: "bg-danger-500",
};

/**
 * Gather ICE candidates for a throwaway connection and count what types the
 * network actually produces.
 *
 *   host   — this machine only; works on a shared Wi-Fi and nowhere else.
 *   srflx  — STUN saw a public address; enough for most home networks.
 *   relay  — a TURN server answered; the only thing that works behind
 *            symmetric NAT, which is common on mobile data and campus Wi-Fi.
 */
async function gatherCandidates(
  iceServers: RTCIceServer[],
  timeoutMs = 8000,
): Promise<{ host: number; srflx: number; relay: number }> {
  const counts = { host: 0, srflx: 0, relay: 0 };
  const peer = new RTCPeerConnection({ iceServers });

  try {
    peer.createDataChannel("probe");
    await peer.setLocalDescription(await peer.createOffer());

    await new Promise<void>((resolve) => {
      const done = setTimeout(resolve, timeoutMs);
      peer.onicecandidate = (event) => {
        if (!event.candidate) {
          clearTimeout(done);
          resolve();
          return;
        }
        const type = /\btyp (\w+)/.exec(event.candidate.candidate)?.[1];
        if (type === "host") counts.host++;
        else if (type === "srflx" || type === "prflx") counts.srflx++;
        else if (type === "relay") counts.relay++;
      };
    });
  } finally {
    peer.close();
  }

  return counts;
}

/**
 * Connect two peer connections in this same tab.
 *
 * If even this fails, the problem is the browser or an extension rather than
 * the network — worth separating, because it is the one cause the user can fix
 * without understanding NAT.
 */
async function loopback(stream: MediaStream): Promise<boolean> {
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();

  try {
    a.onicecandidate = (e) => e.candidate && void b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && void a.addIceCandidate(e.candidate);
    for (const track of stream.getTracks()) a.addTrack(track, stream);

    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription!);

    return await new Promise<boolean>((resolve) => {
      const done = setTimeout(() => resolve(false), 10000);
      a.onconnectionstatechange = () => {
        if (a.connectionState === "connected") {
          clearTimeout(done);
          resolve(true);
        }
        if (a.connectionState === "failed") {
          clearTimeout(done);
          resolve(false);
        }
      };
    });
  } finally {
    a.close();
    b.close();
  }
}

interface QueueReport {
  waiting: number;
  entries: { id: string; country: string | null; gender: string; waitedMs: number }[];
  pairs: { a: string; b: string; blockedBy: string | null }[];
}

export default function Diagnostics() {
  const [checks, setChecks] = useState<Check[]>(INITIAL);
  const [running, setRunning] = useState(false);
  const [verdict, setVerdict] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueReport | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const set = useCallback((id: string, state: State, detail: string) => {
    setChecks((prev) => prev.map((c) => (c.id === id ? { ...c, state, detail } : c)));
  }, []);

  // A test that leaves the camera on after it finishes is its own problem.
  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const run = useCallback(async () => {
    setRunning(true);
    setVerdict(null);
    setChecks(INITIAL.map((c) => ({ ...c, state: "pending", detail: "" })));

    // 1. getUserMedia is unavailable on plain HTTP, which looks like a broken
    //    camera rather than a page-security problem.
    set("secure", "running", "");
    const secure = window.isSecureContext;
    set(
      "secure",
      secure ? "pass" : "fail",
      secure ? window.location.origin : "Not HTTPS — the camera cannot start here",
    );

    // 2. The API.
    set("api", "running", "");
    let iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
    let hasTurn = false;
    const base = getApiUrl();
    try {
      const health = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(12000),
      });
      if (!health.ok) throw new Error(`HTTP ${health.status}`);

      // A same-origin deploy with no API behind it answers /health with the
      // SPA's own index.html and a cheerful 200. Checking only the status
      // reports a healthy server that does not exist.
      const type = health.headers.get("content-type") ?? "";
      if (!type.includes("application/json")) {
        throw new Error("Answered with a web page, not the API");
      }
      const body = await health.json();
      if (body?.status !== "ok") throw new Error("API reported unhealthy");

      set("api", "pass", base || window.location.origin);

      // Zustand persists the whole auth slice under one key, so read the
      // token back the same way rather than inventing a second convention.
      const token = readToken();
      if (token) {
        const res = await fetch(`${base}/api/rtc/ice-servers`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(12000),
        });
        if (res.ok) {
          const cfg = await res.json();
          if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) {
            iceServers = cfg.iceServers;
          }
          hasTurn = Boolean(cfg.hasTurn);
        }

        // Why the people currently waiting are not being paired. Matchmaking
        // failures are otherwise silent — the queue just never produces a
        // match — and the cause is nearly always a filter someone forgot.
        try {
          const q = await fetch(`${base}/api/meta/queue-report`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(12000),
          });
          if (q.ok) setQueue(await q.json());
          else setQueueError(`HTTP ${q.status}`);
        } catch {
          setQueueError("Could not read the queue");
        }
      }
    } catch (err) {
      set("api", "fail", err instanceof Error ? err.message : "unreachable");
    }

    // 3. Camera and microphone.
    set("media", "running", "");
    let stream: MediaStream | null = null;
    try {
      stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({ video: true, audio: true }),
        45000,
        "No answer to the permission prompt",
      );
      streamRef.current = stream;
      set(
        "media",
        "pass",
        `${stream.getVideoTracks().length} camera, ${stream.getAudioTracks().length} mic`,
      );
    } catch (err) {
      const name = (err as { name?: string })?.name ?? "";
      set(
        "media",
        "fail",
        name === "NotAllowedError"
          ? "Blocked — allow camera access in the browser's site settings"
          : name === "NotFoundError"
            ? "No camera or microphone found"
            : name === "NotReadableError"
              ? "Already in use by another app"
              : err instanceof Error
                ? err.message
                : "Could not start",
      );
    }

    // 4. What the network offers.
    set("ice", "running", "");
    let counts = { host: 0, srflx: 0, relay: 0 };
    try {
      counts = await gatherCandidates(iceServers);
      const parts = [
        `${counts.host} local`,
        `${counts.srflx} public`,
        `${counts.relay} relay`,
      ].join(", ");

      if (counts.relay > 0) set("ice", "pass", parts);
      else if (counts.srflx > 0)
        set("ice", "warn", `${parts} — no relay, so some networks cannot connect`);
      else set("ice", "fail", `${parts} — this network blocks STUN`);
    } catch {
      set("ice", "fail", "Could not gather candidates");
    }

    // 5. WebRTC itself.
    if (stream) {
      set("loopback", "running", "");
      try {
        const ok = await loopback(stream);
        set(
          "loopback",
          ok ? "pass" : "fail",
          ok ? "WebRTC works in this browser" : "WebRTC could not connect even locally",
        );
      } catch {
        set("loopback", "fail", "WebRTC threw");
      }
    } else {
      set("loopback", "warn", "Skipped — needs the camera");
    }

    stream?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    setVerdict(
      counts.srflx === 0 && counts.relay === 0
        ? "This network blocks the connection entirely. Try mobile data or another Wi-Fi."
        : counts.relay === 0 && !hasTurn
          ? "No relay server is configured. Two people on different networks will often fail to connect — this is the most likely reason your call did not work."
          : counts.relay === 0
            ? "A relay is configured but did not answer from this network."
            : "This device looks fine. If the call still fails, run this on the other person's device too.",
    );
    setRunning(false);
  }, [set]);

  return (
    <div className="min-h-dvh px-5 py-8">
      <div className="mx-auto w-full max-w-[560px]">
        <div className="mb-6 flex items-center justify-between">
          <Logo />
          <Link to="/chat" className="text-sm font-medium text-brand-600 hover:text-brand-700">
            Back
          </Link>
        </div>

        <div className="rounded-2xl bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.06),0_8px_24px_rgba(15,23,42,0.06)] sm:p-6">
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">
            Connection test
          </h1>

          <button
            type="button"
            onClick={() => void run()}
            disabled={running}
            className="mt-4 min-h-11 w-full rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white transition-colors hover:bg-brand-600 disabled:opacity-50"
          >
            {running ? "Testing" : "Run test"}
          </button>

          <ul className="mt-5 space-y-3">
            {checks.map((check) => (
              <li key={check.id} className="flex gap-3">
                <span
                  className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[check.state]}`}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-900">{check.label}</p>
                  {check.detail && (
                    <p className="mt-0.5 break-words text-sm text-ink-500">{check.detail}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {verdict && (
            <p className="mt-5 rounded-xl bg-ink-100 p-3.5 text-sm text-ink-700">{verdict}</p>
          )}

          {(queue || queueError) && (
            <div className="mt-5 border-t border-ink-200 pt-4">
              <h2 className="text-sm font-semibold text-ink-900">Who is waiting</h2>

              {queueError && <p className="mt-1.5 text-sm text-ink-500">{queueError}</p>}

              {queue && queue.waiting === 0 && (
                <p className="mt-1.5 text-sm text-ink-500">
                  Nobody is in the queue right now.
                </p>
              )}

              {queue && queue.waiting > 0 && (
                <>
                  <ul className="mt-2 space-y-1">
                    {queue.entries.map((e) => (
                      <li key={e.id} className="text-sm text-ink-600">
                        {e.id} · {e.gender} · {e.country ?? "no country"} ·{" "}
                        {Math.round(e.waitedMs / 1000)}s
                      </li>
                    ))}
                  </ul>

                  {queue.pairs.length > 0 && (
                    <ul className="mt-3 space-y-1.5">
                      {queue.pairs.map((p) => (
                        <li
                          key={`${p.a}-${p.b}`}
                          className={`text-sm ${p.blockedBy ? "text-amber-700" : "text-emerald-700"}`}
                        >
                          {p.a} + {p.b}: {p.blockedBy ?? "compatible — should match"}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
