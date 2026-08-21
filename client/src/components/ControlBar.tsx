import type { CallPhase } from "../lib/types";

interface Props {
  phase: CallPhase;
  isMuted: boolean;
  isCameraOff: boolean;
  onStart: () => void;
  onSkip: () => void;
  onEnd: () => void;
  onCancelQueue: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onReport: () => void;
}

type Variant = "default" | "active" | "primary" | "danger";

const VARIANTS: Record<Variant, string> = {
  default: "bg-brand-500 text-white hover:bg-brand-600",
  active: "bg-white text-ink-700 ring-1 ring-ink-200 hover:bg-ink-100",
  primary: "bg-brand-500 text-white hover:bg-brand-600",
  danger: "bg-danger-500 text-white hover:bg-danger-600",
};

/** Circular button with a label underneath, as in the reference layout. */
function Control({
  label,
  variant = "default",
  large = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  variant?: Variant;
  large?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex w-20 flex-col items-center">
      {/* Fixed-height slot so a large button does not push its label out of
          line with the smaller ones beside it. */}
      <div className="flex h-16 items-center">
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className={`grid place-items-center rounded-full shadow-[0_2px_8px_rgba(15,23,42,0.12)] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            large ? "h-16 w-16" : "h-12 w-12"
          } ${VARIANTS[variant]}`}
        >
          {children}
        </button>
      </div>
      <span className="mt-2 text-[13px] font-medium leading-none text-ink-500">
        {label}
      </span>
    </div>
  );
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const MicOn = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);
const MicOff = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
    <path d="M9 9V6a3 3 0 0 1 6 0v5M5 11a7 7 0 0 0 11 5.5M12 18v3M3 3l18 18" />
  </svg>
);
const CamOn = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" {...stroke}>
    <rect x="2" y="6" width="13" height="12" rx="2.5" />
    <path d="m15 11 7-4v10l-7-4z" />
  </svg>
);
const CamOff = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" {...stroke}>
    <path d="M2 8v8a2 2 0 0 0 2 2h9M15 11l7-4v10l-3-1.7M3 3l18 18" />
  </svg>
);
const Next = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
    <path d="m5 5 9 7-9 7zM19 5v14" />
  </svg>
);
const EndCall = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" {...stroke}>
    <path d="M3 10.5a14 14 0 0 1 18 0v3l-4 .8-.8-3a11 11 0 0 0-8.4 0l-.8 3-4-.8z" />
  </svg>
);
const Report = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v6M12 16.5v.5" />
  </svg>
);
const Play = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" {...stroke}>
    <path d="m7 5 12 7-12 7z" />
  </svg>
);
const Stop = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

export function ControlBar({
  phase,
  isMuted,
  isCameraOff,
  onStart,
  onSkip,
  onEnd,
  onCancelQueue,
  onToggleMute,
  onToggleCamera,
  onReport,
}: Props) {
  const inCall = phase === "live" || phase === "connecting" || phase === "partner-lost";
  const queued = phase === "queued";

  return (
    <div className="flex flex-wrap items-start justify-center gap-x-5 gap-y-4">
      <Control
        label={isMuted ? "Unmute" : "Mute"}
        variant={isMuted ? "active" : "default"}
        onClick={onToggleMute}
      >
        {isMuted ? <MicOff /> : <MicOn />}
      </Control>

      <Control
        label={isCameraOff ? "Camera on" : "Camera"}
        variant={isCameraOff ? "active" : "default"}
        onClick={onToggleCamera}
      >
        {isCameraOff ? <CamOff /> : <CamOn />}
      </Control>

      {!inCall && !queued && (
        <Control label="Start" variant="primary" large onClick={onStart}>
          <Play />
        </Control>
      )}

      {queued && (
        <Control label="Cancel" variant="danger" large onClick={onCancelQueue}>
          <Stop />
        </Control>
      )}

      {inCall && (
        <>
          <Control label="End" variant="danger" large onClick={onEnd}>
            <EndCall />
          </Control>

          <Control label="Skip" onClick={onSkip}>
            <Next />
          </Control>

          <Control label="Report" variant="active" onClick={onReport}>
            <Report />
          </Control>
        </>
      )}
    </div>
  );
}
