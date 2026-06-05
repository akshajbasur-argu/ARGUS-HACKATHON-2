/**
 * VibeFlow OS — Application Shell (conversation-centric).
 *
 * Full-viewport dark layout: floating gradient-blob background, glass navbar, and
 * a three-zone workspace — Conversations sidebar | Chat | Workspace (Trace/Plan).
 * Collapses to one zone at a time with bottom-tab navigation under lg.
 */
import { useState } from "react";
import "../../styles/vibeflow.css";

export type AgentStatus = "ready" | "running" | "done" | "error";

interface AppShellProps {
  sidebar: React.ReactNode;
  chat: React.ReactNode;
  workspace: React.ReactNode;
  modal?: React.ReactNode;
  status?: AgentStatus;
}

type Zone = "sidebar" | "chat" | "workspace";

const ZONES: { key: Zone; label: string }[] = [
  { key: "sidebar", label: "Chats" },
  { key: "chat", label: "Chat" },
  { key: "workspace", label: "Plan" },
];

const STATUS: Record<AgentStatus, { dot: string; ring: string; text: string }> = {
  ready: { dot: "bg-emerald-400", ring: "bg-emerald-400/60", text: "AI Agents: Ready" },
  running: { dot: "bg-amber-400", ring: "bg-amber-400/60", text: "AI Agents: Working" },
  done: { dot: "bg-accent-primary", ring: "bg-accent-primary/60", text: "Plan Ready" },
  error: { dot: "bg-accent-danger", ring: "bg-accent-danger/60", text: "Agents: Error" },
};

export default function AppShell({
  sidebar,
  chat,
  workspace,
  modal,
  status = "ready",
}: AppShellProps) {
  const [active, setActive] = useState<Zone>("chat");
  const s = STATUS[status];

  const zone: Record<Zone, React.ReactNode> = { sidebar, chat, workspace };

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-base font-body text-content-primary">
      {/* ---- Floating gradient background ---- */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="gradient-mesh absolute inset-0 opacity-[0.08]" />
        <div
          className="absolute -left-24 -top-32 h-[42rem] w-[42rem] rounded-full"
          style={{
            background: "radial-gradient(circle, var(--color-accent-primary), transparent 60%)",
            opacity: 0.15,
            filter: "blur(40px)",
            animation: "meshDrift 18s var(--ease-in-out) infinite",
          }}
        />
        <div
          className="absolute -right-32 top-1/4 h-[38rem] w-[38rem] rounded-full"
          style={{
            background: "radial-gradient(circle, var(--color-accent-secondary), transparent 60%)",
            opacity: 0.15,
            filter: "blur(40px)",
            animation: "meshDrift 22s var(--ease-in-out) -6s infinite",
          }}
        />
      </div>

      {/* ---- Glass navbar ---- */}
      <header className="glass sticky top-0 z-sticky flex items-center justify-between rounded-none border-x-0 border-t-0 px-6 py-3.5">
        <span className="text-gradient font-display text-2xl font-bold tracking-tight">
          HealthFlow
        </span>
        <div className="glass flex items-center gap-2 rounded-pill px-3 py-1.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${s.ring}`} />
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${s.dot}`} />
          </span>
          <span className="text-sm text-content-secondary">{s.text}</span>
        </div>
      </header>

      {/* ---- Three-zone workspace ---- */}
      <main className="relative z-raised mx-auto h-[calc(100dvh-4.25rem)] w-full max-w-[1760px] px-3 pb-16 pt-4 md:px-5 lg:pb-4">
        <div className="grid h-full grid-cols-1 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)_minmax(0,1.4fr)]">
          {ZONES.map((z) => (
            <section
              key={z.key}
              className={`${active === z.key ? "block" : "hidden"} h-full min-h-0 lg:block`}
            >
              <div
                className={`glass h-full overflow-hidden p-4 shadow-lg ${
                  z.key === "workspace" ? "bg-surface-1/50" : ""
                }`}
              >
                {zone[z.key]}
              </div>
            </section>
          ))}
        </div>
      </main>

      {/* ---- Mobile zone tabs ---- */}
      <nav className="glass fixed inset-x-0 bottom-0 z-sticky flex rounded-none border-x-0 border-b-0 lg:hidden">
        {ZONES.map((z) => (
          <button
            key={z.key}
            type="button"
            onClick={() => setActive(z.key)}
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              active === z.key
                ? "text-accent-primary"
                : "text-content-muted hover:text-content-secondary"
            }`}
          >
            {z.label}
          </button>
        ))}
      </nav>

      {modal}
    </div>
  );
}
