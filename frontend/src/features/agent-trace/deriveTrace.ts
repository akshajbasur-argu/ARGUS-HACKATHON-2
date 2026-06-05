/**
 * Shared reducer: fold the raw SSE TraceEvent stream into the rich per-node
 * state the graph, the execution log, and the step-detail drawer all read.
 *
 * Driven by the enriched backend payloads (sub_tasks, per-agent input/output/
 * sources/timing, debate contradictions + revision requests, synthesis inputs).
 */
import type { Contradiction, TraceEvent, TraceSource } from "../../lib/api";

export type NodeStatus = "idle" | "thinking" | "complete" | "flagged" | "error";

export const SPECIALISTS = [
  "nutrition",
  "macros",
  "fitness",
  "risk",
  "budget",
] as const;

const SPECIALIST_SET = new Set<string>(SPECIALISTS);

export const AGENT_META: Record<string, { icon: string; label: string }> = {
  coordinator: { icon: "🧭", label: "Coordinator" },
  nutrition: { icon: "🥗", label: "Nutrition" },
  macros: { icon: "🧮", label: "Macros" },
  fitness: { icon: "💪", label: "Fitness" },
  risk: { icon: "🛡️", label: "Risk" },
  budget: { icon: "💰", label: "Budget" },
  critic: { icon: "⚖️", label: "Critic" },
  synthesis: { icon: "✨", label: "Synthesis" },
};

export interface AgentNodeState {
  status: NodeStatus;
  verdict: string;
  reasoning: string;
  confidence?: number;
  flags: string[];
  revised: boolean;
  round: number;
  input?: string;
  peerContext: string[];
  output?: Record<string, unknown>;
  sources: TraceSource[];
  durationMs?: number;
}

export interface RoundInfo {
  round: number;
  rejected: string[];
  approved: string[];
  revisionRequests: Record<string, string>;
  contradictions: Contradiction[];
  consistency?: number;
  critiqueSummary: string;
  verdict: string;
}

export interface DerivedTrace {
  agents: Record<string, AgentNodeState>; // specialists + critic
  rounds: RoundInfo[];
  subTasks: Record<string, string>;
  inputsFrom: string[];
  coordinatorStatus: NodeStatus;
  synthesisStatus: NodeStatus;
  decomposed: boolean;
  synthesising: boolean;
  done: boolean;
  error?: string;
}

// --- payload coercion helpers ----------------------------------------------

const asNum = (v: unknown): number | undefined =>
  typeof v === "number" ? v : undefined;

const asStrArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

const asSources = (v: unknown): TraceSource[] =>
  Array.isArray(v)
    ? v.flatMap((s) => {
        const r = asRecord(s);
        if (!r || typeof r.url !== "string") return [];
        return [{ title: String(r.title ?? r.url), url: r.url }];
      })
    : [];

const asContradictions = (v: unknown): Contradiction[] =>
  Array.isArray(v) ? (v as Contradiction[]) : [];

// --- reducer ----------------------------------------------------------------

export function deriveTrace(events: TraceEvent[]): DerivedTrace {
  const agents: Record<string, AgentNodeState> = {};
  const rounds: RoundInfo[] = [];
  let subTasks: Record<string, string> = {};
  let inputsFrom: string[] = [];
  let coordinatorStatus: NodeStatus = "idle";
  let synthesisStatus: NodeStatus = "idle";
  let decomposed = false;
  let synthesising = false;
  let done = false;
  let error: string | undefined;

  const ensure = (name: string): AgentNodeState =>
    (agents[name] ??= {
      status: "idle",
      verdict: "",
      reasoning: "",
      flags: [],
      revised: false,
      round: 1,
      peerContext: [],
      sources: [],
    });

  for (const e of events) {
    const name = e.agent_name ?? "";
    const p = e.payload ?? {};
    switch (e.type) {
      case "run_started":
        coordinatorStatus = "thinking";
        break;

      case "agent_started":
        if (name === "critic") {
          ensure("critic").status = "thinking";
        } else if (SPECIALIST_SET.has(name)) {
          const a = ensure(name);
          a.status = "thinking";
          a.round = e.round ?? a.round;
          if (typeof p["input"] === "string") a.input = p["input"];
          a.peerContext = asStrArr(p["peer_context_agents"]);
        }
        break;

      case "agent_completed":
        if (name === "coordinator") {
          decomposed = true;
          coordinatorStatus = "complete";
          const st = asRecord(p["sub_tasks"]);
          if (st) {
            subTasks = Object.fromEntries(
              Object.entries(st).map(([k, v]) => [k, String(v)]),
            );
          }
        } else if (SPECIALIST_SET.has(name)) {
          const a = ensure(name);
          const flags = asStrArr(p["flags"]);
          a.status = flags.length > 0 ? "flagged" : "complete";
          a.verdict = typeof p["verdict"] === "string" ? p["verdict"] : e.message;
          if (typeof p["reasoning"] === "string") a.reasoning = p["reasoning"];
          a.confidence = asNum(p["confidence"]) ?? a.confidence;
          a.flags = flags;
          a.output = asRecord(p["output"]) ?? a.output;
          const srcs = asSources(p["sources"]);
          if (srcs.length) a.sources = srcs;
          a.durationMs = asNum(e.duration_ms ?? undefined) ?? a.durationMs;
          if (p["revised"] === true) a.revised = true;
          a.round = e.round ?? a.round;
        }
        break;

      case "debate_round": {
        const rejected = asStrArr(p["rejected_agents"]);
        rounds.push({
          round: e.round ?? rounds.length + 1,
          rejected,
          approved: asStrArr(p["approved_agents"]),
          revisionRequests:
            (asRecord(p["revision_requests"]) as Record<string, string>) ?? {},
          contradictions: asContradictions(p["contradictions"]),
          consistency: asNum(p["consistency_score"]),
          critiqueSummary:
            typeof p["critique_summary"] === "string" ? p["critique_summary"] : "",
          verdict: e.message,
        });
        rejected.forEach((r) => {
          if (SPECIALIST_SET.has(r)) ensure(r).revised = true;
        });
        const critic = ensure("critic");
        critic.status = rejected.length > 0 ? "flagged" : "complete";
        critic.verdict = e.message;
        break;
      }

      case "synthesis":
        synthesising = true;
        synthesisStatus = "thinking";
        inputsFrom = asStrArr(p["inputs_from"]);
        break;

      case "run_completed":
        done = true;
        synthesising = false;
        synthesisStatus = "complete";
        coordinatorStatus = "complete";
        break;

      case "error":
        if (SPECIALIST_SET.has(name)) ensure(name).status = "error";
        else if (name === "critic") ensure("critic").status = "error";
        else error = e.message;
        break;

      default:
        break;
    }
  }

  return {
    agents,
    rounds,
    subTasks,
    inputsFrom,
    coordinatorStatus,
    synthesisStatus,
    decomposed,
    synthesising,
    done,
    error,
  };
}

/** The latest round in which `agent` was asked to revise (for edge labels). */
export function latestRevisionRound(
  derived: DerivedTrace,
  agent: string,
): number | undefined {
  for (let i = derived.rounds.length - 1; i >= 0; i--) {
    if (derived.rounds[i]!.rejected.includes(agent)) return derived.rounds[i]!.round;
  }
  return undefined;
}
