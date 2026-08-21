import { useEffect, useState } from "react";
import { useCall } from "../hooks/useCall";
import { useAuthStore } from "../store/authStore";
import { VideoStage } from "../components/VideoStage";
import { ControlBar } from "../components/ControlBar";
import { ChatPanel } from "../components/ChatPanel";
import { FilterPanel } from "../components/FilterPanel";
import { ReportModal } from "../components/ReportModal";
import { Logo } from "../components/Logo";
import { useGenderDetect } from "../hooks/useGenderDetect";
import { DEFAULT_FILTERS, oppositeGender } from "../lib/types";
import type { MatchFilters } from "../lib/types";

const FILTERS_KEY = "omextv.filters";

function loadFilters(): MatchFilters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return DEFAULT_FILTERS;
    return { ...DEFAULT_FILTERS, ...(JSON.parse(raw) as MatchFilters) };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

/**
 * Call duration.
 *
 * A separate component so it is mounted only while the call is live: its state
 * then starts at zero on its own, with no effect resetting it and no clock
 * read during render. Both of those are what make a timer awkward to write
 * inline.
 */
function CallTimer() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <span className="tabular text-sm font-medium text-ink-700">
      {formatDuration(elapsed)}
    </span>
  );
}

export default function Chat() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [filters, setFilters] = useState<MatchFilters>(loadFilters);
  const [showReport, setShowReport] = useState(false);
  const [tab, setTab] = useState<"chat" | "filters">("chat");
  // Applied at most once, so a deliberate choice is never overwritten.
  const [suggestionApplied, setSuggestionApplied] = useState(false);

  const {
    state,
    localStream,
    remoteStream,
    startCamera,
    start,
    cancelQueue,
    skip,
    endChat,
    sendMessage,
    setTyping,
    toggleMute,
    toggleCamera,
    clearError,
  } = useCall();

  useEffect(() => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  }, [filters]);

  // Runs once the camera is up; the result only picks a default.
  const detect = useGenderDetect(localStream);

  /*
   * Suggest the opposite gender — but only once, and only if the user has not
   * already chosen. Re-applying it on every render would fight anyone who
   * deliberately picks something else.
   */
  const suggestion = oppositeGender(detect.detected ?? user?.gender);

  if (
    !suggestionApplied &&
    suggestion !== "any" &&
    filters.gender === "any"
  ) {
    setSuggestionApplied(true);
    setFilters((prev) => ({ ...prev, gender: suggestion }));
  }

  // Warm the camera up front: asking for permission at the moment of matching
  // costs a partner, because the other side waits on a browser prompt.
  useEffect(() => {
    void startCamera();
  }, [startCamera]);

  const isLive = state.phase === "live";


  const inCall = isLive || state.phase === "connecting";
  const filtersLocked = state.phase === "queued" || inCall;

  const TABS = [
    { id: "chat", label: "Chat" },
    { id: "filters", label: "Filters" },
  ] as const;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-ink-200/70 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between px-5">
          <Logo />

          <div className="flex items-center gap-4">
            {isLive && (
              <div className="flex items-center gap-2.5">
                <span className="flex items-center gap-1.5 rounded-full bg-danger-500/10 px-2.5 py-1">
                  <span className="live-dot h-1.5 w-1.5 rounded-full bg-danger-500" />
                  <span className="text-[11px] font-semibold tracking-wide text-danger-500">
                    LIVE
                  </span>
                </span>
                <CallTimer />
              </div>
            )}

            <span className="flex items-center gap-1.5 text-sm text-ink-500">
              <span className="h-1.5 w-1.5 rounded-full bg-success-500" />
              {state.onlineCount}
            </span>

            <span className="hidden text-sm font-medium text-ink-700 sm:inline">
              {user?.username}
            </span>

            <button
              onClick={logout}
              className="rounded-lg px-2 py-1 text-sm text-ink-500 transition-colors hover:text-ink-900"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {state.error && (
        <div className="border-b border-danger-500/20 bg-danger-500/5">
          <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-5 py-2">
            <p className="text-sm text-danger-600">{state.error}</p>
            <button
              onClick={clearError}
              aria-label="Dismiss"
              className="shrink-0 text-sm text-danger-500"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <main className="mx-auto grid w-full max-w-[1400px] flex-1 gap-6 px-5 py-6 lg:grid-cols-[1fr_340px]">
        <div className="flex min-h-0 flex-col gap-6">
          <VideoStage
            localStream={localStream}
            remoteStream={remoteStream}
            phase={state.phase}
            partner={state.partner}
            selfName={user?.username ?? "You"}
            isCameraOff={state.isCameraOff}
            queuePosition={state.queuePosition}
          />

          <ControlBar
            phase={state.phase}
            isMuted={state.isMuted}
            isCameraOff={state.isCameraOff}
            onStart={() => void start(filters)}
            onSkip={() => skip(filters)}
            onEnd={endChat}
            onCancelQueue={cancelQueue}
            onToggleMute={toggleMute}
            onToggleCamera={toggleCamera}
            onReport={() => setShowReport(true)}
          />
        </div>

        <aside className="flex min-h-[520px] flex-col gap-4">
          <div
            role="tablist"
            className="flex gap-1 rounded-xl bg-white p-1 ring-1 ring-ink-200"
          >
            {TABS.map((item) => (
              <button
                key={item.id}
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => setTab(item.id)}
                className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  tab === item.id
                    ? "bg-brand-500 text-white"
                    : "text-ink-500 hover:text-ink-900"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          {tab === "chat" && (
            <ChatPanel
              messages={state.messages}
              myUserId={user?.id ?? null}
              disabled={!isLive}
              partnerTyping={state.partnerTyping}
              onSend={sendMessage}
              onTyping={setTyping}
            />
          )}

          {tab === "filters" && (
            <FilterPanel
              filters={filters}
              onChange={setFilters}
              disabled={filtersLocked}
              suggested={suggestion === "any" ? null : suggestion}
            />
          )}
        </aside>
      </main>

      {state.partner && (
        <ReportModal
          partner={state.partner}
          open={showReport}
          onClose={() => setShowReport(false)}
          onReported={endChat}
        />
      )}
    </div>
  );
}
