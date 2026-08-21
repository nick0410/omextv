import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../lib/types";

interface Props {
  messages: ChatMessage[];
  myUserId: string | null;
  disabled: boolean;
  partnerTyping: boolean;
  onSend: (text: string) => void;
  onTyping: (isTyping: boolean) => void;
}

const MAX_LENGTH = 1000;

export function ChatPanel({
  messages,
  myUserId,
  disabled,
  partnerTyping,
  onSend,
  onTyping,
}: Props) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // Follow the conversation, but only when already at the bottom — yanking the
  // view down while someone is reading back is worse than a missed message.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 120) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages, partnerTyping]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    setDraft("");
    onTyping(false);
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden rounded-2xl bg-white ring-1 ring-ink-200">
      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto p-4">
        {messages.map((message) => {
          const mine = message.senderId === myUserId;
          return (
            <div key={message.id} className={mine ? "flex justify-end" : "flex justify-start"}>
              <div
                className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                  mine
                    ? "rounded-br-md bg-brand-500 text-white"
                    : "rounded-bl-md bg-ink-100 text-ink-900"
                }`}
              >
                {/* Rendered as text, never HTML. */}
                <p className="whitespace-pre-wrap break-words">{message.text}</p>
              </div>
            </div>
          );
        })}

        {partnerTyping && (
          <p className="text-xs text-ink-400" aria-live="polite">
            typing…
          </p>
        )}
      </div>

      <form onSubmit={submit} className="flex gap-2 border-t border-ink-200 p-3">
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value.slice(0, MAX_LENGTH));
            onTyping(e.target.value.length > 0);
          }}
          onBlur={() => onTyping(false)}
          disabled={disabled}
          placeholder="Message"
          aria-label="Message"
          className="min-w-0 flex-1 rounded-xl bg-ink-100 px-3.5 py-2.5 text-sm text-ink-900 placeholder:text-ink-400 focus:bg-white focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={disabled || !draft.trim()}
          aria-label="Send"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-500 text-white transition-colors hover:bg-brand-600 disabled:opacity-40"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 12 20 4l-8 16-2-6z" />
          </svg>
        </button>
      </form>
    </div>
  );
}
