import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../lib/axios";

/**
 * The approval queue — where money becomes coins.
 *
 * This is the manual step a direct UPI transfer forces, so the screen is built
 * around the check rather than around clearing the list: the reference is
 * shown large and copyable because it is what gets searched for in a bank
 * statement, and approve is never the easiest thing to press by accident.
 *
 * Reachable only by an account listed in ADMIN_EMAILS. The route is not
 * secret — the server refuses everyone else, which is the part that matters.
 */

interface ReviewOrder {
  id: string;
  packId: string;
  coins: number;
  amountPaise: number;
  status: string;
  paymentRef: string | null;
  note: string | null;
  createdAt: string;
  username: string;
  email: string;
}

const rupees = (paise: number) => (paise / 100).toLocaleString("en-IN");

export default function Review() {
  const [orders, setOrders] = useState<ReviewOrder[]>([]);
  const [status, setStatus] = useState("under_review");
  const [state, setState] = useState<"loading" | "ready" | "denied" | "error">("loading");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ orders: ReviewOrder[] }>("/coins/admin/orders", {
        params: { status },
      });
      setOrders(res.data.orders);
      setState("ready");
    } catch (err) {
      const code = (err as { response?: { status?: number } }).response?.status;
      setState(code === 403 || code === 401 ? "denied" : "error");
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (order: ReviewOrder, action: "approve" | "reject") => {
    if (action === "reject") {
      const note = window.prompt(
        `Reject ${order.username}'s order for ₹${rupees(order.amountPaise)}?\nReason shown to them:`,
        "No matching payment found.",
      );
      if (note === null) return;
      setBusyId(order.id);
      try {
        await api.post(`/coins/admin/orders/${order.id}/reject`, { note });
      } finally {
        setBusyId(null);
      }
    } else {
      setBusyId(order.id);
      try {
        await api.post(`/coins/admin/orders/${order.id}/approve`);
      } finally {
        setBusyId(null);
      }
    }
    await load();
  };

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

  return (
    <Shell>
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-ink-900">Payments</h1>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="min-h-11 rounded-xl bg-ink-100 px-3 text-sm text-ink-900 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="under_review">Waiting for review</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="all">All</option>
        </select>
      </header>

      {state === "loading" && <p className="text-ink-500">Loading…</p>}
      {state === "error" && <p className="text-ink-600">Could not load the queue.</p>}

      {state === "ready" && orders.length === 0 && (
        <p className="text-ink-500">Nothing here.</p>
      )}

      <ul className="space-y-2.5">
        {orders.map((order) => (
          <li key={order.id} className="rounded-xl bg-white p-4 ring-1 ring-ink-200">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-medium text-ink-900">₹{rupees(order.amountPaise)}</span>
              <span className="text-sm text-ink-500">
                {order.coins.toLocaleString("en-IN")} coins
              </span>
              <span className="ml-auto text-xs text-ink-400">
                {new Date(order.createdAt).toLocaleString()}
              </span>
            </div>

            <div className="mt-1 text-sm text-ink-600">
              {order.username} · {order.email}
            </div>

            {/* The number to search the bank statement for. */}
            <div className="mt-2.5 rounded-lg bg-ink-100 px-3 py-2">
              <div className="text-xs uppercase tracking-wide text-ink-400">Payment reference</div>
              <div className="select-all break-all font-mono text-sm text-ink-900">
                {order.paymentRef ?? "—"}
              </div>
            </div>

            {order.note && <div className="mt-2 text-xs text-ink-500">{order.note}</div>}

            {order.status === "under_review" && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busyId === order.id}
                  onClick={() => act(order, "approve")}
                  className="min-h-11 rounded-xl bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  Payment received — add {order.coins.toLocaleString("en-IN")} coins
                </button>
                <button
                  type="button"
                  disabled={busyId === order.id}
                  onClick={() => act(order, "reject")}
                  className="min-h-11 rounded-xl bg-ink-100 px-4 text-sm font-medium text-ink-700 hover:bg-ink-200 disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <p className="mt-8 text-sm">
        <Link to="/chat" className="text-brand-600 hover:text-brand-700">
          ← Back to chat
        </Link>
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-3xl px-4 py-8 sm:px-6">{children}</main>
  );
}
