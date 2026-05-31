import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { Database } from "@/lib/types/database"

type Rag = Database["public"]["Enums"]["rag_status"]

const STYLES: Record<Rag, string> = {
  green: "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  amber: "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  red: "border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
}

const LABELS: Record<Rag, string> = {
  green: "On track",
  amber: "At risk",
  red: "Off track",
}

/** RAG health pill — the canonical Red/Amber/Green indicator (CLAUDE.md §3). */
export function RagBadge({ status }: { status: Rag }) {
  return (
    <Badge variant="outline" className={cn("gap-1.5", STYLES[status])}>
      <span
        className={cn(
          "size-1.5 rounded-full",
          status === "green" && "bg-emerald-600",
          status === "amber" && "bg-amber-600",
          status === "red" && "bg-red-600",
        )}
        aria-hidden
      />
      {LABELS[status]}
    </Badge>
  )
}
