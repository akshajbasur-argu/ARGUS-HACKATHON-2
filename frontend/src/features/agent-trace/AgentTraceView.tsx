/**
 * Execution Log — the secondary, chronological view of the multi-agent run.
 *
 * The same vertical timeline as before (agents idle → thinking → complete/flagged,
 * debate rounds, synthesis, done), now driven by the shared `DerivedTrace` instead
 * of subscribing to SSE itself, and with every row clickable to open the Step
 * Detail drawer. The interactive graph (AgentTraceGraph) is the primary view.
 */
import { useEffect, useRef, useState } from "react";
import SkeletonCard from "../../components/ui/SkeletonCard";
import {
  AGENT_META,
  SPECIALISTS,
  type AgentNodeState,
  type DerivedTrace,
  type NodeStatus,
} from "./deriveTrace";

interface ExecutionLogProps {
  derived: DerivedTrace;
  eventCount: number;
  onSelect: (nodeKey: string) => void;
}

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
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="mt-1 text-xs text-accent-primary hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

const BORDER_BY_STATUS: Record<NodeStatus, string> = {
  idle: "border-l-4 border-border",
  thinking: "border-l-4 border-accent-primary pulse-glow",
  complete: "border-l-4 border-accent-primary",
  flagged: "border-l-4 border-accent-warning",
  error: "border-l-4 border-accent-danger",
};

function AgentCard({
  name,
  state,
  onClick,
}: {
  name: string;
  state: AgentNodeState;
  onClick: () => void;
}) {
  const meta = AGENT_META[name];
  if (!meta) return null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`glass w-full p-4 text-left transition-transform hover:scale-[1.01] ${BORDER_BY_STATUS[state.status]}`}
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
              className="rounded-pill bg-accent-warning-soft px-2 py-0.5 text-xs text-accent-warning"
            >
              {f}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

function Marker({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`flex items-center gap-2 text-sm text-content-muted ${
        onClick ? "hover:text-content-secondary" : "cursor-default"
      }`}
      style={{ animation: "springIn var(--duration-fast) var(--spring)" }}
    >
      <span>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

export default function AgentTraceView({
  derived,
  eventCount,
  onSelect,
}: ExecutionLogProps) {
  const { agents, rounds, synthesising, done, decomposed } = derived;

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [eventCount, synthesising, done]);

  const startedAgents = SPECIALISTS.filter(
    (n) => agents[n] && agents[n]!.status !== "idle",
  );
  const critic = agents["critic"];

  return (
    <div ref={scrollRef} className="h-full space-y-3 overflow-y-auto pr-1">
      {eventCount === 0 ? (
        SPECIALISTS.map((n) => <SkeletonCard key={n} />)
      ) : (
        <>
          <Marker icon="🚀" label="Run started" />
          {decomposed && (
            <Marker
              icon="🧭"
              label="Profile decomposed into sub-tasks"
              onClick={() => onSelect("coordinator")}
            />
          )}

          {startedAgents.map((name) => (
            <AgentCard
              key={name}
              name={name}
              state={agents[name]!}
              onClick={() => onSelect(name)}
            />
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
                onClick={() => onSelect("critic")}
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

          {critic && (
            <AgentCard name="critic" state={critic} onClick={() => onSelect("critic")} />
          )}

          {synthesising && (
            <Marker
              icon="✨"
              label="Synthesising final plan…"
              onClick={() => onSelect("synthesis")}
            />
          )}
          {done && (
            <Marker icon="✅" label="Plan ready" onClick={() => onSelect("synthesis")} />
          )}
        </>
      )}
    </div>
  );
}
