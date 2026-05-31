import { z } from "zod"

/**
 * Shared validation schemas (zod v4). Server Actions parse with these before any
 * DB write; the same shapes can be reused client-side. RLS is still the security
 * boundary — these schemas are for data integrity + good error messages, NOT
 * authorization (CLAUDE.md §6: never rely on app-layer checks for isolation).
 */

const rag = z.enum(["green", "amber", "red"])

export const projectCreateSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(200),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  status: rag.default("green"),
})

export const projectUpdateSchema = projectCreateSchema.extend({
  id: z.uuid(),
})

export const taskCreateSchema = z.object({
  workspaceId: z.uuid("Pick a workspace"),
  title: z.string().trim().min(2, "Title must be at least 2 characters").max(300),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  ragStatus: rag.default("green"),
  startDate: z.string().date().optional().or(z.literal("")),
  dueDate: z.string().date().optional().or(z.literal("")),
})

export const taskUpdateSchema = taskCreateSchema
  .omit({ workspaceId: true })
  .extend({ id: z.uuid() })

export const workspaceRagSchema = z.object({
  id: z.uuid(),
  ragStatus: rag,
})

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>
export type TaskCreateInput = z.infer<typeof taskCreateSchema>

/** Normalize a zod error into a flat { field: message } map for form display. */
export function fieldErrors(
  error: z.ZodError,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_form"
    if (!out[key]) out[key] = issue.message
  }
  return out
}
