/**
 * Conversation sidebar — history + "New chat" + switch.
 *
 * The active conversation id lives in localStorage (single-user, no auth), so the
 * sidebar reappears with the right selection on reload (Redis-backed history).
 */
import type { ConversationSummary } from "../../lib/api";

interface ConversationSidebarProps {
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: ConversationSidebarProps) {
  return (
    <div className="flex h-full flex-col">
      <button
        type="button"
        onClick={onNew}
        className="mb-3 flex items-center justify-center gap-2 rounded-md bg-accent-primary py-2.5 font-display text-sm font-semibold text-base transition-all hover:scale-[1.02] hover:shadow-glow-primary"
      >
        <span className="text-base">＋</span> New chat
      </button>

      <div className="flex-1 space-y-1.5 overflow-y-auto pr-1">
        {conversations.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-content-muted">
            No conversations yet.
          </p>
        ) : (
          conversations.map((c) => {
            const active = c.id === activeId;
            return (
              <div
                key={c.id}
                className={`group flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 transition-colors ${
                  active
                    ? "bg-accent-primary-soft"
                    : "hover:bg-surface-2"
                }`}
                onClick={() => onSelect(c.id)}
              >
                <div className="min-w-0 flex-1">
                  <div
                    className={`truncate text-sm ${
                      active ? "text-content-primary" : "text-content-secondary"
                    }`}
                  >
                    {c.title}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-content-muted">
                    <span>{relativeTime(c.updated_at)}</span>
                    {c.version_count > 0 && (
                      <span className="rounded-pill bg-surface-2 px-1.5 py-0.5">
                        {c.version_count} version{c.version_count > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="Delete conversation"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(c.id);
                  }}
                  className="opacity-0 transition-opacity hover:text-accent-danger group-hover:opacity-100"
                >
                  🗑
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
