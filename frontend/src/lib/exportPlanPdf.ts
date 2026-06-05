/**
 * Client-side PDF export of a FinalPlan.
 *
 * Builds the PDF from the plan *data* (not a screenshot of the dark UI), so the
 * output is always a complete, readable document — the old `window.print()`
 * route produced an empty page because the app is a dark, scroll-clipped SPA.
 */
import type { FinalPlan } from "./api";
import { combinedQuery, productLinks } from "./productLinks";

// Loose mirrors of the agent .data payloads (every field may be absent).
interface Meal { meal?: string; foods?: string[]; calories?: number }
interface Day {
  day?: string;
  type?: string;
  duration_min?: number;
  exercises?: { name?: string; sets?: number; reps_or_duration?: string }[];
}
interface MedFlag { severity?: string; description?: string; recommendation?: string }
interface Alt { original?: string; alternative?: string; saving_inr?: number }

const TEAL: [number, number, number] = [13, 148, 136];
const GREY: [number, number, number] = [90, 90, 90];
const INK: [number, number, number] = [30, 30, 30];

const inr = (n: number) => `Rs ${Math.round(n).toLocaleString("en-IN")}`;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && !Number.isNaN(v) ? v : undefined;

export async function downloadPlanPdf(plan: FinalPlan): Promise<void> {
  // Lazy-load jsPDF so it (and its optional deps) stay out of the initial bundle.
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const M = 40;
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const maxW = W - M * 2;
  let y = M;

  const ensure = (h: number) => {
    if (y + h > H - M) {
      doc.addPage();
      y = M;
    }
  };

  const write = (
    s: string,
    size = 10,
    opts: { bold?: boolean; color?: [number, number, number]; indent?: number; gap?: number } = {},
  ) => {
    doc.setFontSize(size);
    doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    doc.setTextColor(...(opts.color ?? INK));
    const x = M + (opts.indent ?? 0);
    const lines = doc.splitTextToSize(s, maxW - (opts.indent ?? 0)) as string[];
    const lh = size + 3;
    for (const ln of lines) {
      ensure(lh);
      doc.text(ln, x, y);
      y += lh;
    }
    y += opts.gap ?? 0;
  };

  const heading = (s: string) => {
    y += 8;
    ensure(22);
    write(s, 13, { bold: true, color: TEAL });
    doc.setDrawColor(220);
    doc.line(M, y, W - M, y);
    y += 6;
  };

  const buyLine = (label: string, query: string) => {
    const links = productLinks(query);
    if (!links.length) return;
    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    let x = M + 10;
    ensure(12);
    doc.setTextColor(...GREY);
    doc.text(`Buy ${label}:`, x, y);
    x += doc.getTextWidth(`Buy ${label}:`) + 6;
    for (const l of links) {
      doc.setTextColor(...TEAL);
      doc.textWithLink(l.short, x, y, { url: l.url });
      x += doc.getTextWidth(l.short) + 10;
    }
    y += 12;
  };

  // ---- Title ----
  write("HealthFlow — Personalised Health Plan", 18, { bold: true, color: TEAL });
  const gen = new Date(plan.generated_at);
  const dateStr = Number.isNaN(gen.getTime()) ? "" : gen.toLocaleDateString();
  write(
    `Overall health score: ${plan.overall_health_score}/10   ·   ` +
      `Debate rounds: ${plan.debate_rounds}${dateStr ? `   ·   ${dateStr}` : ""}`,
    10,
    { color: GREY },
  );
  if (plan.user_summary) write(plan.user_summary, 10, { gap: 4 });

  // ---- Nutrition ----
  const n = (plan.nutrition_plan ?? {}) as Record<string, unknown>;
  heading("Nutrition Plan");
  if (num(n.daily_calories) !== undefined)
    write(
      `Daily target: ${num(n.daily_calories)} kcal` +
        (num(n.hydration_litres) !== undefined ? `  ·  ${num(n.hydration_litres)} L water` : ""),
      10,
      { color: GREY },
    );
  for (const m of (n.meal_plan as Meal[]) ?? []) {
    const foods = m.foods ?? [];
    write(`${m.meal ?? "Meal"} — ${m.calories ?? 0} kcal`, 10, { bold: true });
    if (foods.length) write(foods.join(", "), 10, { indent: 10 });
    if (foods.length) buyLine("ingredients", combinedQuery(foods));
  }
  const supps = (n.supplement_suggestions as string[]) ?? [];
  if (supps.length) {
    write("Supplements:", 10, { bold: true });
    for (const s of supps) {
      write(s, 10, { indent: 10 });
      buyLine(s, s);
    }
  }
  const avoid = (n.foods_to_avoid as string[]) ?? [];
  if (avoid.length) write(`Foods to avoid: ${avoid.join(", ")}`, 10, { color: GREY, gap: 2 });

  // ---- Macros ----
  const ma = (plan.macros_targets ?? {}) as Record<string, unknown>;
  heading("Macro Targets");
  write(
    `BMR ${Math.round(num(ma.bmr) ?? 0)}  ·  TDEE ${Math.round(num(ma.tdee) ?? 0)}  ·  ` +
      `Target ${Math.round(num(ma.target_calories) ?? 0)} kcal`,
    10,
  );
  const g = (ma.macros_g ?? {}) as Record<string, number>;
  const p = (ma.macros_pct ?? {}) as Record<string, number>;
  write(
    `Protein ${g.protein ?? "—"} g (${p.protein ?? "—"}%)  ·  ` +
      `Carbs ${g.carbs ?? "—"} g (${p.carbs ?? "—"}%)  ·  ` +
      `Fat ${g.fat ?? "—"} g (${p.fat ?? "—"}%)`,
    10,
    { gap: 2 },
  );

  // ---- Fitness ----
  const f = (plan.fitness_programme ?? {}) as Record<string, unknown>;
  heading("Fitness Programme");
  for (const d of (f.weekly_plan as Day[]) ?? []) {
    const head =
      `${d.day ?? "Day"} — ${d.type ?? "Rest"}` +
      (d.duration_min ? ` (${d.duration_min} min)` : "");
    write(head, 10, { bold: true });
    for (const ex of d.exercises ?? [])
      write(`• ${ex.name ?? ""} — ${ex.sets ?? 1} x ${ex.reps_or_duration ?? ""}`, 10, { indent: 10 });
  }
  if (typeof f.progression_plan === "string") write(f.progression_plan, 9, { color: GREY, gap: 2 });

  // ---- Risk ----
  const r = (plan.risk_assessment ?? {}) as Record<string, unknown>;
  heading("Risk Assessment");
  write(
    `Overall risk: ${(r.overall_risk_level as string)?.toUpperCase() ?? "LOW"}  ·  ` +
      (r.safe_to_proceed === false ? "Physician clearance required" : "Safe to proceed"),
    10,
    { bold: true },
  );
  for (const fl of (r.medical_flags as MedFlag[]) ?? []) {
    write(`[${(fl.severity ?? "info").toUpperCase()}] ${fl.description ?? ""}`, 10, { indent: 10 });
    if (fl.recommendation) write(fl.recommendation, 9, { indent: 20, color: GREY });
  }

  // ---- Budget ----
  const b = (plan.budget_analysis ?? {}) as Record<string, unknown>;
  heading("Budget Analysis");
  write(
    `Food ${inr(num(b.weekly_food_cost_inr) ?? 0)}  ·  Gym ${inr(num(b.weekly_gym_cost_inr) ?? 0)}  ·  ` +
      `Supplements ${inr(num(b.weekly_supplement_cost_inr) ?? 0)}`,
    10,
  );
  write(
    `Total ${inr(num(b.total_weekly_cost_inr) ?? 0)} / week  ·  ` +
      (b.within_budget === false
        ? `Over budget by ${inr(Math.abs(num(b.budget_surplus_deficit_inr) ?? 0))}`
        : `Within budget (${inr(num(b.budget_surplus_deficit_inr) ?? 0)} surplus)`),
    10,
    { gap: 2 },
  );
  for (const a of (b.cheapest_alternatives as Alt[]) ?? []) {
    write(
      `Swap ${a.original ?? ""} -> ${a.alternative ?? ""}` +
        (a.saving_inr ? ` (save ${inr(a.saving_inr)})` : ""),
      10,
      { indent: 10 },
    );
    if (a.alternative) buyLine(a.alternative, a.alternative);
  }

  // ---- Insights + checklist ----
  if ((plan.key_insights ?? []).length) {
    heading("Key Insights");
    plan.key_insights.forEach((s, i) => write(`${i + 1}. ${s}`, 10, { indent: 4 }));
  }
  if ((plan.action_steps_week_1 ?? []).length) {
    heading("Week 1 Checklist");
    plan.action_steps_week_1.forEach((s) => write(`[ ] ${s}`, 10, { indent: 4 }));
  }

  if (plan.disclaimer) {
    y += 6;
    write(plan.disclaimer, 8, { color: GREY });
  }

  doc.save(`health-plan-${plan.plan_id.slice(0, 8)}.pdf`);
}
