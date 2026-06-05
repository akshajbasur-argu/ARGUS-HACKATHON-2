/**
 * ChatPanel — the conversational center column.
 *
 * Renders the conversation's message stream and an input box. Posting a turn is
 * handled by the parent (App), which runs the intake agent and, when the profile
 * is ready / a change is requested, spawns a new plan version.
 */
import { useEffect, useRef, useState } from "react";
import type { ChatTurnStatus, Conversation } from "../../lib/api";

interface ChatPanelProps {
  conversation: Conversation | null;
  sending: boolean;
  lastStatus: ChatTurnStatus | null;
  onSend: (content: string) => void;
  onQuickFill: () => void;
}

const STATUS_HINT: Record<ChatTurnStatus, string | null> = {
  collecting: null,
  ready: "✨ Profile complete — generating your plan…",
  replan: "🔄 Applying your change — regenerating the plan…",
  answer: null,
};

function Bubble({ role, content }: { role: "user" | "assistant"; content: string }) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-4 py-2.5 text-sm ${
          isUser
            ? "bg-accent-primary-soft text-content-primary"
            : "glass text-content-secondary"
        }`}
        style={{ animation: "springIn var(--duration-fast) var(--spring)" }}
      >
        {content}
      </div>
    </div>
  );
}

export default function ChatPanel({
  conversation,
  sending,
  lastStatus,
  onSend,
  onQuickFill,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = conversation?.messages ?? [];

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, sending]);

  const submit = () => {
    const text = draft.trim();
    if (!text || sending) return;
    onSend(text);
    setDraft("");
  };

  const hint = lastStatus ? STATUS_HINT[lastStatus] : null;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-sm uppercase tracking-wide text-content-muted">
          {conversation?.title ?? "New chat"}
        </h2>
        <button
          type="button"
          onClick={onQuickFill}
          className="rounded-pill border border-border px-3 py-1 text-xs text-content-secondary transition-colors hover:border-accent-primary hover:text-accent-primary"
        >
          ⚡ Quick fill
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto pr-1">
        {messages.length === 0 ? (
          <div className="flex h-full min-h-[12rem] flex-col items-center justify-center text-center text-content-muted">
            <span className="text-3xl">💬</span>
            <p className="mt-2 max-w-xs text-sm">
              Tell me about yourself and your health goal — age, weight, height,
              activity, budget — and I'll build you a plan. Or use{" "}
              <button
                type="button"
                onClick={onQuickFill}
                className="text-accent-primary hover:underline"
              >
                Quick fill
              </button>
              .
            </p>
          </div>
        ) : (
          messages.map((m, i) => (
            <Bubble key={i} role={m.role} content={m.content} />
          ))
        )}

        {sending && (
          <div className="flex justify-start">
            <div className="glass flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm text-content-muted">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent-primary/30 border-t-accent-primary" />
              Thinking…
            </div>
          </div>
        )}
      </div>

      {hint && (
        <div className="mt-2 rounded-md bg-accent-primary-soft px-3 py-1.5 text-xs text-accent-primary">
          {hint}
        </div>
      )}

      <div className="mt-3 flex items-end gap-2">
        <textarea
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Message HealthFlow…"
          className="max-h-32 flex-1 resize-none rounded-md border border-border bg-surface-2 px-4 py-2.5 text-sm text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-accent-primary"
        />
        <button
          type="button"
          onClick={submit}
          disabled={sending || !draft.trim()}
          className="rounded-md bg-accent-primary px-4 py-2.5 font-display text-sm font-semibold text-base transition-all hover:scale-[1.02] hover:shadow-glow-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100 disabled:hover:shadow-none"
        >
          Send
        </button>
      </div>
    </div>
  );
}
