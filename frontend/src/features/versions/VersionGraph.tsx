/**
 * VersionGraph — a compact React Flow DAG of a conversation's plan versions.
 *
 * Each node is one plan version; edges point parent → child ("derived from"), so
 * a re-plan that branches off an earlier version shows as a fork. Selecting a node
 * loads that version's FinalPlan into the Plan view and points the trace stream at
 * its plan_id.
 */
import { useMemo } from "react";
import {
  Background,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { PlanVersion } from "../../lib/api";

interface VersionGraphProps {
  versions: PlanVersion[];
  selectedVersionId: string | null;
  onSelect: (versionId: string) => void;
}

function layout(versions: PlanVersion[]): Map<string, { x: number; y: number }> {
  const byId = new Map(versions.map((v) => [v.version_id, v]));
  const depthCache = new Map<string, number>();
  const depthOf = (v: PlanVersion): number => {
    const cached = depthCache.get(v.version_id);
    if (cached !== undefined) return cached;
    const parent = v.parent_version_id ? byId.get(v.parent_version_id) : undefined;
    const d = parent ? depthOf(parent) + 1 : 0;
    depthCache.set(v.version_id, d);
    return d;
  };
  const levels = new Map<number, string[]>();
  for (const v of versions) {
    const d = depthOf(v);
    (levels.get(d) ?? levels.set(d, []).get(d)!).push(v.version_id);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [d, ids] of levels) {
    ids.forEach((id, i) => pos.set(id, { x: i * 158, y: d * 76 }));
  }
  return pos;
}

export default function VersionGraph({
  versions,
  selectedVersionId,
  onSelect,
}: VersionGraphProps) {
  const { nodes, edges } = useMemo(() => {
    const pos = layout(versions);
    const nodes: Node[] = versions.map((v) => {
      const selected = v.version_id === selectedVersionId;
      return {
        id: v.version_id,
        position: pos.get(v.version_id) ?? { x: 0, y: 0 },
        draggable: false,
        data: {
          label: (
            <div className="leading-tight">
              <div className="font-display text-xs font-semibold">{v.label}</div>
              {v.change_request && (
                <div className="mt-0.5 max-w-[7rem] truncate text-[9px] opacity-70">
                  {v.change_request}
                </div>
              )}
            </div>
          ),
        },
        style: {
          width: 132,
          padding: 6,
          borderRadius: 12,
          background: selected
            ? "var(--color-accent-primary-soft)"
            : "var(--color-surface-2)",
          border: selected
            ? "2px solid var(--color-accent-primary)"
            : "1px solid var(--color-border)",
          color: "var(--color-text-primary)",
        },
      };
    });
    const edges: Edge[] = versions
      .filter((v) => v.parent_version_id)
      .map((v) => ({
        id: `${v.parent_version_id}-${v.version_id}`,
        source: v.parent_version_id as string,
        target: v.version_id,
        style: { stroke: "var(--color-border-strong)" },
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-border-strong)" },
      }));
    return { nodes, edges };
  }, [versions, selectedVersionId]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodeClick={(_, node) => onSelect(node.id)}
      fitView
      fitViewOptions={{ padding: 0.25 }}
      minZoom={0.4}
      maxZoom={1.4}
      nodesDraggable={false}
      nodesConnectable={false}
      panOnDrag
      zoomOnScroll={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={16} size={1} color="var(--color-border)" />
    </ReactFlow>
  );
}
