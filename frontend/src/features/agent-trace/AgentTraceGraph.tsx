/**
 * Agent Trace Graph — an interactive React Flow canvas of the multi-agent run.
 *
 * Custom glass nodes (Coordinator → 5 specialists → Critic → Synthesis) animate
 * idle → thinking → complete/flagged live from the SSE stream. Edges encode
 * *influence*: Coordinator→specialist "sub-task", specialist→Critic "reviewed",
 * Critic→specialist "revision (rN)" (debate feedback), specialist/Critic→Synthesis
 * "feeds plan". Clicking any node opens the Step Detail drawer.
 */
import { useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  AGENT_META,
  latestRevisionRound,
  SPECIALISTS,
  type AgentNodeState,
  type DerivedTrace,
  type NodeStatus,
} from "./deriveTrace";

type NodeRole = "coordinator" | "specialist" | "critic" | "synthesis";

interface AgentNodeData extends Record<string, unknown> {
  nodeKey: string;
  role: NodeRole;
  status: NodeStatus;
  confidence?: number;
  revised: boolean;
  round: number;
  selected: boolean;
}

type AgentNode = Node<AgentNodeData, "agent">;

const STATUS_RING: Record<NodeStatus, { border: string; glow: string }> = {
  idle: { border: "var(--color-border-strong)", glow: "none" },
  thinking: { border: "var(--color-accent-primary)", glow: "var(--glow-primary)" },
  complete: { border: "var(--color-accent-primary)", glow: "none" },
  flagged: { border: "var(--color-accent-warning)", glow: "var(--glow-warning)" },
  error: { border: "var(--color-accent-danger)", glow: "var(--glow-danger)" },
};

const STATUS_LABEL: Record<NodeStatus, string> = {
  idle: "idle",
  thinking: "thinking…",
  complete: "complete",
  flagged: "flagged",
  error: "error",
};

const HANDLE_STYLE = {
  background: "var(--color-accent-info)",
  width: 7,
  height: 7,
  border: "none",
} as const;

// --- Custom node ------------------------------------------------------------

function AgentFlowNode({ data }: NodeProps<AgentNode>) {
  const meta = AGENT_META[data.nodeKey] ?? { icon: "•", label: data.nodeKey };
  const ring = STATUS_RING[data.status];
  const pct =
    typeof data.confidence === "number" ? Math.round(data.confidence * 100) : null;

  return (
    <div
      className={`glass relative w-[126px] cursor-pointer px-3 py-2 text-center ${
        data.status === "thinking" ? "pulse-glow" : ""
      } ${data.selected ? "ring-2 ring-accent-info" : ""}`}
      style={{
        borderColor: ring.border,
        borderWidth: 1.5,
        boxShadow: data.status !== "thinking" ? ring.glow : undefined,
        opacity: data.status === "idle" ? 0.55 : 1,
      }}
    >
      {/* role-specific connection handles */}
      {data.role === "coordinator" && (
        <Handle type="source" position={Position.Bottom} id="b" style={HANDLE_STYLE} />
      )}
      {data.role === "specialist" && (
        <>
          <Handle type="target" position={Position.Top} id="t" style={HANDLE_STYLE} />
          <Handle type="source" position={Position.Bottom} id="b" style={HANDLE_STYLE} />
          <Handle
            type="source"
            position={Position.Right}
            id="reviewed-out"
            style={{ ...HANDLE_STYLE, top: "32%" }}
          />
          <Handle
            type="target"
            position={Position.Right}
            id="revision-in"
            style={{ ...HANDLE_STYLE, top: "68%", background: "var(--color-accent-warning)" }}
          />
        </>
      )}
      {data.role === "critic" && (
        <>
          <Handle
            type="target"
            position={Position.Left}
            id="reviewed-in"
            style={{ ...HANDLE_STYLE, top: "32%" }}
          />
          <Handle
            type="source"
            position={Position.Left}
            id="revision-out"
            style={{ ...HANDLE_STYLE, top: "68%", background: "var(--color-accent-warning)" }}
          />
          <Handle type="source" position={Position.Bottom} id="b" style={HANDLE_STYLE} />
        </>
      )}
      {data.role === "synthesis" && (
        <Handle type="target" position={Position.Top} id="t" style={HANDLE_STYLE} />
      )}

      <div className="text-xl leading-none">{meta.icon}</div>
      <div className="mt-1 font-display text-xs font-semibold text-content-primary">
        {meta.label}
      </div>
      <div className="mt-0.5 text-[10px] text-content-muted">
        {STATUS_LABEL[data.status]}
        {data.revised ? ` · ↻ r${data.round}` : ""}
      </div>
      {pct !== null && data.status !== "idle" && (
        <div className="mx-auto mt-1.5 h-1 w-3/4 overflow-hidden rounded-pill bg-surface-2">
          <div
            className="h-full rounded-pill"
            style={{ width: `${pct}%`, background: ring.border }}
          />
        </div>
      )}
      {data.status === "thinking" && (
        <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 animate-spin rounded-full border-2 border-accent-primary/30 border-t-accent-primary" />
      )}
    </div>
  );
}

const nodeTypes = { agent: AgentFlowNode };

// --- Static layout ----------------------------------------------------------

const POS: Record<string, { x: number; y: number }> = {
  coordinator: { x: 290, y: 0 },
  nutrition: { x: 0, y: 150 },
  macros: { x: 145, y: 150 },
  fitness: { x: 290, y: 150 },
  risk: { x: 435, y: 150 },
  budget: { x: 580, y: 150 },
  critic: { x: 800, y: 200 },
  synthesis: { x: 290, y: 430 },
};

