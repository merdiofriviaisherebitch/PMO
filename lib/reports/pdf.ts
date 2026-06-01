/**
 * lib/reports/pdf.ts — PDF renderer using pdf-lib.
 *
 * PURE module: no database, no I/O, no "server-only". Accepts a ReportModel
 * (already computed by buildReportModel) and returns the PDF bytes.
 *
 * Document metadata is set so tests can assert content without parsing text:
 *   doc.getTitle()   === model.title
 *   doc.getSubject() === model.scopeLabel
 *
 * Layout: title + subtitle + each section heading with its rows. Paginates when
 * content would overflow the page (simple y-threshold check).
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import type { ReportModel } from "./types"

const PAGE_WIDTH = 595   // A4 portrait
const PAGE_HEIGHT = 842
const MARGIN = 50
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2

// ─── Font sizes ───────────────────────────────────────────────────────────────
const SIZE_TITLE = 16
const SIZE_HEADING = 12
const SIZE_BODY = 10
const LINE_GAP = 4

function lineHeight(size: number): number {
  return size + LINE_GAP
}

type DrawContext = {
  doc: PDFDocument
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>
  boldFont: Awaited<ReturnType<PDFDocument["embedFont"]>>
  pages: ReturnType<PDFDocument["addPage"]>[]
  y: number
}

function currentPage(ctx: DrawContext) {
  return ctx.pages[ctx.pages.length - 1]
}

function addPage(ctx: DrawContext, doc: PDFDocument) {
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  ctx.pages.push(page)
  ctx.y = PAGE_HEIGHT - MARGIN
}

function ensureSpace(ctx: DrawContext, doc: PDFDocument, needed: number) {
  if (ctx.y - needed < MARGIN) {
    addPage(ctx, doc)
  }
}

/**
 * StandardFonts use WinAnsi encoding. A few common typographic glyphs the report
 * model uses are NOT reliably in WinAnsi (the em/en dashes live in the fragile
 * 0x80–0x9F band), so they get dropped / render as a box. Map them to ASCII BEFORE
 * drawing — otherwise e.g. the title "… Report — All Departments" renders as "… ?":
 *   '→' (U+2192) → '->'   ;   '—'/'–' (em/en dash, U+2014/2013) → '-'
 * Anything still outside printable ASCII + Latin-1 (0x20–0x7E, 0xA0–0xFF) becomes '?'.
 * Exported for unit testing — the drawn text is otherwise hard to assert (the PDF
 * metadata title is UTF-16 and stays correct, so only extracting drawn text catches this).
 */
export function toWinAnsiSafe(text: string): string {
  return text
    .replace(/→/g, "->")
    .replace(/[—–]/g, "-")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?")
}

function drawText(
  ctx: DrawContext,
  doc: PDFDocument,
  text: string,
  options: { size: number; bold?: boolean; indent?: number }
) {
  const { size, bold = false, indent = 0 } = options
  const lh = lineHeight(size)
  ensureSpace(ctx, doc, lh)
  currentPage(ctx).drawText(toWinAnsiSafe(text), {
    x: MARGIN + indent,
    y: ctx.y - size,
    size,
    font: bold ? ctx.boldFont : ctx.font,
    color: rgb(0, 0, 0),
    maxWidth: USABLE_WIDTH - indent,
  })
  ctx.y -= lh
}

function drawSectionHeading(ctx: DrawContext, doc: PDFDocument, heading: string) {
  const lh = lineHeight(SIZE_HEADING)
  ensureSpace(ctx, doc, lh + 6)
  ctx.y -= 6 // small top margin before heading
  drawText(ctx, doc, heading, { size: SIZE_HEADING, bold: true })
  // Underline
  currentPage(ctx).drawLine({
    start: { x: MARGIN, y: ctx.y + 2 },
    end: { x: PAGE_WIDTH - MARGIN, y: ctx.y + 2 },
    thickness: 0.5,
    color: rgb(0.5, 0.5, 0.5),
  })
  ctx.y -= 4
}

function drawRow(ctx: DrawContext, doc: PDFDocument, text: string) {
  drawText(ctx, doc, text, { size: SIZE_BODY, indent: 10 })
}

