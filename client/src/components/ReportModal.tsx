import { useState } from "react";
import api from "../lib/axios";
import type { PartnerProfile } from "../lib/types";

interface Props {
  partner: PartnerProfile;
  open: boolean;
  onClose: () => void;
  onReported: () => void;
}

const CATEGORIES = [
  { value: "nudity", label: "Nudity or sexual content" },
  { value: "harassment", label: "Harassment or hate" },
  { value: "minor", label: "Appears to be a minor" },
  { value: "violence", label: "Violence or threats" },
  { value: "spam", label: "Spam or advertising" },
  { value: "other", label: "Something else" },
] as const;

export function ReportModal({ partner, open, onClose, onReported }: Props) {
  const [category, setCategory] = useState<string>("harassment");
  const [reason, setReason] = useState("");
  const [alsoBlock, setAlsoBlock] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (reason.trim().length < 10) {
      setError("Please describe what happened (at least 10 characters).");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await api.post("/report", {
        reportedId: partner.userId,
        category,
        reason: reason.trim(),
      });
      // Blocking is a separate call so a failure there does not lose the report.
      if (alsoBlock) {
        await api.post("/report/block", { blockedId: partner.userId }).catch(() => {});
      }
      onReported();
      onClose();
    } catch (err: unknown) {
      const message =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        "Could not submit the report.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink-900/40 p-5 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-title"
    >
      <form
        onSubmit={submit}
        className="w-full max-w-[420px] space-y-4 rounded-2xl bg-white p-6 shadow-[0_8px_40px_rgba(15,23,42,0.16)]"
      >
        <div>
          <h2 id="report-title" className="text-lg font-semibold tracking-tight text-ink-900">
            Report {partner.username}
          </h2>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink-700">What happened?</legend>
          {CATEGORIES.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-700"
            >
              <input
                type="radio"
                name="category"
                value={option.value}
                checked={category === option.value}
                onChange={() => setCategory(option.value)}
                className="accent-brand-500"
              />
              {option.label}
            </label>
          ))}
        </fieldset>

        <div>
          <label htmlFor="reason" className="mb-1.5 block text-sm font-medium text-ink-700">
            Details
          </label>
          <textarea
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 500))}
            rows={3}
            placeholder="What happened?"
            className="w-full resize-none rounded-xl bg-ink-100 px-3.5 py-2.5 text-sm text-ink-900 placeholder:text-ink-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <p className="mt-1 text-right text-xs text-ink-400">{reason.length}/500</p>
        </div>

        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={alsoBlock}
            onChange={(e) => setAlsoBlock(e.target.checked)}
            className="accent-brand-500"
          />
          Also block — never match me with them again
        </label>

        {error && <p className="text-sm text-danger-500">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-sm font-medium text-ink-500 hover:text-ink-900"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-xl bg-danger-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-danger-600 disabled:opacity-50"
          >
            {submitting ? "Submitting" : "Report"}
          </button>
        </div>
      </form>
    </div>
  );
}
