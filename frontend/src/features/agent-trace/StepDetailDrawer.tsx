/**
 * Step Detail drawer — slides in when a trace-graph node (or log row) is clicked.
 *
 * Shows the full picture for that step: the input it received, the output it
 * generated (pretty-printed structured JSON), reasoning, web sources (clickable),
 * confidence/flags and timing. The Coordinator view shows the routed sub-tasks;
 * the Critic view shows contradictions + revision requests; Synthesis shows which
 * agents fed the plan.
 */
import type { ReactNode } from "react";
import {
  AGENT_META,
  type DerivedTrace,
  type NodeStatus,
  type RoundInfo,
} from "./deriveTrace";

interface StepDetailDrawerProps {
  nodeKey: string | null;
  derived: DerivedTrace;
  onClose: () => void;
}

const STATUS_CHIP: Record<NodeStatus, { label: string; cls: string }> = {
  idle: { label: "Idle", cls: "bg-surface-2 text-content-muted" },
  thinking: { label: "Thinking…", cls: "bg-accent-primary-soft text-accent-primary" },
  complete: { label: "Complete", cls: "bg-accent-primary-soft text-accent-primary" },
  flagged: { label: "Flagged", cls: "bg-accent-warning-soft text-accent-warning" },
  error: { label: "Error", cls: "bg-accent-danger-soft text-accent-danger" },
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <h4 className="mb-1.5 font-display text-xs uppercase tracking-wide text-content-muted">
        {title}
      </h4>
      {children}
    </div>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-content-secondary">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Sources({ sources }: { sources: { title: string; url: string }[] }) {
  if (sources.length === 0) {
    return <p className="text-xs text-content-muted">No web sources for this step.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {sources.map((s, i) => (
        <li key={`${s.url}-${i}`} className="flex items-start gap-2 text-xs">
          <span className="mt-0.5 text-accent-info">🔗</span>
          <a
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-accent-info hover:underline"
          >
            {s.title}
          </a>
        </li>
      ))}
    </ul>
  );
}

function SpecialistBody({
  derived,
  nodeKey,
}: {
  derived: DerivedTrace;
  nodeKey: string;
}) {
  const a = derived.agents[nodeKey];
  if (!a) {
    return <p className="mt-4 text-sm text-content-muted">This agent hasn't run yet.</p>;
  }
  const output = a.output
    ? Object.fromEntries(Object.entries(a.output).filter(([k]) => k !== "sources"))
    : undefined;
  return (
    <>
      {a.verdict && (
        <Section title="Verdict">
          <p className="text-sm text-content-secondary">{a.verdict}</p>
        </Section>
      )}
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {typeof a.confidence === "number" && (
          <span className="rounded-pill bg-surface-2 px-2 py-0.5 text-content-secondary">
            confidence {Math.round(a.confidence * 100)}%
          </span>
        )}
        {a.revised && (
          <span className="rounded-pill bg-accent-secondary-soft px-2 py-0.5 text-accent-secondary">
            ↻ revised · round {a.round}
          </span>
        )}
        {typeof a.durationMs === "number" && (
          <span className="rounded-pill bg-surface-2 px-2 py-0.5 text-content-muted">
            {a.durationMs >= 1000
              ? `${(a.durationMs / 1000).toFixed(1)}s`
              : `${Math.round(a.durationMs)}ms`}
          </span>
        )}
      </div>

      {a.peerContext.length > 0 && (
        <Section title="Peer context (debate)">
          <div className="flex flex-wrap gap-1.5">
            {a.peerContext.map((p) => (
              <span
                key={p}
                className="rounded-pill bg-surface-2 px-2 py-0.5 text-xs text-content-secondary"
              >
                {AGENT_META[p]?.label ?? p}
              </span>
            ))}
          </div>
        </Section>
      )}

      {a.input && (
        <Section title="Input received">
          <p className="whitespace-pre-wrap rounded-md bg-surface-2 p-3 text-xs text-content-secondary">
            {a.input}
          </p>
        </Section>
      )}

      {a.reasoning && (
        <Section title="Reasoning">
          <p className="text-sm text-content-secondary">{a.reasoning}</p>
        </Section>
      )}

      {a.flags.length > 0 && (
        <Section title="Flags">
          <div className="flex flex-wrap gap-1.5">
            {a.flags.map((f) => (
              <span
                key={f}
                className="rounded-pill bg-accent-warning-soft px-2 py-0.5 text-xs text-accent-warning"
              >
                {f}
              </span>
            ))}
          </div>
        </Section>
      )}

      {output && (
        <Section title="Output generated">
          <Json value={output} />
        </Section>
      )}

      <Section title="Web sources">
        <Sources sources={a.sources} />
      </Section>
    </>
  );
}

