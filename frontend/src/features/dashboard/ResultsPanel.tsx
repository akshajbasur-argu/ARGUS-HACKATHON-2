/**
 * Results Dashboard — the reveal moment. Renders a FinalPlan as five glass
 * sections (Nutrition/Macros/Fitness/Risk/Budget) plus a header score ring and
 * an insights/checklist footer. SVG-only charts (no charting library), each
 * section animates in on scroll-into-view.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { FinalPlan } from "../../lib/api";

// --- Loose shapes for the agent .data payloads (any field may be absent) ----

interface Meal { meal?: string; foods?: string[]; calories?: number }
interface NutritionData {
  daily_calories?: number;
  meal_plan?: Meal[];
  foods_to_avoid?: string[];
  hydration_litres?: number;
  supplement_suggestions?: string[];
}
interface MacroSplit { protein?: number; carbs?: number; fat?: number }
interface MacrosData {
  bmr?: number;
  tdee?: number;
  target_calories?: number;
  macros_g?: MacroSplit;
  macros_pct?: MacroSplit;
  micros?: Record<string, number>;
  water_ml?: number;
  calculation_steps?: string[];
}
interface Exercise { name?: string; sets?: number; reps_or_duration?: string; rest_sec?: number }
interface Day {
  day?: string;
  type?: string;
  duration_min?: number;
  exercises?: Exercise[];
  calories_burned_est?: number;
  notes?: string;
}
interface FitnessData {
  weekly_plan?: Day[];
  weekly_stats?: Record<string, number>;
  progression_plan?: string;
  equipment_needed?: string[];
}
interface MedFlag {
  flag_id?: string;
  severity?: string;
  agent_responsible?: string;
  description?: string;
  recommendation?: string;
  icd_10_code?: string;
}
interface RiskData {
  overall_risk_level?: string;
  medical_flags?: MedFlag[];
  safe_to_proceed?: boolean;
  requires_physician_clearance?: boolean;
  emergency_signs?: string[];
}
interface Alt { original?: string; alternative?: string; saving_inr?: number }
interface BudgetData {
  weekly_food_cost_inr?: number;
  weekly_gym_cost_inr?: number;
  weekly_supplement_cost_inr?: number;
  total_weekly_cost_inr?: number;
  user_budget_inr?: number;
  budget_surplus_deficit_inr?: number;
  within_budget?: boolean;
  budget_optimisations?: string[];
  cheapest_alternatives?: Alt[];
}

const TEAL = "var(--color-accent-primary)";
const VIOLET = "var(--color-accent-secondary)";
const AMBER = "var(--color-accent-warning)";
const DANGER = "var(--color-accent-danger)";
const INFO = "var(--color-accent-info)";

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

// --- Animation hooks --------------------------------------------------------

function useInView<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (e?.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, inView] as const;
}

function useCountUp(target: number, duration = 400) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min((t - start) / duration, 1);
      setVal(target * (1 - Math.pow(1 - p, 2))); // ease-out
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

function useMounted(delay = 50) {
  const [m, setM] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setM(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  return m;
}

// --- Generic pieces ---------------------------------------------------------

function Section({
  accent,
  title,
  icon,
  children,
}: {
  accent: string;
  title: string;
  icon: string;
  children: React.ReactNode;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={`glass p-5 transition-all duration-slow ease-spring ${
        inView ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
      }`}
      style={{ borderTop: `2px solid ${accent}` }}
    >
      <h3 className="mb-4 flex items-center gap-2 font-display text-lg font-semibold">
        <span>{icon}</span>
        {title}
      </h3>
      {children}
    </div>
  );
}

function Collapsible({ summary, children }: { summary: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-content-secondary"
      >
        {summary}
        <span className={`transition-transform duration-base ${open ? "rotate-180" : ""}`}>⌄</span>
      </button>
      {open && <div className="px-3 pb-3 text-sm text-content-muted">{children}</div>}
    </div>
  );
}

function CircularScore({ score }: { score: number }) {
  const v = useCountUp(score);
  const r = 52;
  const circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(10, v)) / 10;
  return (
    <svg width={120} height={120} viewBox="0 0 120 120">
      <circle cx={60} cy={60} r={r} fill="none" stroke="var(--color-surface-2)" strokeWidth={10} />
      <circle
        cx={60}
        cy={60}
        r={r}
        fill="none"
        stroke={TEAL}
        strokeWidth={10}
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={circ * (1 - pct)}
        transform="rotate(-90 60 60)"
      />
      <text x={60} y={56} textAnchor="middle" className="fill-content-primary font-display" fontSize={26} fontWeight={700}>
        {v.toFixed(1)}
      </text>
      <text x={60} y={76} textAnchor="middle" className="fill-content-muted" fontSize={11}>
        / 10
      </text>
    </svg>
  );
}

// --- Section 1: Nutrition ---------------------------------------------------

function NutritionSection({ data }: { data: NutritionData }) {
  const meals = data.meal_plan ?? [];
  return (
    <Section accent={TEAL} title="Nutrition Plan" icon="🥗">
      {data.daily_calories !== undefined && (
        <p className="mb-3 text-sm text-content-secondary">
          Daily target: <span className="text-accent-primary">{data.daily_calories} kcal</span>
          {data.hydration_litres ? ` · ${data.hydration_litres} L water` : ""}
        </p>
      )}
      {meals.length === 0 ? (
        <p className="text-sm text-content-muted">No meal plan available.</p>
      ) : (
        <div className="-mx-1 flex gap-3 overflow-x-auto pb-2">
          {meals.map((m, i) => (
            <div
              key={`${m.meal}-${i}`}
              className="glass min-w-[10rem] shrink-0 p-3"
              style={{ animation: `springIn var(--duration-base) var(--spring) ${i * 50}ms both` }}
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium">{m.meal ?? `Meal ${i + 1}`}</span>
                <span className="text-xs text-accent-primary">{m.calories ?? 0} kcal</span>
              </div>
              <ul className="space-y-0.5 text-xs text-content-muted">
                {(m.foods ?? []).map((f, j) => (
                  <li key={j}>• {f}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {(data.supplement_suggestions ?? []).length > 0 && (
        <p className="mt-3 text-xs text-content-muted">
          Supplements: {(data.supplement_suggestions ?? []).join(", ")}
        </p>
      )}
    </Section>
  );
}

// --- Section 2: Macros ------------------------------------------------------

function MacroBar({ label, pct, grams, color }: { label: string; pct: number; grams?: number; color: string }) {
  const mounted = useMounted();
  return (
    <div className="mb-3">
      <div className="mb-1 flex justify-between text-xs text-content-secondary">
        <span>{label}{grams !== undefined ? ` · ${grams} g` : ""}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-pill bg-surface-2">
        <div
          className="h-full rounded-pill"
          style={{ width: mounted ? `${pct}%` : "0%", background: color, transition: "width 600ms var(--ease-out)" }}
        />
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass flex-1 p-3 text-center">
      <div className="font-display text-lg text-accent-secondary">{value}</div>
      <div className="text-xs text-content-muted">{label}</div>
    </div>
  );
}

function MacrosSection({ data }: { data: MacrosData }) {
  const g = data.macros_g ?? {};
  const pct = data.macros_pct ?? {};
  const steps = data.calculation_steps ?? [];
  return (
    <Section accent={VIOLET} title="Macro Targets" icon="🧮">
      <div className="mb-4 flex gap-3">
        <StatCard label="BMR" value={data.bmr ? `${Math.round(data.bmr)}` : "—"} />
        <StatCard label="TDEE" value={data.tdee ? `${Math.round(data.tdee)}` : "—"} />
        <StatCard label="Target" value={data.target_calories ? `${Math.round(data.target_calories)}` : "—"} />
      </div>
      <MacroBar label="Protein" pct={pct.protein ?? 0} grams={g.protein} color={TEAL} />
      <MacroBar label="Carbs" pct={pct.carbs ?? 0} grams={g.carbs} color={VIOLET} />
      <MacroBar label="Fat" pct={pct.fat ?? 0} grams={g.fat} color={AMBER} />
      {steps.length > 0 && (
        <div className="mt-3">
          <Collapsible summary="How we calculated this">
            <ol className="list-decimal space-y-1 pl-4">
              {steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </Collapsible>
        </div>
      )}
    </Section>
  );
}

// --- Section 3: Fitness -----------------------------------------------------

const DAY_TYPE_COLOR: Record<string, string> = {
  Strength: TEAL,
  Cardio: INFO,
  HIIT: AMBER,
  Rest: "var(--color-text-muted)",
  Flexibility: VIOLET,
};

function FitnessSection({ data }: { data: FitnessData }) {
  const week = data.weekly_plan ?? [];
  const [openDay, setOpenDay] = useState<number | null>(null);
  return (
    <Section accent={AMBER} title="Fitness Programme" icon="💪">
      {week.length === 0 ? (
        <p className="text-sm text-content-muted">No programme available.</p>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {week.map((d, i) => {
            const color = DAY_TYPE_COLOR[d.type ?? "Rest"] ?? INFO;
            const open = openDay === i;
            const exercises = d.exercises ?? [];
            return (
              <div key={i} className="rounded-md border border-border">
                <button
                  type="button"
                  onClick={() => setOpenDay(open ? null : i)}
                  className="flex w-full items-center justify-between px-3 py-2"
                >
                  <span className="text-sm font-medium">{d.day ?? `Day ${i + 1}`}</span>
                  <span className="flex items-center gap-2 text-xs">
                    <span className="rounded-pill px-2 py-0.5" style={{ background: `${color}22`, color }}>
                      {d.type ?? "Rest"}
                    </span>
                    {d.duration_min ? <span className="text-content-muted">{d.duration_min}m</span> : null}
                  </span>
                </button>
                {open && exercises.length > 0 && (
                  <ul className="space-y-1 px-3 pb-3 text-xs text-content-muted">
                    {exercises.map((ex, j) => (
                      <li key={j}>
                        • {ex.name} — {ex.sets ?? 1}×{ex.reps_or_duration ?? ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
      {data.progression_plan && (
        <p className="mt-3 text-xs text-content-muted">{data.progression_plan}</p>
      )}
    </Section>
  );
}

// --- Section 4: Risk --------------------------------------------------------

const RISK_BADGE: Record<string, { color: string; pulse: boolean }> = {
  low: { color: "var(--color-accent-primary)", pulse: false },
  medium: { color: AMBER, pulse: false },
  high: { color: DANGER, pulse: false },
  critical: { color: DANGER, pulse: true },
};

function RiskSection({ data }: { data: RiskData }) {
  const level = data.overall_risk_level ?? "low";
  const badge = RISK_BADGE[level] ?? RISK_BADGE["low"]!;
  const flags = data.medical_flags ?? [];
  const safe = data.safe_to_proceed !== false;
  return (
    <Section accent={badge.color} title="Risk Assessment" icon="🛡️">
      <div className="mb-3 flex items-center gap-3">
        <span
          className={`rounded-pill px-3 py-1 text-sm font-semibold ${badge.pulse ? "animate-pulse" : ""}`}
          style={{ background: `${badge.color}22`, color: badge.color }}
        >
          {level.toUpperCase()}
        </span>
        <span className={`text-sm ${safe ? "text-accent-primary" : "text-accent-danger"}`}>
          {safe ? "✓ Safe to proceed" : "⚠ Physician clearance required"}
        </span>
      </div>
      {flags.length > 0 && (
        <div className="space-y-2">
          {flags.map((f, i) => (
            <Collapsible key={f.flag_id ?? i} summary={`${(f.severity ?? "info").toUpperCase()} · ${f.description ?? ""}`}>
              <p>{f.recommendation}</p>
              {f.icd_10_code && <p className="mt-1 text-content-muted">ICD-10: {f.icd_10_code}</p>}
            </Collapsible>
          ))}
        </div>
      )}
      {(data.emergency_signs ?? []).length > 0 && (
        <p className="mt-3 text-xs text-content-muted">
          Watch for: {(data.emergency_signs ?? []).join("; ")}
        </p>
      )}
    </Section>
  );
}

// --- Section 5: Budget ------------------------------------------------------

function Donut({ segments }: { segments: { label: string; value: number; color: string }[] }) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  const r = 42;
  const circ = 2 * Math.PI * r;
  let acc = 0;
  return (
    <svg width={140} height={140} viewBox="0 0 120 120">
      {segments.map((s) => {
        const frac = s.value / total;
        const dash = circ * frac;
        const off = -circ * acc;
        acc += frac;
        return (
          <circle
            key={s.label}
            cx={60}
            cy={60}
            r={r}
            fill="none"
            stroke={s.color}
            strokeWidth={16}
            strokeDasharray={`${dash} ${circ - dash}`}
            strokeDashoffset={off}
            transform="rotate(-90 60 60)"
          />
        );
      })}
      <text x={60} y={64} textAnchor="middle" className="fill-content-primary font-display" fontSize={14}>
        {inr(total)}
      </text>
    </svg>
  );
}

function BudgetSection({ data }: { data: BudgetData }) {
  const within = data.within_budget !== false;
  const segments = [
    { label: "Food", value: data.weekly_food_cost_inr ?? 0, color: TEAL },
    { label: "Gym", value: data.weekly_gym_cost_inr ?? 0, color: VIOLET },
    { label: "Supplements", value: data.weekly_supplement_cost_inr ?? 0, color: AMBER },
  ].filter((s) => s.value > 0);
  const alts = data.cheapest_alternatives ?? [];
  return (
    <Section accent={TEAL} title="Budget Analysis" icon="💰">
      <div className="flex flex-wrap items-center gap-4">
        {segments.length > 0 && <Donut segments={segments} />}
        <div className="flex-1 space-y-2">
          {segments.map((s) => (
            <div key={s.label} className="flex items-center gap-2 text-sm">
              <span className="h-3 w-3 rounded-full" style={{ background: s.color }} />
              <span className="flex-1 text-content-secondary">{s.label}</span>
              <span className="text-content-muted">{inr(s.value)}</span>
            </div>
          ))}
          <div
            className={`mt-2 rounded-md px-3 py-2 text-sm ${
              within ? "text-accent-primary" : "text-accent-danger"
            }`}
            style={{ background: within ? "var(--color-accent-primary-soft)" : "var(--color-accent-danger-soft)" }}
          >
            {within
              ? `✓ Within budget · ${inr(data.budget_surplus_deficit_inr ?? 0)} surplus`
              : `⚠ Over budget by ${inr(Math.abs(data.budget_surplus_deficit_inr ?? 0))}`}
          </div>
        </div>
      </div>
      {alts.length > 0 && (
        <div className="mt-3 space-y-1 text-xs text-content-muted">
          {alts.map((a, i) => (
            <div key={i}>
              ↔ {a.original} → <span className="text-accent-primary">{a.alternative}</span>
              {a.saving_inr ? ` (save ${inr(a.saving_inr)})` : ""}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// --- Footer: insights + checklist -------------------------------------------

function Checklist({ planId, steps }: { planId: string; steps: string[] }) {
  const key = `hpo:checklist:${planId}`;
  const [done, setDone] = useState<Record<number, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "{}") as Record<number, boolean>;
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(done));
    } catch {
      /* storage unavailable — ignore */
    }
  }, [done, key]);
  return (
    <ul className="space-y-2">
      {steps.map((s, i) => (
        <li key={i}>
          <button
            type="button"
            onClick={() => setDone((d) => ({ ...d, [i]: !d[i] }))}
            className="flex w-full items-start gap-2 text-left text-sm"
          >
            <span
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                done[i] ? "border-accent-primary bg-accent-primary text-base" : "border-border"
              }`}
            >
              {done[i] ? "✓" : ""}
            </span>
            <span className={done[i] ? "text-content-muted line-through" : "text-content-secondary"}>{s}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// --- Main component ---------------------------------------------------------

export default function ResultsPanel({ plan }: { plan: FinalPlan }) {
  const nutrition = plan.nutrition_plan as unknown as NutritionData;
  const macros = plan.macros_targets as unknown as MacrosData;
  const fitness = plan.fitness_programme as unknown as FitnessData;
  const risk = plan.risk_assessment as unknown as RiskData;
  const budget = plan.budget_analysis as unknown as BudgetData;
  const insights = useMemo(() => plan.key_insights ?? [], [plan.key_insights]);

  const generatedDate = (() => {
    const d = new Date(plan.generated_at);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
  })();

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
      {/* Print-only header (shows in the PDF/print view) */}
      <div className="hidden border-b border-black pb-2 print:block">
        <span className="font-display text-lg font-bold">
          Health Plan — generated {generatedDate} by HealthFlow AI
        </span>
      </div>

      {/* Header */}
      <div className="glass flex items-center gap-4 p-5">
        <CircularScore score={plan.overall_health_score} />
        <div>
          <h2 className="font-display text-xl font-bold">
            <span className="text-gradient">Your personalised plan is ready</span>
          </h2>
          <p className="mt-1 text-sm text-content-secondary">{plan.user_summary}</p>
        </div>
      </div>

      <NutritionSection data={nutrition} />
      <MacrosSection data={macros} />
      <FitnessSection data={fitness} />
      <RiskSection data={risk} />
      <BudgetSection data={budget} />

      {/* Footer */}
      <div className="glass p-5">
        {insights.length > 0 && (
          <>
            <h3 className="mb-3 font-display text-lg font-semibold">Key insights</h3>
            <ol className="mb-5 space-y-2">
              {insights.map((s, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-content-secondary">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-primary-soft text-xs text-accent-primary">
                    {i + 1}
                  </span>
                  {s}
                </li>
              ))}
            </ol>
          </>
        )}

        {(plan.action_steps_week_1 ?? []).length > 0 && (
          <>
            <h3 className="mb-3 font-display text-lg font-semibold">Week 1 checklist</h3>
            <Checklist planId={plan.plan_id} steps={plan.action_steps_week_1} />
          </>
        )}

        <div className="mt-5 flex items-center justify-between">
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-md border border-border px-4 py-2 text-sm text-content-secondary transition-colors duration-base ease-spring hover:border-accent-primary hover:text-accent-primary print:hidden"
          >
            ⬇ Download Plan
          </button>
          <span className="text-xs text-content-muted">
            Score {plan.overall_health_score}/10 · {plan.debate_rounds} round(s)
          </span>
        </div>

        {plan.disclaimer && (
          <p className="mt-4 text-xs leading-relaxed text-content-muted">{plan.disclaimer}</p>
        )}
      </div>
    </div>
  );
}
