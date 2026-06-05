/**
 * VibeFlow OS — Application Shell.
 *
 * Full-viewport dark layout: floating gradient-blob background, glass navbar,
 * and a 28/44/28 three-column grid (Onboarding | Trace | Results). Collapses to
 * a single column with bottom tab navigation under 768px (md). CSS-only motion
 * (no animation library) — all tokens/keyframes come from vibeflow.css.
 */
import { useState } from "react";
import "../../styles/vibeflow.css";

export type AgentStatus = "ready" | "running" | "done" | "error";

interface AppShellProps {
  onboarding?: React.ReactNode;
  trace?: React.ReactNode;
  results?: React.ReactNode;
  status?: AgentStatus;
}

type PanelKey = "onboarding" | "trace" | "results";

const PANELS: { key: PanelKey; label: string; title: string; delay: number }[] = [
  { key: "onboarding", label: "Input", title: "Your Profile", delay: 0 },
  { key: "trace", label: "Trace", title: "Agent Trace", delay: 100 },
  { key: "results", label: "Results", title: "Your Plan", delay: 200 },
];

const STATUS: Record<AgentStatus, { dot: string; ring: string; text: string }> = {
  ready: { dot: "bg-emerald-400", ring: "bg-emerald-400/60", text: "AI Agents: Ready" },
  running: { dot: "bg-amber-400", ring: "bg-amber-400/60", text: "AI Agents: Working" },
  done: { dot: "bg-accent-primary", ring: "bg-accent-primary/60", text: "Plan Ready" },
  error: { dot: "bg-accent-danger", ring: "bg-accent-danger/60", text: "Agents: Error" },
};

function Placeholder({ title }: { title: string }) {
  return (
    <div className="flex h-full min-h-[12rem] flex-col items-center justify-center text-center">
      <span className="font-display text-lg text-content-secondary">{title}</span>
      <span className="mt-1 text-sm text-content-muted">Coming online…</span>
    </div>
  );
}

export default function AppShell({
  onboarding,
  trace,
  results,
  status = "ready",
}: AppShellProps) {
  const [active, setActive] = useState<PanelKey>("onboarding");
  const s = STATUS[status];

  const content: Record<PanelKey, React.ReactNode> = {
    onboarding: onboarding ?? <Placeholder title="Onboarding" />,
    trace: trace ?? <Placeholder title="Agent Trace" />,
    results: results ?? <Placeholder title="Results" />,
  };

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-base font-body text-content-primary">
      {/* ---- Floating gradient background (no pointer events) ---- */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden print:hidden">
        {/* Base mesh sweep (gradientFlow) */}
        <div className="gradient-mesh absolute inset-0 opacity-[0.08]" />
        {/* Three drifting blobs: teal, violet, amber */}
        <div
          className="absolute -left-24 -top-32 h-[42rem] w-[42rem] rounded-full"
          style={{
            background:
              "radial-gradient(circle, var(--color-accent-primary), transparent 60%)",
            opacity: 0.15,
            filter: "blur(40px)",
            animation: "meshDrift 18s var(--ease-in-out) infinite",
          }}
        />
        <div
          className="absolute -right-32 top-1/4 h-[38rem] w-[38rem] rounded-full"
          style={{
            background:
              "radial-gradient(circle, var(--color-accent-secondary), transparent 60%)",
            opacity: 0.15,
            filter: "blur(40px)",
            animation: "meshDrift 22s var(--ease-in-out) -6s infinite",
          }}
        />
        <div
          className="absolute -bottom-40 left-1/3 h-[34rem] w-[34rem] rounded-full"
          style={{
            background:
              "radial-gradient(circle, var(--color-accent-warning), transparent 60%)",
            opacity: 0.15,
            filter: "blur(40px)",
            animation: "meshDrift 26s var(--ease-in-out) -12s infinite",
          }}
        />
      </div>

      {/* ---- Glass navbar ---- */}
      <header className="glass sticky top-0 z-sticky flex items-center justify-between rounded-none border-x-0 border-t-0 px-6 py-4 print:hidden">
        <span className="text-gradient font-display text-2xl font-bold tracking-tight">
          HealthFlow
        </span>

        <div className="glass flex items-center gap-2 rounded-pill px-3 py-1.5">
          <span className="relative flex h-2.5 w-2.5">
            <span
              className={`absolute inline-flex h-full w-full animate-ping rounded-full ${s.ring}`}
            />
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${s.dot}`} />
          </span>
          <span className="text-sm text-content-secondary">{s.text}</span>
        </div>

        <div
          className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold text-base"
          style={{ background: "var(--gradient-primary)" }}
          aria-label="User avatar"
        >
          U
        </div>
      </header>

      {/* ---- Three-panel layout ---- */}
      <main className="relative z-raised mx-auto w-full max-w-[1600px] px-4 py-6 md:px-6">
        <div className="vibeflow-grid grid grid-cols-1 gap-6 md:grid-cols-[28fr_44fr_28fr]">
          {PANELS.map((panel) => (
            <section
              key={panel.key}
              className={`${
                active === panel.key ? "block" : "hidden"
              } md:block animate-spring-in ${
                panel.key === "results" ? "" : "print:hidden"
              }`}
              style={{ animationDelay: `${panel.delay}ms` }}
            >
              <div
                className={`glass h-full p-5 shadow-lg ${
                  panel.key === "trace" ? "bg-surface-1/60" : ""
                }`}
              >
                <h2 className="mb-4 font-display text-sm uppercase tracking-wide text-content-muted">
                  {panel.title}
                </h2>
                {content[panel.key]}
              </div>
            </section>
          ))}
        </div>
      </main>

      {/* ---- Mobile tab navigation (md:hidden) ---- */}
      <nav className="glass fixed inset-x-0 bottom-0 z-sticky flex rounded-none border-x-0 border-b-0 md:hidden print:hidden">
        {PANELS.map((panel) => (
          <button
            key={panel.key}
            type="button"
            onClick={() => setActive(panel.key)}
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors duration-base ease-spring ${
              active === panel.key
                ? "text-accent-primary"
                : "text-content-muted hover:text-content-secondary"
            }`}
          >
            {panel.label}
          </button>
        ))}
      </nav>

      {/* Spacer so content clears the fixed mobile nav */}
      <div className="h-16 md:hidden print:hidden" />
    </div>
  );
}