function drawNone(ctx: DrawContext, doc: PDFDocument) {
  drawText(ctx, doc, "None", { size: SIZE_BODY, indent: 10 })
}

export async function renderReportPdf(model: ReportModel): Promise<Uint8Array> {
  const doc = await PDFDocument.create()

  // Set document metadata so tests can assert identity without text parsing.
  doc.setTitle(model.title)
  doc.setSubject(model.scopeLabel)
  doc.setCreator("PMO Control Tower")
  doc.setKeywords([model.period, model.scopeLabel])

  const [font, boldFont] = await Promise.all([
    doc.embedFont(StandardFonts.Helvetica),
    doc.embedFont(StandardFonts.HelveticaBold),
  ])

  const ctx: DrawContext = {
    doc,
    font,
    boldFont,
    pages: [],
    y: PAGE_HEIGHT - MARGIN,
  }

  // First page
  addPage(ctx, doc)

  // ── Title block ───────────────────────────────────────────────────────────
  drawText(ctx, doc, model.title, { size: SIZE_TITLE, bold: true })
  ctx.y -= 4
  drawText(ctx, doc, model.subtitle, { size: SIZE_BODY })
  ctx.y -= 10

  // ── RAG Summary ───────────────────────────────────────────────────────────
  drawSectionHeading(ctx, doc, "RAG Summary")
  const { projects: p, tasks: t } = model.rag
  drawRow(ctx, doc, `Projects — Green: ${p.green}  Amber: ${p.amber}  Red: ${p.red}  Total: ${p.total}`)
  drawRow(ctx, doc, `Tasks    — Green: ${t.green}  Amber: ${t.amber}  Red: ${t.red}  Total: ${t.total}`)

  // ── Budget ────────────────────────────────────────────────────────────────
  drawSectionHeading(ctx, doc, "Budget Summary")
  const b = model.budget
  drawRow(ctx, doc, `Budget: ${b.totalBudget.toLocaleString()}   Actual: ${b.totalActual.toLocaleString()}   Remaining: ${b.remaining.toLocaleString()}`)
  drawRow(ctx, doc, `Lines — Green: ${b.green}  Amber: ${b.amber}  Red: ${b.red}`)

  // ── Unresolved Blockers ───────────────────────────────────────────────────
  drawSectionHeading(ctx, doc, "Unresolved Blockers")
  if (model.blockers.length === 0) {
    drawNone(ctx, doc)
  } else {
    for (const blocker of model.blockers) {
      drawRow(ctx, doc, `${blocker.blockerLabel}  ->  ${blocker.blockedLabel}`)
    }
  }

  // ── Variance ──────────────────────────────────────────────────────────────
  drawSectionHeading(ctx, doc, "Plan Variance")
  if (model.variance.length === 0) {
    drawNone(ctx, doc)
  } else {
    for (const row of model.variance) {
      drawRow(ctx, doc, `${row.projectName}: +${row.addedCount} added, -${row.removedCount} removed, ${row.scheduleChangedCount} schedule, ${row.ragChangedCount} RAG, ${row.budgetChangedCount} budget changes`)
      for (const sv of row.scheduleVariances) {
        const parts: string[] = [`  · ${sv.title}`]
        if (sv.startDateVarianceDays != null) parts.push(`start ${sv.startDateVarianceDays > 0 ? "+" : ""}${sv.startDateVarianceDays}d`)
        if (sv.dueDateVarianceDays != null) parts.push(`due ${sv.dueDateVarianceDays > 0 ? "+" : ""}${sv.dueDateVarianceDays}d`)
        if (sv.startDateChange) parts.push(`start ${sv.startDateChange}`)
        if (sv.dueDateChange) parts.push(`due ${sv.dueDateChange}`)
        drawRow(ctx, doc, parts.join("  "))
      }
    }
  }

  // ── Escalations ───────────────────────────────────────────────────────────
  drawSectionHeading(ctx, doc, "Open Escalations")
  if (model.escalations.length === 0) {
    drawNone(ctx, doc)
  } else {
    for (const esc of model.escalations) {
      drawRow(ctx, doc, `Level ${esc.level}  ${esc.kind}  ${esc.department}  ${esc.triggeredAt}`)
    }
  }

  return doc.save()
}
