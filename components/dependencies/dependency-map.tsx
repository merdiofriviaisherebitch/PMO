"use client"

import { useEffect, useMemo, type CSSProperties } from "react"
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import type { DependencyGraph } from "@/lib/data/dependencies"

/**
 * Interactive dependency map (CLAUDE.md §5 module 7, §7 @xyflow/react). A client
 * island fed ONLY the RLS-scoped, serializable graph from the server — it never
 * holds a Supabase client, so it cannot leak anything RLS didn't already release.
 *
 * Nodes come in two kinds:
 *   * KNOWN — a task the caller may see (title + RAG colour);
 *   * BOUNDARY — the far end of a cross-department edge the caller may NOT see,
 *     drawn with a dashed border and labelled by DEPARTMENT only ("Legal · hidden").
 * A 'blocks' edge whose (known) source is RED is an ACTIVE block → drawn red +
 * animated, the same signal the escalation engine fires on (0027).
 */

const RAG_BORDER: Record<string, string> = {
  green: "#16a34a",
  amber: "#d97706",
  red: "#dc2626",
}

// Node presentation kept separate from the layout pass (buildFlow), so appearance
// and positioning can change independently.
const NODE_BASE: CSSProperties = { borderRadius: 8, padding: 8, width: 180 }
const knownNodeStyle = (rag: string): CSSProperties => ({
  ...NODE_BASE,
  border: `2px solid ${RAG_BORDER[rag] ?? "#94a3b8"}`,
  background: "white",
})
const BOUNDARY_NODE_STYLE: CSSProperties = {
  ...NODE_BASE,
  border: "2px dashed #94a3b8",
  background: "#f8fafc",
}

/** A task the caller may see — title + (optional) department. */
function KnownNodeLabel({ title, dept }: { title: string; dept: string | null }) {
  return (
    <div className="text-left">
      <div className="text-xs font-medium leading-tight">{title}</div>
      {dept ? <div className="text-[10px] text-slate-500">{dept}</div> : null}
    </div>
  )
}

/** The far end of a cross-department edge — department label only, never the task. */
function BoundaryNodeLabel({ dept }: { dept: string }) {
  return (
    <div className="text-left">
      <div className="text-xs font-medium leading-tight">🔒 {dept}</div>
      <div className="text-[10px] text-slate-500">task hidden</div>
    </div>
  )
}

type FlowData = { nodes: Node[]; edges: Edge[] }

function buildFlow(graph: DependencyGraph): FlowData {
  const known = new Map(graph.nodes.map((n) => [n.id, n]))

  // Every endpoint that is NOT a known task is a cross-department boundary node;
  // its department is whichever side of an edge it sits on.
  const boundaryDept = new Map<string, string | null>()
  for (const e of graph.edges) {
    if (!known.has(e.source) && !boundaryDept.has(e.source))
      boundaryDept.set(e.source, e.sourceDeptId)
    if (!known.has(e.target) && !boundaryDept.has(e.target))
      boundaryDept.set(e.target, e.targetDeptId)
  }

  const allIds = [...new Set(graph.edges.flatMap((e) => [e.source, e.target]))]

  // Layered left→right layout: level(target) = max(level(source)+1). Bounded passes
  // so a dependency cycle can never loop forever (it just stops refining).
  const level = new Map(allIds.map((id) => [id, 0]))
  for (let pass = 0; pass < allIds.length; pass++) {
    let changed = false
    for (const e of graph.edges) {
      const next = (level.get(e.source) ?? 0) + 1
      if ((level.get(e.target) ?? 0) < next) {
        level.set(e.target, next)
        changed = true
      }
    }
    if (!changed) break
  }
  const rowOf = new Map<number, number>() // next free row per column
  const position = (id: string) => {
    const col = level.get(id) ?? 0
    const row = rowOf.get(col) ?? 0
    rowOf.set(col, row + 1)
    return { x: col * 240 + 40, y: row * 96 + 40 }
  }

  const nodes: Node[] = allIds.map((id) => {
    const k = known.get(id)
    if (k) {
      const dept = k.departmentId ? graph.departments[k.departmentId] ?? null : null
      return {
        id,
        position: position(id),
        data: { label: <KnownNodeLabel title={k.title} dept={dept} /> },
        style: knownNodeStyle(k.ragStatus),
      }
    }
    const deptId = boundaryDept.get(id) ?? null
    const deptName = deptId ? graph.departments[deptId] ?? "Another department" : "Another department"
    return {
      id,
      position: position(id),
      data: { label: <BoundaryNodeLabel dept={deptName} /> },
      style: BOUNDARY_NODE_STYLE,
    }
  })

  const edges: Edge[] = graph.edges.map((e) => {
    const sourceRed = known.get(e.source)?.ragStatus === "red"
    const activeBlock = e.relationType === "blocks" && sourceRed
    const stroke =
      activeBlock
        ? "#dc2626"
        : e.relationType === "blocks"
          ? "#f59e0b"
          : e.relationType === "precedes"
            ? "#3b82f6"
            : "#94a3b8"
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.relationType,
      animated: activeBlock,
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      style: {
        stroke,
        strokeWidth: activeBlock ? 2 : 1.5,
        strokeDasharray: e.relationType === "relates" ? "4 4" : undefined,
      },
      labelStyle: { fontSize: 10, fill: "#475569" },
      labelBgStyle: { fill: "white" },
    }
  })

  return { nodes, edges }
}

export function DependencyMap({ graph }: { graph: DependencyGraph }) {
  const flow = useMemo(() => buildFlow(graph), [graph])
  const [nodes, setNodes, onNodesChange] = useNodesState(flow.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(flow.edges)

  // Re-seed when the underlying graph changes (after a create/delete revalidate),
  // so the map reflects new edges; between changes the user can freely drag nodes.
  useEffect(() => {
    setNodes(flow.nodes)
    setEdges(flow.edges)
  }, [flow, setNodes, setEdges])

  if (graph.edges.length === 0) {
    return (
      <div className="flex h-[420px] items-center justify-center rounded-lg border border-dashed">
        <p className="text-muted-foreground text-sm">
          No dependencies yet. Add one below to see the map.
        </p>
      </div>
    )
  }

  return (
    <div className="h-[560px] rounded-lg border">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        edgesFocusable={false}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
