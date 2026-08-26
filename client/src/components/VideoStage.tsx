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

// Deliberately carries no `position`. Listing `relative` here and `absolute`
// on a tile does not override it — CSS resolves by stylesheet order, not by
// the order classes appear in the attribute, so the base class won and the
// picture-in-picture tile silently stayed in the flow.
const TILE_SHELL =
  "overflow-hidden bg-ink-900 " +
  "shadow-[0_1px_3px_rgba(15,23,42,0.08),0_8px_24px_rgba(15,23,42,0.06)]";

/*
 * On a phone the other person fills the screen and you sit in a corner, the
 * way every video call app does it. Two stacked 38vh tiles meant the person
 * you were talking to was tiny and the controls were below the fold.
 *
 * A laptop keeps both people visible side by side, but no longer at equal
 * size. The stranger is the point of the page and you already know what you
 * look like; giving yourself half the stage spent the largest area on screen
 * on the least interesting thing in the room. The grid below is weighted
 * instead, so the person being met is plainly the subject.
 *
 * Heights come from the row, not from vh. The stage sits inside a column that
 * is already bounded by the viewport, so `h-full` divides real leftover space
 * — where `max-h-[62vh]` was a guess that ignored the header and the controls
 * and overflowed on a short window.
 *
 * Both breakpoints share one pair of <video> elements. Rendering a separate
 * mobile tree would mean two decoders for the same stream, which phones
 * handle badly.
 */
const REMOTE_TILE =
  `${TILE_SHELL} relative h-full w-full rounded-2xl ` +
  "lg:h-full lg:w-full";

const LOCAL_TILE =
  `${TILE_SHELL} absolute right-3 top-3 z-20 w-[28vw] max-w-[132px] ` +
  "aspect-[3/4] rounded-xl ring-1 ring-white/15 " +
  // lg:relative, not lg:static — the tile has to stay a positioning context or
  // the name plate inside it escapes and lands somewhere else on the page.
  "lg:relative lg:inset-auto lg:aspect-auto lg:h-full lg:w-full lg:max-w-none " +
  "lg:rounded-2xl lg:ring-0";

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

  /*
   * Idle. A silhouette on a dark rectangle says nothing about what to do, and
   * this is the very first thing anyone sees after allowing the camera — the
   * moment the page has to explain itself or lose the person.
   */
  return (
    <div className="flex flex-col items-center gap-3 px-6 text-center">
      <svg
        width="48"
        height="48"
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
      <p className="text-[15px] font-medium text-white/70">
        Whoever you meet appears here
      </p>
      <p className="text-[13px] text-white/40">Press Start when you are ready</p>
    </div>
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
    // Side by side on a laptop, weighted towards the stranger; a phone stacks
    // them because it has no room to do anything else.
    <div className="relative flex min-h-0 flex-1 lg:grid lg:gap-4 lg:grid-cols-[1.7fr_1fr]">
      <div className={REMOTE_TILE}>
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
      </div>

      <div className={LOCAL_TILE}>
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
        {/* Your own name is noise in a thumbnail you are already looking at. */}
        <div className="hidden lg:block">
          <NamePlate label={selfName} />
        </div>
      </div>
    </div>
  );
}
