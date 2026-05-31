import { describe, expect, it } from "vitest"

import {
  fieldErrors,
  projectCreateSchema,
  taskCreateSchema,
  workspaceRagSchema,
} from "@/lib/validation"

/**
 * Validation is for data integrity + good error messages — NOT authorization
 * (that's RLS, proven in the pen-test). These tests pin the shapes the Server
 * Actions depend on so a schema change can't silently break form handling.
 */
describe("projectCreateSchema", () => {
  it("accepts a valid project and defaults status to green", () => {
    const r = projectCreateSchema.safeParse({ name: "Plant Beta" })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.status).toBe("green")
  })

  it("rejects a too-short name with a useful message", () => {
    const r = projectCreateSchema.safeParse({ name: "x" })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(fieldErrors(r.error).name).toMatch(/at least 2/)
    }
  })

  it("rejects an invalid status enum", () => {
    const r = projectCreateSchema.safeParse({ name: "Valid", status: "purple" })
    expect(r.success).toBe(false)
  })
})

describe("taskCreateSchema", () => {
  it("requires a workspace id", () => {
    const r = taskCreateSchema.safeParse({ workspaceId: "not-a-uuid", title: "Do it" })
    expect(r.success).toBe(false)
    if (!r.success) expect(fieldErrors(r.error).workspaceId).toBeTruthy()
  })

  it("accepts a valid task", () => {
    const r = taskCreateSchema.safeParse({
      workspaceId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      title: "Submit permit",
    })
    expect(r.success).toBe(true)
  })
})

describe("workspaceRagSchema", () => {
  it("only accepts rag enum values", () => {
    const good = workspaceRagSchema.safeParse({
      id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      ragStatus: "amber",
    })
    expect(good.success).toBe(true)
    const bad = workspaceRagSchema.safeParse({
      id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      ragStatus: "blue",
    })
    expect(bad.success).toBe(false)
  })
})