function CoordinatorBody({ derived }: { derived: DerivedTrace }) {
  const entries = Object.entries(derived.subTasks);
  if (entries.length === 0) {
    return (
      <p className="mt-4 text-sm text-content-muted">
        Waiting for the Coordinator to decompose the profile…
      </p>
    );
  }
  return (
    <Section title="Sub-tasks routed to each agent">
      <div className="space-y-2">
        {entries.map(([agent, task]) => (
          <div key={agent} className="rounded-md bg-surface-2 p-3">
            <div className="mb-1 flex items-center gap-1.5 font-display text-xs font-semibold text-content-primary">
              <span>{AGENT_META[agent]?.icon ?? "•"}</span>
              {AGENT_META[agent]?.label ?? agent}
            </div>
            <p className="text-xs text-content-secondary">{task}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function RoundCard({ round }: { round: RoundInfo }) {
  return (
    <div className="rounded-md bg-surface-2 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-display text-xs font-semibold text-content-primary">
          Round {round.round}
        </span>
        {typeof round.consistency === "number" && (
          <span className="text-xs text-content-muted">
            consistency {Math.round(round.consistency * 100)}%
          </span>
        )}
      </div>
      {round.critiqueSummary && (
        <p className="mb-2 text-xs text-content-secondary">{round.critiqueSummary}</p>
      )}
      {round.contradictions.length > 0 && (
        <div className="mb-2 space-y-1.5">
          {round.contradictions.map((c, i) => (
            <div
              key={i}
              className="rounded-sm border-l-2 border-accent-danger bg-base/40 px-2 py-1 text-[11px] text-content-secondary"
            >
              <span className="text-accent-danger">⚠ </span>
              {c.field_a}=<b>{c.value_a}</b> vs {c.field_b}=<b>{c.value_b}</b>
              {c.resolution ? <div className="mt-0.5 text-content-muted">→ {c.resolution}</div> : null}
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5 text-xs">
        {round.rejected.map((r) => (
          <span
            key={`rej-${r}`}
            className="rounded-pill bg-accent-warning-soft px-2 py-0.5 text-accent-warning"
          >
            revise: {AGENT_META[r]?.label ?? r}
          </span>
        ))}
        {round.approved.map((r) => (
          <span
            key={`app-${r}`}
            className="rounded-pill bg-accent-primary-soft px-2 py-0.5 text-accent-primary"
          >
            ✓ {AGENT_META[r]?.label ?? r}
          </span>
        ))}
      </div>
    </div>
  );
}

function CriticBody({ derived }: { derived: DerivedTrace }) {
  if (derived.rounds.length === 0) {
    return (
      <p className="mt-4 text-sm text-content-muted">
        The Critic reviews the specialists once they finish.
      </p>
    );
  }
  return (
    <Section title={`Debate rounds (${derived.rounds.length})`}>
      <div className="space-y-2">
        {derived.rounds.map((r) => (
          <RoundCard key={r.round} round={r} />
        ))}
      </div>
    </Section>
  );
}

function SynthesisBody({ derived }: { derived: DerivedTrace }) {
  if (derived.inputsFrom.length === 0) {
    return (
      <p className="mt-4 text-sm text-content-muted">
        Synthesis composes the final plan once the debate settles.
      </p>
    );
  }
  return (
    <Section title="Inputs feeding the final plan">
      <div className="flex flex-wrap gap-1.5">
        {derived.inputsFrom.map((a) => (
          <span
            key={a}
            className="flex items-center gap-1 rounded-pill bg-surface-2 px-2.5 py-1 text-xs text-content-secondary"
          >
            <span>{AGENT_META[a]?.icon ?? "•"}</span>
            {AGENT_META[a]?.label ?? a}
          </span>
        ))}
      </div>
    </Section>
  );
}

export default function StepDetailDrawer({
  nodeKey,
  derived,
  onClose,
}: StepDetailDrawerProps) {
  if (!nodeKey) return null;

  const meta = AGENT_META[nodeKey] ?? { icon: "•", label: nodeKey };
  const status: NodeStatus =
    nodeKey === "coordinator"
      ? derived.coordinatorStatus
      : nodeKey === "synthesis"
        ? derived.synthesisStatus
        : (derived.agents[nodeKey]?.status ?? "idle");
  const chip = STATUS_CHIP[status];

  return (
    <div className="fixed inset-0 z-modal flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close detail"
        onClick={onClose}
        className="absolute inset-0 bg-overlay backdrop-blur-sm"
        style={{ background: "var(--color-overlay)" }}
      />
      <div
        className="glass-strong relative h-full w-[min(30rem,92vw)] overflow-y-auto rounded-none border-y-0 border-r-0 p-6"
        style={{ animation: "slideInRight var(--duration-base) var(--ease-out)" }}
      >
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2.5">
            <span className="text-2xl">{meta.icon}</span>
            <div>
              <h3 className="font-display text-lg font-bold text-content-primary">
                {meta.label}
              </h3>
              <span className={`mt-0.5 inline-block rounded-pill px-2 py-0.5 text-xs ${chip.cls}`}>
                {chip.label}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-content-muted hover:bg-surface-2 hover:text-content-primary"
          >
            ✕
          </button>
        </div>

        {nodeKey === "coordinator" ? (
          <CoordinatorBody derived={derived} />
        ) : nodeKey === "critic" ? (
          <CriticBody derived={derived} />
        ) : nodeKey === "synthesis" ? (
          <SynthesisBody derived={derived} />
        ) : (
          <SpecialistBody derived={derived} nodeKey={nodeKey} />
        )}
      </div>
    </div>
  );
}
