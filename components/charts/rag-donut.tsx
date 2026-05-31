"use client"

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts"

/**
 * Client-only RAG donut (Recharts needs the DOM). Server Components fetch the
 * counts (RLS-scoped) and pass them as plain props — we keep the client bundle
 * to just the chart, per the Vercel RSC/client split guidance.
 */
const COLORS = { green: "#059669", amber: "#d97706", red: "#dc2626" } as const

export function RagDonut({
  green,
  amber,
  red,
}: {
  green: number
  amber: number
  red: number
}) {
  const data = [
    { name: "On track", key: "green", value: green },
    { name: "At risk", key: "amber", value: amber },
    { name: "Off track", key: "red", value: red },
  ].filter((d) => d.value > 0)

  if (data.length === 0) {
    return (
      <div className="text-muted-foreground flex h-40 items-center justify-center text-sm">
        No data yet
      </div>
    )
  }

  return (
    <div className="h-40 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius={45}
            outerRadius={70}
            paddingAngle={2}
          >
            {data.map((d) => (
              <Cell key={d.key} fill={COLORS[d.key as keyof typeof COLORS]} />
            ))}
          </Pie>
          <Tooltip />
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}
