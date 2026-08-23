import { useEffect, useRef } from "react";
import type { CallPhase, PartnerProfile } from "../lib/types";
import { countryFlag, countryName } from "../lib/countries";

interface Props {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  phase: CallPhase;
  partner: PartnerProfile | null;
  selfName: string;
  isCameraOff: boolean;
  queuePosition: number;
}

/** Name plate in the corner of a tile, as in the reference layout. */
function Plate({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute bottom-4 left-4 max-w-[calc(100%-2rem)] rounded-xl bg-black/55 px-3 py-1.5 backdrop-blur-sm">
      {children}
    </div>
  );
}

function NamePlate({ label }: { label: string }) {
  return (
    <Plate>
      <span className="block truncate text-[15px] font-medium leading-none text-white">
        {label}
      </span>
    </Plate>
  );
}

function PartnerPlate({ partner }: { partner: PartnerProfile }) {
  // Where the other person is is the whole point of a country filter — the
  // server has always sent it, it just was not being shown.
  const place = [partner.city, partner.country ? countryName(partner.country) : null]
    .filter(Boolean)
    .join(", ");

  return (
    <Plate>
      <span className="block truncate text-[15px] font-medium leading-tight text-white">
        {partner.username}
      </span>
      {place && (
        <span className="mt-0.5 flex items-center gap-1.5 text-[13px] leading-tight text-white/75">
          {partner.country && (
            <span aria-hidden="true">{countryFlag(partner.country)}</span>
          )}
          <span className="truncate">{place}</span>
        </span>
      )}
    </Plate>
  );
}

function Tile({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`relative aspect-video max-h-[38vh] w-full overflow-hidden lg:max-h-[62vh] rounded-2xl bg-ink-900 shadow-[0_1px_3px_rgba(15,23,42,0.08),0_8px_24px_rgba(15,23,42,0.06)] ${className}`}
    >
      {children}
    </div>
  );
}

function RemotePlaceholder({
  phase,
  queuePosition,
}: {
  phase: CallPhase;
  queuePosition: number;
}) {
  if (phase === "queued") {
    return (
      <div className="flex flex-col items-center gap-3">
        <div className="spinner h-8 w-8 rounded-full border-[3px] border-white/20 border-t-white/80" />
        <p className="text-sm font-medium text-white/80">
          {queuePosition > 0 ? `Waiting · #${queuePosition}` : "Waiting"}
        </p>
      </div>
    );
  }

  if (phase === "connecting" || phase === "partner-lost") {
    return (
      <div className="flex flex-col items-center gap-3">
        <div className="spinner h-8 w-8 rounded-full border-[3px] border-white/20 border-t-white/80" />
        <p className="text-sm font-medium text-white/80">Connecting</p>
      </div>
    );
  }

  return (
    <svg
      width="56"
      height="56"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="text-white/25"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" strokeLinecap="round" />
    </svg>
  );
}

export function VideoStage({
  localStream,
  remoteStream,
  phase,
  partner,
  selfName,
  isCameraOff,
  queuePosition,
}: Props) {
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);

  // srcObject is a property, not an attribute — React cannot set it via JSX.
  useEffect(() => {
    if (localRef.current && localRef.current.srcObject !== localStream) {
      localRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    const element = remoteRef.current;
    if (!element || element.srcObject === remoteStream) return;
    element.srcObject = remoteStream;
    if (!remoteStream) return;

    /*
     * `autoPlay` is not enough on iOS Safari once the stream carries audio:
     * playback is refused unless it is tied closely to a user gesture, and the
     * failure is silent — the element just sits there black. Asking
     * explicitly, and retrying muted if that is refused, is the difference
     * between "works everywhere" and "works except on iPhone".
     */
    element.play().catch(() => {
      element.muted = true;
      element.play().catch(() => {
        // Nothing more to try; the poster state stays visible.
      });
    });
  }, [remoteStream]);

  const showRemote = Boolean(remoteStream) && phase === "live";

  return (
    // Side by side on a laptop; the reference stacks them because it is a phone.
    <div className="grid flex-1 content-center gap-4 lg:grid-cols-2">
      <Tile>
        <video
          ref={remoteRef}
          autoPlay
          playsInline
          className={`h-full w-full object-cover transition-opacity duration-200 ${
            showRemote ? "opacity-100" : "opacity-0"
          }`}
        />
        {!showRemote && (
          <div className="absolute inset-0 grid place-items-center">
            <RemotePlaceholder phase={phase} queuePosition={queuePosition} />
          </div>
        )}
        {partner && showRemote && <PartnerPlate partner={partner} />}
      </Tile>

      <Tile>
        <video
          ref={localRef}
          autoPlay
          playsInline
          muted
          // Mirrored so the preview reads like a mirror rather than a video.
          className={`h-full w-full -scale-x-100 object-cover ${
            isCameraOff ? "invisible" : ""
          }`}
        />
        {isCameraOff && (
          <div className="absolute inset-0 grid place-items-center">
            <svg
              width="40"
              height="40"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              className="text-white/40"
              aria-hidden="true"
            >
              <path d="M2 8v8a2 2 0 0 0 2 2h9M15 11l7-4v10l-3-1.7M3 3l18 18" />
            </svg>
          </div>
        )}
        <NamePlate label={selfName} />
      </Tile>
    </div>
  );
}