const IDLE: AgentNodeState = {
  status: "idle",
  verdict: "",
  reasoning: "",
  flags: [],
  revised: false,
  round: 1,
  peerContext: [],
  sources: [],
};

const SUBTASK_EDGE = {
  stroke: "var(--color-accent-info)",
  strokeWidth: 1.5,
};
const REVIEW_EDGE = {
  stroke: "var(--color-text-muted)",
  strokeWidth: 1.5,
};
const REVISION_EDGE = {
  stroke: "var(--color-accent-warning)",
  strokeWidth: 2,
};
const FEEDS_EDGE = {
  stroke: "var(--color-border-strong)",
  strokeWidth: 1.25,
  strokeDasharray: "4 4",
};

const LABEL_STYLE = { fill: "var(--color-text-secondary)", fontSize: 10 } as const;
const LABEL_BG = { fill: "var(--color-surface-2)", fillOpacity: 0.85 } as const;

function buildGraph(
  derived: DerivedTrace,
  selected: string | null,
): { nodes: AgentNode[]; edges: Edge[] } {
  const a = derived.agents;
  const stateOf = (key: string, role: NodeRole): AgentNodeData => {
    const s =
      key === "coordinator"
        ? { ...IDLE, status: derived.coordinatorStatus }
        : key === "synthesis"
          ? { ...IDLE, status: derived.synthesisStatus }
          : a[key] ?? IDLE;
    return {
      nodeKey: key,
      role,
      status: s.status,
      confidence: s.confidence,
      revised: s.revised,
      round: s.round,
      selected: selected === key,
    };
  };

  const nodes: AgentNode[] = [
    { id: "coordinator", type: "agent", position: POS.coordinator!, data: stateOf("coordinator", "coordinator"), draggable: false },
    ...SPECIALISTS.map((s) => ({
      id: s,
      type: "agent" as const,
      position: POS[s]!,
      data: stateOf(s, "specialist"),
      draggable: false,
    })),
    { id: "critic", type: "agent", position: POS.critic!, data: stateOf("critic", "critic"), draggable: false },
    { id: "synthesis", type: "agent", position: POS.synthesis!, data: stateOf("synthesis", "synthesis"), draggable: false },
  ];

  const criticThinking = (a["critic"]?.status ?? "idle") === "thinking";
  const edges: Edge[] = [];
  for (const s of SPECIALISTS) {
    const thinking = (a[s]?.status ?? "idle") === "thinking";
    edges.push({
      id: `c-${s}`,
      source: "coordinator",
      sourceHandle: "b",
      target: s,
      targetHandle: "t",
      label: "sub-task",
      animated: thinking,
      style: SUBTASK_EDGE,
      labelStyle: LABEL_STYLE,
      labelBgStyle: LABEL_BG,
      markerEnd: { type: MarkerType.ArrowClosed, color: SUBTASK_EDGE.stroke },
    });
    edges.push({
      id: `${s}-critic`,
      source: s,
      sourceHandle: "reviewed-out",
      target: "critic",
      targetHandle: "reviewed-in",
      label: "reviewed",
      animated: criticThinking,
      style: REVIEW_EDGE,
      labelStyle: LABEL_STYLE,
      labelBgStyle: LABEL_BG,
      markerEnd: { type: MarkerType.ArrowClosed, color: REVIEW_EDGE.stroke },
    });
    edges.push({
      id: `${s}-syn`,
      source: s,
      sourceHandle: "b",
      target: "synthesis",
      targetHandle: "t",
      style: FEEDS_EDGE,
      markerEnd: { type: MarkerType.ArrowClosed, color: FEEDS_EDGE.stroke },
    });
    const rr = latestRevisionRound(derived, s);
    if (rr !== undefined) {
      edges.push({
        id: `critic-${s}`,
        source: "critic",
        sourceHandle: "revision-out",
        target: s,
        targetHandle: "revision-in",
        label: `revision (r${rr})`,
        animated: thinking,
        style: REVISION_EDGE,
        labelStyle: { ...LABEL_STYLE, fill: "var(--color-accent-warning)" },
        labelBgStyle: LABEL_BG,
        markerEnd: { type: MarkerType.ArrowClosed, color: REVISION_EDGE.stroke },
      });
    }
  }
  edges.push({
    id: "critic-syn",
    source: "critic",
    sourceHandle: "b",
    target: "synthesis",
    targetHandle: "t",
    label: "QA gate",
    style: REVIEW_EDGE,
    labelStyle: LABEL_STYLE,
    labelBgStyle: LABEL_BG,
    markerEnd: { type: MarkerType.ArrowClosed, color: REVIEW_EDGE.stroke },
  });

  return { nodes, edges };
}

// --- Canvas -----------------------------------------------------------------

interface AgentTraceGraphProps {
  derived: DerivedTrace;
  selected: string | null;
  onSelect: (nodeKey: string) => void;
}

export default function AgentTraceGraph({
  derived,
  selected,
  onSelect,
}: AgentTraceGraphProps) {
  const { nodes, edges } = useMemo(
    () => buildGraph(derived, selected),
    [derived, selected],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, node) => onSelect(node.id)}
      fitView
      fitViewOptions={{ padding: 0.18 }}
      minZoom={0.3}
      maxZoom={1.6}
      nodesDraggable={false}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
      className="rounded-lg"
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--color-border)" />
      <Controls showInteractive={false} className="!border-border !bg-surface-2" />
    </ReactFlow>
  );
}
