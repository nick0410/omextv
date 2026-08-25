import { Link } from "react-router-dom";

/**
 * The policy pages a payment gateway asks for before it will activate you.
 *
 * Razorpay's activation review looks for terms, a privacy policy, a refund and
 * cancellation policy, and a way to reach a human. A site without them is
 * commonly sent back, which costs days.
 *
 * Everything factual here was checked against the code rather than assumed,
 * because a privacy policy that overstates is worse than none: the claims are
 * that media is not recorded, that message text is not stored, and that camera
 * frames used for verification are not kept. All three are true of the current
 * implementation, and all three stop being true the moment someone adds
 * recording — so they belong in the same review as any change to those paths.
 *
 * This is plain, accurate description, not legal advice. It says what the
 * service actually does; whether that is enough for any particular obligation
 * is a question for someone qualified.
 */

const CONTACT_EMAIL = "nikhileshdubey039@gmail.com";

/** Prices the client must never restate live come from the server; this is prose. */
const LAST_UPDATED = "25 August 2026";

function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold text-ink-900">{title}</h1>
      <p className="mt-1 text-sm text-ink-500">Last updated {LAST_UPDATED}</p>

      <div className="mt-6 space-y-5 text-[15px] leading-relaxed text-ink-700">{children}</div>

      <nav className="mt-10 flex flex-wrap gap-x-4 gap-y-2 border-t border-ink-100 pt-5 text-sm">
        <Link to="/" className="text-brand-600 hover:text-brand-700">Home</Link>
        <Link to="/terms" className="text-ink-500 hover:text-ink-800">Terms</Link>
        <Link to="/privacy" className="text-ink-500 hover:text-ink-800">Privacy</Link>
        <Link to="/refunds" className="text-ink-500 hover:text-ink-800">Refunds</Link>
        <Link to="/contact" className="text-ink-500 hover:text-ink-800">Contact</Link>
      </nav>
    </main>
  );
}

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="pt-2 text-base font-semibold text-ink-900">{children}</h2>;
}

export function Terms() {
  return (
    <Page title="Terms of Use">
      <p>
        Omextv connects two people at random for a live video conversation. By creating an
        account or using the service you agree to what follows.
      </p>

      <H>You must be 18 or older</H>
      <p>
        This is an unmoderated conversation with a stranger. Do not use Omextv if you are under
        18, and do not let anyone under 18 use your account.
      </p>

      <H>How to behave</H>
      <p>
        Do not expose yourself, harass anyone, show anything illegal, record the person you are
        matched with without their knowledge, or use the service to advertise or defraud. You can
        report or block anyone you are matched with, and reports are read.
      </p>
      <p>
        Accounts that break these rules are suspended, temporarily or permanently, at our
        discretion. Coins on a suspended account are not refunded.
      </p>

      <H>Coins and premium</H>
      <p>
        Coins are a virtual balance that exists only inside Omextv. They have no value outside it,
        cannot be transferred between accounts, and cannot be exchanged for money. Coins buy
        premium passes, which unlock choosing who you meet — a gender, or a country — for a fixed
        number of days. Matching itself is free and always has been.
      </p>
      <p>
        Prices are shown before you pay and may change; a change never alters what an order you
        have already placed is worth.
      </p>

      <H>What we do not promise</H>
      <p>
        Omextv is provided as it is. We do not promise that it will be available without
        interruption, that you will be matched with anyone in particular, or that a connection will
        succeed — video calls depend on both networks, and some networks block them.
      </p>

      <H>Closing your account</H>
      <p>
        You can ask us to delete your account at any time by writing to{" "}
        <a className="text-brand-600 hover:text-brand-700" href={`mailto:${CONTACT_EMAIL}`}>
          {CONTACT_EMAIL}
        </a>
        . Any unused coins are lost when the account is deleted.
      </p>
    </Page>
  );
}

