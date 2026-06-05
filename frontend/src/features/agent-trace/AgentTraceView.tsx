/**
 * Agent Trace View — live SSE timeline of the multi-agent run.
 *
 * Consumes useTraceStream (GET /api/stream/{planId}) and renders a vertical
 * timeline: the five specialists as agent cards that transition
 * idle -> thinking -> complete/flagged, then the debate rounds + critic, then
 * synthesis and done markers.
 *
 * Note on field names: the backend TraceEvent uses `type`/`ts` (not
 * event_type/timestamp). "↻ Revised" is derived from an agent appearing in a
 * debate_round's rejected_agents, since re-runs aren't individually traced.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTraceStream } from "../../lib/sse";
import type { TraceEvent } from "../../lib/api";
import SkeletonCard from "../../components/ui/SkeletonCard";

interface AgentTraceViewProps {
  planId: string | null;
}

type CardStatus = "idle" | "thinking" | "complete" | "flagged" | "error";

interface AgentState {
  status: CardStatus;
  verdict: string;
  confidence?: number;
  flags: string[];
  revised: boolean;
}

interface RoundInfo {
  round: number;
  rejected: string[];
  consistency?: number;
  verdict: string;
}

const AGENTS: Record<string, { icon: string; label: string }> = {
  nutrition: { icon: "🥗", label: "Nutrition" },
  macros: { icon: "🧮", label: "Macros" },
  fitness: { icon: "💪", label: "Fitness" },
  risk: { icon: "🛡️", label: "Risk" },
  budget: { icon: "💰", label: "Budget" },
  critic: { icon: "⚖️", label: "Critic" },
};
const SPECIALIST_ORDER = ["nutrition", "macros", "fitness", "risk", "budget"];

const asNumber = (v: unknown): number | undefined =>
  typeof v === "number" ? v : undefined;
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

// --- Derive view state from the raw event stream ----------------------------

interface DerivedState {
  agents: Record<string, AgentState>;
  rounds: RoundInfo[];
  synthesising: boolean;
  done: boolean;
  decomposed: boolean;
}

function derive(events: TraceEvent[]): DerivedState {
  const agents: Record<string, AgentState> = {};
  const rounds: RoundInfo[] = [];
  let synthesising = false;
  let done = false;
  let decomposed = false;

  const ensure = (name: string): AgentState =>
    (agents[name] ??= { status: "idle", verdict: "", flags: [], revised: false });

  for (const e of events) {
    const name = e.agent_name ?? "";
    switch (e.type) {
      case "agent_started":
        if (name in AGENTS) ensure(name).status = "thinking";
        break;
      case "agent_completed":
        if (name === "coordinator") {
          decomposed = true;
        } else if (name in AGENTS) {
          const a = ensure(name);
          const flags = asStringArray(e.payload["flags"]);
          a.status = flags.length > 0 ? "flagged" : "complete";
          a.verdict = e.message;
          a.confidence = asNumber(e.payload["confidence"]);
          a.flags = flags;
        }
        break;
      case "debate_round": {
        const rejected = asStringArray(e.payload["rejected_agents"]);
        rounds.push({
          round: e.round ?? rounds.length + 1,
          rejected,
          consistency: asNumber(e.payload["consistency_score"]),
          verdict: e.message,
        });
        rejected.forEach((r) => {
          if (r in AGENTS) ensure(r).revised = true;
        });
        const critic = ensure("critic");
        critic.status = rejected.length > 0 ? "flagged" : "complete";
        critic.verdict = e.message;
        break;
      }
      case "synthesis":
        synthesising = true;
        break;
      case "run_completed":
        done = true;
        synthesising = false;
        break;
      case "error":
        if (name in AGENTS) ensure(name).status = "error";
        break;
      default:
        break;
    }
  }
  return { agents, rounds, synthesising, done, decomposed };
}

// --- Small pieces -----------------------------------------------------------

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    value >= 0.8
      ? "var(--color-accent-primary)"
      : value >= 0.6
        ? "var(--color-accent-warning)"
        : "var(--color-accent-danger)";
  return (
    <div className="mt-2">
      <div className="mb-1 flex justify-between text-xs text-content-muted">
        <span>Confidence</span>
        <span>{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-pill bg-surface-2">
        <div
          className="h-full rounded-pill transition-all duration-slow ease-spring"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}

function Verdict({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  return (
    <div className="mt-2">
      <p className={`text-sm text-content-secondary ${expanded ? "" : "line-clamp-2"}`}>
        {text}
      </p>
      {text.length > 90 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs text-accent-primary hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function AgentCard({ name, state }: { name: string; state: AgentState }) {
  const meta = AGENTS[name];
  if (!meta) return null;

  const borderByStatus: Record<CardStatus, string> = {
    idle: "border-l-4 border-border",
    thinking: "border-l-4 border-accent-primary pulse-glow",
    complete: "border-l-4 border-accent-primary",
    flagged: "border-l-4 border-accent-warning",
    error: "border-l-4 border-accent-danger",
  };

  return (
    <div
      className={`glass p-4 ${borderByStatus[state.status]}`}
      style={{ animation: "springIn var(--duration-fast) var(--spring)" }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`text-xl ${state.status === "idle" ? "opacity-40" : ""}`}>
            {meta.icon}
          </span>
          <span className="font-display font-semibold">{meta.label}</span>
          {state.revised && (
            <span className="rounded-pill bg-accent-secondary-soft px-2 py-0.5 text-xs text-accent-secondary">
              ↻ Revised
            </span>
          )}
        </div>
        {state.status === "thinking" && (
          <div className="flex items-center gap-2 text-xs text-accent-primary">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent-primary/30 border-t-accent-primary" />
            Analysing…
          </div>
        )}
        {state.status === "flagged" && <span title="Flags raised">⚠️</span>}
      </div>

      {state.confidence !== undefined && <ConfidenceBar value={state.confidence} />}
      <Verdict text={state.verdict} />

      {state.flags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {state.flags.map((f) => (
            <span
              key={f}
              className="rounded-pill bg-accent-warning/15 px-2 py-0.5 text-xs text-accent-warning"
            >
              {f}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Marker({ icon, label }: { icon: string; label: string }) {
  return (
    <div
      className="flex items-center gap-2 text-sm text-content-muted"
      style={{ animation: "springIn var(--duration-fast) var(--spring)" }}
    >
      <span>{icon}</span>
      <span>{label}</span>
    </div>
  );
}

// --- Main component ---------------------------------------------------------

export default function AgentTraceView({ planId }: AgentTraceViewProps) {
  const { events, connected, error } = useTraceStream(planId);
  const { agents, rounds, synthesising, done, decomposed } = useMemo(
    () => derive(events),
    [events],
  );

  // Auto-scroll the timeline to the latest activity.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, synthesising, done]);

  if (!planId) {
    return (
      <div className="flex h-full min-h-[12rem] flex-col items-center justify-center text-center text-content-muted">
        <span className="text-3xl">🧭</span>
        <p className="mt-2 text-sm">Fill in your profile to watch the agents work.</p>
      </div>
    );
  }

  const startedAgents = SPECIALIST_ORDER.filter(
    (n) => agents[n] && agents[n]!.status !== "idle",
  );
  const critic = agents["critic"];

  return (
    <div className="flex h-full flex-col">
      {/* Live status header */}
      <div className="mb-3 flex items-center gap-2 text-xs">
        <span
          className={`h-2 w-2 rounded-full ${
            error ? "bg-accent-danger" : connected ? "bg-emerald-400 animate-pulse" : "bg-content-muted"
          }`}
        />
        <span className="text-content-muted">
          {error ? "Disconnected" : connected ? "Live" : done ? "Finished" : "Connecting…"}
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto pr-1">
        {events.length === 0 ? (
          // Before the first SSE event: shimmer placeholders for the 5 agents.
          SPECIALIST_ORDER.map((n) => <SkeletonCard key={n} />)
        ) : (
          <>
            <Marker icon="🚀" label="Run started" />
            {decomposed && <Marker icon="🧭" label="Profile decomposed into sub-tasks" />}

        {startedAgents.map((name) => (
          <AgentCard key={name} name={name} state={agents[name]!} />
        ))}

        {rounds.map((r) => (
          <div key={r.round} className="space-y-2">
            {r.round > 1 && (
              <div className="flex items-center gap-2 py-1">
                <div className="h-px flex-1 bg-border" />
                <span className="rounded-pill bg-accent-secondary-soft px-3 py-0.5 text-xs text-accent-secondary">
                  Round {r.round}
                </span>
                <div className="h-px flex-1 bg-border" />
              </div>
            )}
            <Marker
              icon="⚖️"
              label={
                r.rejected.length > 0
                  ? `Critic: revising ${r.rejected.join(", ")}` +
                    (r.consistency !== undefined
                      ? ` (consistency ${Math.round(r.consistency * 100)}%)`
                      : "")
                  : `Critic: consistent` +
                    (r.consistency !== undefined
                      ? ` (${Math.round(r.consistency * 100)}%)`
                      : "")
              }
            />
          </div>
        ))}

        {critic && <AgentCard name="critic" state={critic} />}

            {synthesising && <Marker icon="✨" label="Synthesising final plan…" />}
            {done && <Marker icon="✅" label="Plan ready" />}
          </>
        )}
      </div>
    </div>
  );
}
