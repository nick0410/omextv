import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../lib/axios";

/**
 * The one page that answers "is this working for customers right now".
 *
 * Deliberately plain. It is read when something is wrong, usually in a hurry,
 * so the problems come first in words — a wall of counters requires knowing
 * what normal looks like, and nobody knows that at two in the morning.
 *
 * The numbers sit underneath for the times the answer is not obvious.
 */

interface Problem {
  level: "broken" | "degraded" | "note";
  what: string;
  why: string;
  fix: string;
}

interface Overview {
  checkedAt: string;
  problems: Problem[];
  health: {
    storeOk: boolean;
    dbOk: boolean;
    store: string;
    instance: string;
    version: string;
    nodeEnv: string;
    uptimeSec: number;
    genderProvider: string;
    genderReady: boolean;
  };
  payments: {
    provider: string;
    configured: boolean;
    confirmsAutomatically: boolean;
    mode: string | null;
    webhookReady: boolean | null;
    upiConfigured: boolean;
    adminCount: number;
  };
  calls: { hasTurn: boolean; stunCount: number; requiresVerification: boolean };
  live: {
    online: number;
    activeChats: number;
    queued: number;
    queuedPremium: number;
    queuedStandard: number;
    oldestWaitMs: number;
  };
  users: {
    total: number;
    today: number;
    week: number;
    premium: number;
    banned: number;
    /** Accounts under reserved domains — this project testing itself. */
    synthetic: number;
  };
  money: {
    grossPaise: number;
    byStatus: Record<string, number>;
    awaitingReview: number;
    stale: number;
    coinsOutstanding: number;
  };
  chats: { today: number; week: number; reportsWeek: number };
  people: Array<{
    id: string;
    username: string;
    email: string;
    gender: string;
    verifiedGender: string | null;
    country: string | null;
    coins: number;
    isPremium: boolean;
    isBanned: boolean;
    reportsAgainst: number;
    createdAt: string;
    lastSeenAt: string | null;
  }>;
  recentOrders: Array<{
    id: string;
    username: string;
    email: string;
    amountPaise: number;
    coins: number;
    status: string;
    paymentRef: string | null;
    note: string | null;
    createdAt: string;
  }>;
}

const rupees = (paise: number) => "₹" + (paise / 100).toLocaleString("en-IN");

/**
 * How long ago, in the fewest characters that still say it.
 *
 * Absolute timestamps are right for an order, which is a thing that happened;
 * for a person the useful question is how recently they were here, and
 * "3d" answers it without arithmetic.
 */
