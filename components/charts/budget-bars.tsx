"use client"

import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

/**
 * Client-only budget % -used bar chart. Server passes pre-shaped, RLS-scoped
 * rows; colors map to the RAG the budget_variance() function already computed,
 * so the chart never re-derives governance state.
 */
const RAG_FILL = { green: "#059669", amber: "#d97706", red: "#dc2626" } as const

export function BudgetBars({
  data,
}: {
  data: Array<{ label: string; pctUsed: number; rag: "green" | "amber" | "red" }>
}) {
  if (data.length === 0) {
    return (
      <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
        No budgets set yet
      </div>
    )
  }

  return (
    <div className="h-48 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
          <XAxis type="number" domain={[0, "dataMax"]} unit="%" fontSize={11} />
          <YAxis
            type="category"
            dataKey="label"
            width={120}
            fontSize={11}
            tickLine={false}
          />
          <Tooltip formatter={(v) => [`${v}% used`, "Budget"]} />
          <Bar dataKey="pctUsed" radius={[0, 4, 4, 0]}>
            {data.map((d, i) => (
              <Cell key={i} fill={RAG_FILL[d.rag]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
