import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { useCall } from "../hooks/useCall";
import { useAuthStore } from "../store/authStore";
import { VideoStage } from "../components/VideoStage";
import { ControlBar } from "../components/ControlBar";
import { ChatPanel } from "../components/ChatPanel";
import { FilterPanel } from "../components/FilterPanel";
import { ActiveFilters } from "../components/ActiveFilters";
import { premiumIsActive, useWallet } from "../hooks/useWallet";
import { useOnlineCountries } from "../hooks/useOnlineCountries";
import { ReportModal } from "../components/ReportModal";
import { Logo } from "../components/Logo";
import { useGenderDetect } from "../hooks/useGenderDetect";
import { DEFAULT_FILTERS, oppositeGender } from "../lib/types";
import type { MatchFilters } from "../lib/types";
import { getSocket } from "../lib/socket";

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
  /*
   * Read from the expiry, not the stored flag.
   *
   * `isPremium` stays true after a pass lapses until something writes it back,
   * so trusting it alone would leave the filters looking unlocked while the
   * server quietly ignored them — the user picks "Women", meets everyone, and
   * concludes the app is broken rather than that they need to top up.
   */
  const isPremium = premiumIsActive(user);

  /*
   * The balance, where it is actually looked at.
   *
   * It only existed on the store page, which is the one place someone already
   * knows what it is. Anywhere a coin can be spent, the number has to be in
   * sight — otherwise the first time you learn you are out is when something
   * refuses to work.
   */
  const { wallet, refresh: refreshWallet } = useWallet();

  /*
   * Show the balance dropping when it drops.
   *
   * The server charges for a call once it has run long enough, and without
   * this the coins simply disappear — the number in the header stays stale
   * until the page is reloaded. Money leaving silently is the worst way for a
   * paid feature to behave, and the first thing anyone would write in to
   * complain about.
   */
  useEffect(() => {
    const socket = getSocket();
    const onCharged = () => void refreshWallet();
    socket.on("coins-charged", onCharged);
    return () => {
      socket.off("coins-charged", onCharged);
    };
  }, [refreshWallet]);
  const logout = useAuthStore((s) => s.logout);
  const [filters, setFilters] = useState<MatchFilters>(loadFilters);
  const [showReport, setShowReport] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
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

  /*
   * Only for an account that can actually have it.
   *
   * This used to apply the detected-gender default to everyone, including free
   * accounts the server then clamps back to "anyone". The app was setting a
   * filter you could not use, telling you it was searching that way, and only
   * admitting otherwise after you pressed start — a contradiction it created
   * for itself and then blamed on the paywall.
   */
  if (
    isPremium &&
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

  const onlineCountries = useOnlineCountries();
  const isLive = state.phase === "live";


  const inCall = isLive || state.phase === "connecting";
  const filtersLocked = state.phase === "queued" || inCall;

  const TABS = [
    { id: "chat", label: "Chat" },
    { id: "filters", label: "Filters" },
  ] as const;

  return (
    /*
     * One screenful, at every size.
     *
     * A phone was already held to the viewport; a laptop was let grow and
     * scroll, on the reasoning that it has the room. It does not: the header,
     * two video tiles, the filter strip and the control bar came to more than
     * a 900-tall window, so Start — the only thing a new arrival needs — sat
     * below the fold with nothing on screen suggesting there was more. The
     * bigger display had the worse first minute.
     *
     * Holding the height here means the stage has a real one to divide up,
     * which is what lets the tiles size themselves below instead of guessing
     * with vh.
     */
    <div className="flex h-dvh flex-col overflow-hidden">
      <h1 className="sr-only">Omextv video chat</h1>
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

            {/*
              * The way in to the store, and the only place premium is visible
              * before someone hits a locked filter. A premium account sees a
              * plain badge instead — nothing to buy, so nothing to sell.
              */}
            <Link
              to="/coins"
              className={`flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium transition-colors ${
                isPremium
                  ? "text-emerald-700 hover:bg-emerald-500/10"
                  : "text-brand-600 hover:bg-brand-500/10"
              }`}
            >
              <span aria-hidden="true">{isPremium ? "✦" : "◎"}</span>
              {/*
                * The number first, the word second. On a phone the word is the
                * part that goes, because "◎ 500" still says everything.
                */}
              <span className="tabular-nums">{wallet ? wallet.coins : "—"}</span>
              <span className="hidden sm:inline">
                {isPremium ? "Premium" : "coins"}
              </span>
            </Link>

            <span className="hidden text-sm font-medium text-ink-700 sm:inline">
              {user?.username}
            </span>

            <button
              onClick={logout}
              className="min-h-11 rounded-lg px-3 text-sm text-ink-500 transition-colors hover:text-ink-900"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {state.error && (
        <div className="border-b border-danger-500/20 bg-danger-500/5">
          <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-3 px-3 py-2 lg:px-5">
            <p className="min-w-0 text-sm text-danger-600">
              {state.error}{" "}
              {/* The moment someone needs this is the moment a call failed. */}
              <Link
                to="/diagnostics"
                className="whitespace-nowrap font-medium underline underline-offset-2"
              >
                Test my connection
              </Link>
            </p>
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

      <main className="mx-auto flex w-full min-h-0 max-w-[1400px] flex-1 flex-col gap-3 px-3 pb-3 pt-3 lg:grid lg:grid-cols-[1fr_340px] lg:gap-6 lg:px-5 lg:py-5">
        <div className="flex min-h-0 flex-1 flex-col gap-3 lg:gap-4">
          <VideoStage
            localStream={localStream}
            remoteStream={remoteStream}
            phase={state.phase}
            partner={state.partner}
            selfName={user?.username ?? "You"}
            isCameraOff={state.isCameraOff}
            queuePosition={state.queuePosition}
          />

          <ActiveFilters
            filters={filters}
            online={onlineCountries}
            queued={state.phase === "queued"}
            restricted={state.restrictedFilters}
            isPremium={isPremium}
            onClearAll={() => {
              // Also stop the detected-gender default from re-applying itself.
              setSuggestionApplied(true);
              setFilters({ gender: "any", countries: [], city: null });
            }}
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

        {/* A sheet on a phone, a column on a laptop. Inline on mobile it pushed
            the controls below the fold and made the page scroll during a call. */}
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="min-h-11 rounded-xl bg-white px-4 text-sm font-medium text-ink-700 ring-1 ring-ink-200 lg:hidden"
        >
          Chat and filters
        </button>

        {sheetOpen && (
          <button
            type="button"
            aria-label="Close"
            onClick={() => setSheetOpen(false)}
            className="fixed inset-0 z-40 bg-ink-900/40 backdrop-blur-sm lg:hidden"
          />
        )}

        <aside
          className={`z-50 flex flex-col gap-4 max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:h-[72dvh] max-lg:rounded-t-2xl max-lg:bg-ink-50 max-lg:p-3 max-lg:pb-[max(0.75rem,env(safe-area-inset-bottom))] max-lg:shadow-[0_-8px_40px_rgba(15,23,42,0.18)] max-lg:transition-transform lg:min-h-[520px] ${
            sheetOpen ? "max-lg:translate-y-0" : "max-lg:translate-y-full"
          }`}
        >
          <button
            type="button"
            onClick={() => setSheetOpen(false)}
            aria-label="Close"
            className="mx-auto h-1.5 w-10 shrink-0 rounded-full bg-ink-300 lg:hidden"
          />
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
                className={`min-h-11 flex-1 rounded-lg px-3 text-sm font-medium transition-colors ${
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
              isPremium={isPremium}
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