function ago(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

function duration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

const LEVEL_STYLE: Record<Problem["level"], string> = {
  broken: "border-danger-500/30 bg-danger-500/5",
  degraded: "border-amber-500/30 bg-amber-500/5",
  note: "border-ink-200 bg-white",
};

const LEVEL_LABEL: Record<Problem["level"], string> = {
  broken: "BROKEN",
  degraded: "DEGRADED",
  note: "NOTE",
};

const LEVEL_TEXT: Record<Problem["level"], string> = {
  broken: "text-danger-600",
  degraded: "text-amber-700",
  note: "text-ink-500",
};

export default function Admin() {
  const [data, setData] = useState<Overview | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "denied" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<Overview>("/admin/overview");
      setData(res.data);
      setState("ready");
      setError(null);
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 401 || status === 403) {
        setState("denied");
        return;
      }
      // Keep whatever was on screen. A failed refresh during an outage is the
      // moment the last known numbers are most useful.
      setError("Could not refresh. The API may be down — that is itself the answer.");
      if (!data) setState("error");
    }
  }, [data]);

  useEffect(() => {
    void load();
    // Short, because this is watched while something is being fixed.
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === "denied") {
    return (
      <Shell>
        <p className="text-ink-600">
          This page is for administrators. Add your email to <code>ADMIN_EMAILS</code> in{" "}
          <code>server/.env</code> and restart the API.
        </p>
      </Shell>
    );
  }

  if (state === "loading") return <Shell><p className="text-ink-500">Loading…</p></Shell>;
  if (state === "error" || !data) {
    return (
      <Shell>
        <p className="text-ink-700">Could not reach the API at all.</p>
        <p className="mt-2 text-sm text-ink-500">
          That usually means the server is down or the tunnel has dropped. Check{" "}
          <code>scripts/status.ps1</code>.
        </p>
      </Shell>
    );
  }

  const { health, payments, calls, live, users, money, chats } = data;

  return (
    <Shell>
      <header className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold text-ink-900">Status</h1>
        <span className="text-xs text-ink-400">
          checked {new Date(data.checkedAt).toLocaleTimeString()} · refreshes every 15s
        </span>
      </header>

      {error && (
        <p className="mb-4 rounded-xl bg-amber-500/10 px-3.5 py-2.5 text-sm text-amber-800">
          {error}
        </p>
      )}

      {/* The answer, before any numbers. */}
      <section className="mb-7">
        {data.problems.length === 0 ? (
          <p className="rounded-xl bg-emerald-500/10 px-3.5 py-3 text-sm font-medium text-emerald-800">
            Nothing is wrong. Customers can sign up, match, call and pay.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {data.problems.map((p, i) => (
              <li key={i} className={`rounded-xl border px-3.5 py-3 ${LEVEL_STYLE[p.level]}`}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className={`text-[11px] font-bold tracking-wide ${LEVEL_TEXT[p.level]}`}>
                    {LEVEL_LABEL[p.level]}
                  </span>
                  <span className="font-medium text-ink-900">{p.what}</span>
                </div>
                <p className="mt-1 text-sm text-ink-600">{p.why}</p>
                <p className="mt-1 text-sm text-ink-500">→ {p.fix}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Grid title="Right now">
        <Stat label="Online" value={live.online} />
        <Stat label="In a call" value={live.activeChats} />
        <Stat label="Waiting" value={live.queued} />
        <Stat
          label="Longest wait"
          value={live.oldestWaitMs ? duration(Math.round(live.oldestWaitMs / 1000)) : "—"}
        />
      </Grid>

      <Grid title="Money">
        <Stat label="Taken" value={rupees(money.grossPaise)} />
        <Stat label="Coins owed" value={money.coinsOutstanding.toLocaleString("en-IN")} />
        <Stat label="Awaiting review" value={money.awaitingReview} accent={money.awaitingReview > 0} />
        <Stat label="Paid orders" value={money.byStatus.approved ?? 0} />
      </Grid>

      <Grid title="People">
        <Stat label="Accounts" value={users.total.toLocaleString("en-IN")} />
        <Stat label="New today" value={users.today} />
        <Stat label="New this week" value={users.week} />
        <Stat label="Premium now" value={users.premium} />
      </Grid>

      {/*
        * Said out loud rather than quietly dropped.
        *
        * These counts exclude accounts on reserved domains, which is every
        * account the test scripts create. Before that, the page read "452
        * accounts, 134 new today" when five were people — a report on the test
        * suite, presented as a report on the business.
        */}
      {users.synthetic > 0 && (
        <p className="-mt-4 mb-7 text-xs text-ink-400">
          Excludes {users.synthetic.toLocaleString("en-IN")} test account
          {users.synthetic === 1 ? "" : "s"} created by the probe and smoke scripts.
        </p>
      )}

      <Grid title="Use">
        <Stat label="Calls today" value={chats.today} />
        <Stat label="Calls this week" value={chats.week} />
        <Stat label="Reports this week" value={chats.reportsWeek} accent={chats.reportsWeek > 0} />
        <Stat label="Banned" value={users.banned} />
      </Grid>

      <section className="mb-7">
        <H>Setup</H>
        <dl className="grid gap-x-6 gap-y-1.5 rounded-xl bg-white p-4 text-sm ring-1 ring-ink-200 sm:grid-cols-2">
          <Row label="Payment provider" ok={payments.configured}>
            {payments.provider}
            {payments.mode ? ` (${payments.mode} mode)` : ""}
            {payments.configured ? "" : " — not configured"}
          </Row>
          <Row label="Instant crediting" ok={payments.confirmsAutomatically}>
            {payments.confirmsAutomatically ? "yes" : "no — needs manual approval"}
          </Row>
          {payments.webhookReady !== null && (
            <Row label="Webhook" ok={payments.webhookReady}>
              {payments.webhookReady ? "verified" : "no secret set"}
            </Row>
          )}
          <Row label="Administrators" ok={payments.adminCount > 0}>{payments.adminCount}</Row>
          <Row label="TURN relay" ok={calls.hasTurn}>
            {calls.hasTurn ? "configured" : "missing — cross-network calls fail"}
          </Row>
          <Row label="STUN servers" ok={calls.stunCount > 0}>{calls.stunCount}</Row>
          <Row label="Database" ok={health.dbOk}>{health.dbOk ? "reachable" : "DOWN"}</Row>
          <Row label="Queue store" ok={health.storeOk}>
            {health.store}
            {health.storeOk ? "" : " — DOWN"}
          </Row>
          <Row label="Gender model" ok={health.genderReady}>{health.genderProvider}</Row>
          <Row label="Server" ok>
            v{health.version} · {health.nodeEnv} · up {duration(health.uptimeSec)}
          </Row>
        </dl>
      </section>

      <section className="mb-7">
        <H>People ({data.people.length})</H>
        {data.people.length === 0 ? (
          <p className="text-sm text-ink-500">Nobody has signed up yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl bg-white ring-1 ring-ink-200">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                <tr>
                  <th className="px-3 py-2 font-medium">Who</th>
                  <th className="px-3 py-2 font-medium">Gender</th>
                  <th className="px-3 py-2 font-medium">From</th>
                  <th className="px-3 py-2 font-medium">Coins</th>
                  <th className="px-3 py-2 font-medium">Joined</th>
                  <th className="px-3 py-2 font-medium">Last seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {data.people.map((u) => (
                  <tr key={u.id}>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <span className="text-ink-900">{u.username}</span>
                        {u.isPremium && (
                          <span className="text-xs text-emerald-700">premium</span>
                        )}
                        {u.isBanned && (
                          <span className="text-xs text-danger-600">banned</span>
                        )}
                        {u.reportsAgainst > 0 && (
                          <span className="text-xs text-amber-700">
                            {u.reportsAgainst} report{u.reportsAgainst > 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-ink-400">{u.email}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-600">
                      {u.gender}
                      {/*
                        * Only worth showing when it disagrees with what they
                        * said — agreement is the normal case and repeating it
                        * on every row buries the rows that differ.
                        */}
                      {u.verifiedGender && u.verifiedGender !== u.gender && (
                        <span className="text-amber-700"> · seen {u.verifiedGender}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-600">
                      {u.country ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-ink-900">
                      {u.coins}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-500">
                      {ago(u.createdAt)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-500">
                      {ago(u.lastSeenAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mb-7">
        <H>Latest orders</H>
        {data.recentOrders.length === 0 ? (
          <p className="text-sm text-ink-500">No orders yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl bg-white ring-1 ring-ink-200">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-ink-100 text-xs uppercase tracking-wide text-ink-400">
                <tr>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Who</th>
                  <th className="px-3 py-2 font-medium">Amount</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Reference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {data.recentOrders.map((o) => (
                  <tr key={o.id}>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-500">
                      {new Date(o.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-ink-900">{o.username}</div>
                      <div className="text-xs text-ink-400">{o.email}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-900">
                      {rupees(o.amountPaise)}
                      <span className="text-ink-400"> · {o.coins}c</span>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          o.status === "approved"
                            ? "text-emerald-700"
                            : o.status === "under_review"
                              ? "text-amber-700"
                              : "text-ink-500"
                        }
                      >
                        {o.status.replace("_", " ")}
                      </span>
                      {o.note && <div className="text-xs text-ink-400">{o.note}</div>}
                    </td>
                    <td className="select-all px-3 py-2 font-mono text-xs text-ink-600">
                      {o.paymentRef ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <nav className="flex flex-wrap gap-x-4 gap-y-2 border-t border-ink-100 pt-5 text-sm">
        <Link to="/review" className="text-brand-600 hover:text-brand-700">
          Payments to approve
          {money.awaitingReview > 0 && ` (${money.awaitingReview})`}
        </Link>
        <Link to="/diagnostics" className="text-ink-500 hover:text-ink-800">Connection test</Link>
        <Link to="/chat" className="text-ink-500 hover:text-ink-800">Back to chat</Link>
      </nav>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-4xl px-4 py-8 sm:px-6">{children}</main>
  );
}

function H({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2.5 text-[13px] font-semibold uppercase tracking-wide text-ink-400">
      {children}
    </h2>
  );
}

function Grid({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <H>{title}</H>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">{children}</div>
    </section>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl bg-white p-3.5 ring-1 ring-ink-200">
      <div
        className={`text-xl font-semibold tabular-nums ${accent ? "text-amber-700" : "text-ink-900"}`}
      >
        {value}
      </div>
      <div className="mt-0.5 text-xs text-ink-500">{label}</div>
    </div>
  );
}

function Row({
  label,
  ok,
  children,
}: {
  label: string;
  ok: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${ok ? "bg-emerald-500" : "bg-danger-500"}`}
      />
      <dt className="text-ink-500">{label}</dt>
      <dd className="ml-auto text-right text-ink-900">{children}</dd>
    </div>
  );
}
