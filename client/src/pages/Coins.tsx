import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import QRCode from "qrcode";
import api from "../lib/axios";
import { useWallet } from "../hooks/useWallet";
import { useAuthStore } from "../store/authStore";
import type { CoinOrder, CoinPack, CoinPass, PaymentInstruction } from "../lib/types";

/**
 * Buying coins, and turning them into premium.
 *
 * The flow is longer than a card checkout and that is not an oversight. A
 * direct UPI transfer tells the server nothing at all, so somebody has to look
 * at a bank statement before coins appear. Hiding that behind a spinner and a
 * cheerful "activating..." would be a lie the user discovers minutes later, so
 * every screen here says exactly where the money is: not paid, waiting to be
 * checked, or done.
 */

const rupees = (paise: number) => (paise / 100).toLocaleString("en-IN");

function errorFrom(err: unknown, fallback: string): string {
  const res = (err as { response?: { data?: { error?: string } } }).response;
  return res?.data?.error ?? fallback;
}

const STATUS_LABEL: Record<string, string> = {
  awaiting_payment: "Not paid yet",
  under_review: "Checking your payment",
  approved: "Coins added",
  rejected: "Not accepted",
};

export default function Coins() {
  const { wallet, loading, error, refresh } = useWallet();
  const fetchMe = useAuthStore((s) => s.fetchMe);
  const [orders, setOrders] = useState<CoinOrder[]>([]);
  const [checkout, setCheckout] = useState<{ order: CoinOrder; payment: PaymentInstruction } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const loadOrders = useCallback(async () => {
    try {
      const res = await api.get<{ orders: CoinOrder[] }>("/coins/orders");
      setOrders(res.data.orders);
    } catch {
      /* The balance above is the important part; a missing history is survivable. */
    }
  }, []);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  const buyPack = async (pack: CoinPack) => {
    setBusy(true);
    setProblem(null);
    try {
      const res = await api.post<{ order: CoinOrder; payment: PaymentInstruction }>("/coins/orders", {
        packId: pack.id,
      });
      setCheckout(res.data);
      await loadOrders();
    } catch (err) {
      setProblem(errorFrom(err, "Could not start the payment."));
    } finally {
      setBusy(false);
    }
  };

  /** Fetch the payment instruction for an order started earlier. */
  const resume = async (order: CoinOrder) => {
    setBusy(true);
    setProblem(null);
    try {
      const res = await api.get<{ order: CoinOrder; payment: PaymentInstruction }>(
        `/coins/orders/${order.id}/payment`,
      );
      setCheckout(res.data);
    } catch (err) {
      setProblem(errorFrom(err, "Could not reopen that order."));
    } finally {
      setBusy(false);
    }
  };

  const abandon = async (order: CoinOrder) => {
    setBusy(true);
    setProblem(null);
    try {
      await api.post(`/coins/orders/${order.id}/cancel`);
      await loadOrders();
    } catch (err) {
      setProblem(errorFrom(err, "Could not cancel that order."));
    } finally {
      setBusy(false);
    }
  };

  const redeem = async (pass: CoinPass) => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      await api.post("/coins/passes", { passId: pass.id });
      await Promise.all([refresh(), fetchMe()]);
      setNotice(`Premium is on for ${pass.name}. Pick who you meet from the filters.`);
    } catch (err) {
      setProblem(errorFrom(err, "Could not use your coins."));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <Shell><p className="text-ink-500">Loading…</p></Shell>;
  }

  if (error || !wallet) {
    return (
      <Shell>
        <p className="text-ink-600">{error ?? "Could not load your balance."}</p>
      </Shell>
    );
  }

  const premiumUntil = wallet.premiumExpiry ? new Date(wallet.premiumExpiry) : null;
  const premiumLive = wallet.isPremium;

  return (
    <Shell>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">Coins</h1>
          <p className="mt-1 text-sm text-ink-500">
            Coins unlock choosing who you meet — a gender, or a country.
          </p>
        </div>
        <div className="text-right">
          <div className="text-3xl font-semibold tabular-nums text-ink-900">{wallet.coins}</div>
          <div className="text-xs uppercase tracking-wide text-ink-400">coins</div>
        </div>
      </header>

      {premiumLive && (
        <p className="mb-5 rounded-xl bg-emerald-500/10 px-3.5 py-2.5 text-sm text-emerald-800">
          Premium is on
          {premiumUntil && ` until ${premiumUntil.toLocaleDateString()}`}. Filters are yours.
        </p>
      )}
      {notice && (
        <p className="mb-5 rounded-xl bg-brand-500/10 px-3.5 py-2.5 text-sm text-brand-700">
          {notice}
        </p>
      )}
      {problem && (
        <p className="mb-5 rounded-xl bg-amber-500/10 px-3.5 py-2.5 text-sm text-amber-800">
          {problem}
        </p>
      )}

      {checkout ? (
        <Checkout
          checkout={checkout}
          onDone={async () => {
            setCheckout(null);
            await Promise.all([loadOrders(), refresh()]);
          }}
          onCancel={async () => {
            setCheckout(null);
            await loadOrders();
          }}
        />
      ) : (
        <>
          <Section title="Use your coins">
            <div className="grid gap-2.5 sm:grid-cols-3">
              {wallet.passes.map((pass) => {
                const affordable = wallet.coins >= pass.cost;
                return (
                  <button
                    key={pass.id}
                    type="button"
                    disabled={busy || !affordable}
                    onClick={() => redeem(pass)}
                    className="rounded-xl bg-white p-4 text-left ring-1 ring-ink-200 transition-colors enabled:hover:ring-brand-400 disabled:opacity-55"
                  >
                    <div className="font-medium text-ink-900">{pass.name} of premium</div>
                    <div className="mt-1 text-sm text-ink-500">{pass.cost} coins</div>
                    {!affordable && (
                      <div className="mt-1.5 text-xs text-ink-400">
                        {pass.cost - wallet.coins} more needed
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </Section>

          {wallet.purchasesEnabled ? (
            <Section title="Get more coins">
              <div className="grid gap-2.5 sm:grid-cols-3">
                {wallet.packs.map((pack) => (
                  <button
                    key={pack.id}
                    type="button"
                    disabled={busy}
                    onClick={() => buyPack(pack)}
                    className={`rounded-xl p-4 text-left ring-1 transition-colors disabled:opacity-55 ${
                      pack.best
                        ? "bg-brand-500/5 ring-brand-400"
                        : "bg-white ring-ink-200 hover:ring-brand-400"
                    }`}
                  >
                    <div className="text-lg font-semibold text-ink-900">
                      {pack.coins.toLocaleString("en-IN")} coins
                    </div>
                    <div className="mt-0.5 text-sm text-ink-600">₹{rupees(pack.amountPaise)}</div>
                    {pack.bonusCoins > 0 && (
                      <div className="mt-1.5 inline-block rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-xs font-medium text-emerald-700">
                        +{pack.bonusCoins} bonus
                      </div>
                    )}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-400">
                Paid over UPI. Coins are added once we match your payment against the account —
                usually quickly, but it is a person checking, not a machine.
              </p>
            </Section>
          ) : (
            <Section title="Get more coins">
              <p className="text-sm text-ink-500">
                Buying coins is not switched on yet.
              </p>
            </Section>
          )}

          {orders.length > 0 && (
            <Section title="Your orders">
              <ul className="divide-y divide-ink-100 rounded-xl bg-white ring-1 ring-ink-200">
                {orders.map((order) => (
                  <li key={order.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-3 text-sm">
                    <span className="font-medium text-ink-900">
                      {order.coins.toLocaleString("en-IN")} coins
                    </span>
                    <span className="text-ink-500">₹{rupees(order.amountPaise)}</span>
                    <span
                      className={`ml-auto rounded-md px-2 py-0.5 text-xs font-medium ${
                        order.status === "approved"
                          ? "bg-emerald-500/10 text-emerald-700"
                          : order.status === "rejected"
                            ? "bg-ink-100 text-ink-500"
                            : "bg-amber-500/10 text-amber-800"
                      }`}
                    >
                      {STATUS_LABEL[order.status] ?? order.status}
                    </span>
                    {order.note && (
                      <span className="w-full text-xs text-ink-400">{order.note}</span>
                    )}

                    {/*
                      * A way back to an order started earlier.
                      *
                      * Without these the list was a dead end: an unpaid order
                      * showed its status and nothing else, so a buyer who
                      * closed the page could neither reach the QR again nor
                      * abandon it — and after five such orders the cap stopped
                      * them starting a sixth.
                      */}
                    {(order.status === "awaiting_payment" || order.status === "rejected") && (
                      <span className="flex w-full gap-2 sm:w-auto">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => resume(order)}
                          className="min-h-11 rounded-lg px-2 font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50 sm:min-h-0"
                        >
                          {order.status === "rejected" ? "Try again" : "Pay"}
                        </button>
                        {order.status === "awaiting_payment" && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => abandon(order)}
                            className="min-h-11 rounded-lg px-2 text-ink-500 hover:text-ink-700 disabled:opacity-50 sm:min-h-0"
                          >
                            Cancel
                          </button>
                        )}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}

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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <h2 className="mb-2.5 text-[13px] font-semibold uppercase tracking-wide text-ink-400">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Pay, then tell us the reference.
 *
 * The reference is the only thread tying money in a bank account back to this
 * order — there is no callback to do it automatically — so the form asks for
 * it plainly and explains where to find it rather than treating it as a
 * formality.
 */
function Checkout({
  checkout,
  onDone,
  onCancel,
}: {
  checkout: { order: CoinOrder; payment: PaymentInstruction };
  onDone: () => void;
  onCancel: () => void;
}) {
  const { order, payment } = checkout;
  const [qr, setQr] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    // Drawn from the same link the button opens, so the QR cannot drift from
    // the amount and reference the server recorded.
    let alive = true;
    QRCode.toDataURL(payment.link, { width: 320, margin: 1 })
      .then((url) => {
        if (alive) setQr(url);
      })
      .catch(() => {
        // The link and the VPA below still work; only the picture is missing.
        if (alive) setQr(null);
      });
    return () => {
      alive = false;
    };
  }, [payment.link]);

  const submit = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api.post(`/coins/orders/${order.id}/reference`, { paymentRef: reference.trim() });
      setSubmitted(true);
    } catch (err) {
      setProblem(errorFrom(err, "Could not submit that reference."));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    try {
      await api.post(`/coins/orders/${order.id}/cancel`);
    } catch {
      /* Already paid or already reviewed — leaving it alone is correct. */
    }
    onCancel();
  };

  if (submitted) {
    return (
      <div className="rounded-2xl bg-white p-5 ring-1 ring-ink-200">
        <h2 className="text-lg font-semibold text-ink-900">Thanks — we are checking</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-600">
          Your coins land as soon as the payment is matched against the account. You do not need
          to pay again, and you can close this page.
        </p>
        <button
          type="button"
          onClick={onDone}
          className="mt-4 min-h-11 rounded-xl bg-brand-500 px-4 text-sm font-medium text-white hover:bg-brand-600"
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-white p-5 ring-1 ring-ink-200">
      <h2 className="text-lg font-semibold text-ink-900">
        Pay ₹{payment.amountRupees} for {order.coins.toLocaleString("en-IN")} coins
      </h2>

      <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-start">
        <div className="mx-auto shrink-0 sm:mx-0">
          {qr ? (
            <img
              src={qr}
              alt={`UPI QR code to pay ₹${payment.amountRupees} to ${payment.payee}`}
              className="h-44 w-44 rounded-xl ring-1 ring-ink-200"
            />
          ) : (
            <div className="flex h-44 w-44 items-center justify-center rounded-xl bg-ink-100 text-center text-xs text-ink-400">
              Use the UPI ID below
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 text-sm">
          <p className="text-ink-600">Scan with any UPI app, or pay this ID:</p>
          <p className="mt-1 break-all font-medium text-ink-900">{payment.payee}</p>
          <p className="mt-0.5 text-ink-500">{payment.payeeName}</p>

          {/* On a phone this opens the UPI app with everything filled in. */}
          <a
            href={payment.link}
            className="mt-3 inline-flex min-h-11 items-center rounded-xl bg-brand-500 px-4 font-medium text-white hover:bg-brand-600 sm:hidden"
          >
            Open UPI app
          </a>

          <p className="mt-3 text-xs leading-relaxed text-ink-400">
            Add the note <span className="font-medium text-ink-600">{payment.reference}</span> if your
            app lets you. It is how we find your payment.
          </p>
        </div>
      </div>

      <div className="mt-5 border-t border-ink-100 pt-5">
        <label htmlFor="paymentRef" className="block text-sm font-medium text-ink-900">
          Paid? Enter the UPI reference
        </label>
        <p className="mt-1 text-xs leading-relaxed text-ink-500">
          Your payment app shows it on the receipt — often called{" "}
          <span className="font-medium">UTR</span>, <span className="font-medium">UPI Ref No</span>{" "}
          or <span className="font-medium">Transaction ID</span>. Usually 12 digits.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <input
            id="paymentRef"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="e.g. 412345678901"
            inputMode="text"
            autoComplete="off"
            className="min-h-11 min-w-0 flex-1 rounded-xl bg-ink-100 px-3.5 text-sm text-ink-900 placeholder:text-ink-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy || reference.trim().length < 6}
            className="min-h-11 rounded-xl bg-brand-500 px-4 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          >
            Submit
          </button>
        </div>
        {problem && <p className="mt-2 text-sm text-amber-700">{problem}</p>}
      </div>

      <button
        type="button"
        onClick={cancel}
        className="mt-4 text-sm text-ink-500 hover:text-ink-700"
      >
        Cancel this order
      </button>
    </div>
  );
}