export function Privacy() {
  return (
    <Page title="Privacy Policy">
      <p>
        This describes exactly what Omextv collects and what it does with it. Where it says
        something is not stored, that is a statement about how the service is built, not an
        intention.
      </p>

      <H>What you give us</H>
      <p>
        An email address, a username, a password, your declared gender, and optionally a country
        and city. The password is stored only as a bcrypt hash and cannot be read back, by us or
        by anyone else.
      </p>

      <H>Your camera and microphone</H>
      <p>
        Video and audio travel directly between you and the person you are matched with. When a
        direct connection cannot be made, the encrypted stream is passed through a relay server,
        which cannot see its contents. <strong>We do not record or store video or audio.</strong>
      </p>
      <p>
        If you use camera verification, individual frames are sent to our server, analysed to
        estimate a gender, and discarded. What is kept is the result — a verdict, a confidence
        number, when it was made, and how many attempts you have made. The frames themselves are
        not written to disk.
      </p>

      <H>Text chat</H>
      <p>
        Messages are delivered between the two of you and are{" "}
        <strong>not stored</strong>. We keep a count of how many messages a conversation contained,
        and nothing of what they said.
      </p>

      <H>What we keep about conversations</H>
      <p>
        For each conversation: who was matched with whom, when it started and ended, how long it
        lasted, how it ended, and which filters were in play. This is what makes blocking, the
        "do not match me with them again" rule, and abuse reports work.
      </p>

      <H>Reports and blocks</H>
      <p>
        If you report someone, we keep your report, who it was about, and which conversation it
        referred to. If you block someone, we keep that so the two of you are never matched again.
      </p>

      <H>Payments</H>
      <p>
        When you buy coins we record the amount, which pack, when, and the payment reference. We
        never see or store your card number, UPI PIN, or bank credentials — those are handled
        entirely by your payment app or by the payment gateway.
      </p>

      <H>In your browser</H>
      <p>
        Your sign-in token and your filter preferences are stored in your browser's local storage
        so you stay signed in. We do not use advertising or tracking cookies.
      </p>

      <H>Who else sees it</H>
      <p>
        Nobody. We do not sell your data and do not share it with advertisers. The people you are
        matched with see your username, your declared or verified gender, and your country and
        city if you set them — never your email.
      </p>

      <H>Deleting it</H>
      <p>
        Write to{" "}
        <a className="text-brand-600 hover:text-brand-700" href={`mailto:${CONTACT_EMAIL}`}>
          {CONTACT_EMAIL}
        </a>{" "}
        and we will delete your account and the records tied to it.
      </p>
    </Page>
  );
}

export function Refunds() {
  return (
    <Page title="Refund and Cancellation Policy">
      <p>
        Omextv sells coins, a virtual balance used inside the service. This says plainly when money
        comes back and when it does not.
      </p>

      <H>Before you pay</H>
      <p>
        An order you have started but not paid for can be cancelled at any time from the Coins
        page, at no cost. Nothing is charged until you complete the payment yourself.
      </p>

      <H>If you paid and the coins did not arrive</H>
      <p>
        This is the case we will always put right. If money left your account and your balance did
        not change, write to{" "}
        <a className="text-brand-600 hover:text-brand-700" href={`mailto:${CONTACT_EMAIL}`}>
          {CONTACT_EMAIL}
        </a>{" "}
        with the payment reference from your bank or payment app. We will either credit the coins
        or refund the payment in full. Please contact us within 7 days of the payment.
      </p>

      <H>Duplicate or failed payments</H>
      <p>
        If you were charged twice for the same order, or charged for a payment that failed, the
        extra amount is refunded in full. Refunds go back to the account the money came from,
        normally within 5 to 7 working days once approved — the exact timing is set by your bank.
      </p>

      <H>Coins already credited</H>
      <p>
        Coins that have been credited to your balance are not refundable, and coins already spent
        on a premium pass cannot be reversed. Coins do not expire while your account is open.
      </p>

      <H>If a premium pass did not work</H>
      <p>
        If you bought a pass and the filters did not unlock, tell us and we will fix it or return
        the coins. Note that a video call failing to connect is usually a network problem rather
        than a problem with your pass; the connection test at{" "}
        <Link to="/diagnostics" className="text-brand-600 hover:text-brand-700">
          /diagnostics
        </Link>{" "}
        will say which.
      </p>

      <H>Suspended accounts</H>
      <p>
        Coins are not refunded on an account suspended for breaking the Terms of Use.
      </p>
    </Page>
  );
}

export function Contact() {
  return (
    <Page title="Contact Us">
      <p>
        Omextv is run by a single person, not a support department. Email is the way to reach us
        and it is read.
      </p>

      <H>Email</H>
      <p>
        <a className="text-brand-600 hover:text-brand-700" href={`mailto:${CONTACT_EMAIL}`}>
          {CONTACT_EMAIL}
        </a>
      </p>

      <H>What to include</H>
      <p>
        For anything about a payment, send the payment reference (the UTR or transaction id your
        bank or payment app shows) and the email address on your Omextv account. That is what lets
        us find the payment.
      </p>

      <H>How long we take</H>
      <p>
        We aim to reply within 2 working days. Payment problems are dealt with first.
      </p>
    </Page>
  );
}
