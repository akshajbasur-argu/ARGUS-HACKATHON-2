/**
 * Multi-step onboarding form (VibeFlow OS).
 *
 * 4 steps collecting the UserProfile. Steps slide in (spring), with a segmented
 * teal progress bar. Glass inputs, card selects, a live budget slider and a pill
 * toggle. On submit it generates a run_id, fires onPlanStart (so the parent can
 * open the SSE trace), then POSTs /api/run.
 */
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { runPlan, type FinalPlan, type UserProfile } from "../../lib/api";

// --- Schema (mirrors backend UserProfile constraints) -----------------------

const schema = z.object({
  age: z.number({ invalid_type_error: "Required" }).int().min(16).max(100),
  sex: z.enum(["male", "female", "other"]),
  weight_kg: z.number({ invalid_type_error: "Required" }).min(30).max(300),
  height_cm: z.number({ invalid_type_error: "Required" }).min(100).max(250),
  primary_goal: z.enum(["weight_loss", "muscle_gain", "endurance", "general_health"]),
  activity_level: z.enum(["sedentary", "lightly_active", "active", "very_active"]),
  medical_conditions: z.array(z.string()),
  dietary_restrictions: z.array(z.string()),
  weekly_budget_inr: z.number().min(500).max(20000),
  gym_access: z.boolean(),
});

type FormValues = z.infer<typeof schema>;

interface OnboardingFormProps {
  onPlanStart: (planId: string) => void;
  onPlanComplete?: (plan: FinalPlan) => void;
  onError?: (error: unknown) => void;
}

// --- Option metadata --------------------------------------------------------

const SEX_OPTIONS = [
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
  { value: "other", label: "Other" },
] as const;

const GOAL_OPTIONS = [
  { value: "weight_loss", label: "Weight Loss", icon: "🔥" },
  { value: "muscle_gain", label: "Muscle Gain", icon: "💪" },
  { value: "endurance", label: "Endurance", icon: "🏃" },
  { value: "general_health", label: "General Health", icon: "🌱" },
] as const;

const ACTIVITY_OPTIONS = [
  { value: "sedentary", label: "Sedentary", icon: "🪑" },
  { value: "lightly_active", label: "Lightly Active", icon: "🚶" },
  { value: "active", label: "Active", icon: "🚴" },
  { value: "very_active", label: "Very Active", icon: "⚡" },
] as const;

const COMMON_CONDITIONS = ["Type 2 Diabetes", "Hypertension", "Heart Disease", "PCOS"];
const COMMON_RESTRICTIONS = ["Vegetarian", "Vegan", "Eggetarian", "Gluten-free"];

const STEP_FIELDS: (keyof FormValues)[][] = [
  ["age", "sex", "weight_kg", "height_cm"],
  ["primary_goal", "activity_level"],
  ["medical_conditions", "dietary_restrictions"],
  ["weekly_budget_inr", "gym_access"],
];
const STEP_TITLES = ["About you", "Your goals", "Health context", "Budget & access"];

// --- Small building blocks --------------------------------------------------

const inputClass =
  "w-full rounded-md glass px-4 py-2.5 text-content-primary placeholder:text-content-muted " +
  "outline-none border border-border focus:border-accent-primary " +
  "transition-colors duration-base ease-spring";

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-content-secondary">{label}</span>
      {children}
      {error && <span className="mt-1 block text-xs text-accent-danger">{error}</span>}
    </label>
  );
}

function CardSelect<T extends string>({
  options,
  value,
  onSelect,
}: {
  options: readonly { value: T; label: string; icon?: string }[];
  value: T | undefined;
  onSelect: (v: T) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {options.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onSelect(opt.value)}
            className={`glass flex items-center gap-2 rounded-lg px-4 py-3 text-left transition-all duration-base ease-spring ${
              selected
                ? "border-accent-primary bg-accent-primary-soft text-content-primary"
                : "border-border text-content-secondary hover:border-border-strong"
            }`}
          >
            {opt.icon && <span className="text-xl">{opt.icon}</span>}
            <span className="text-sm font-medium">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function TagInput({
  value,
  onChange,
  placeholder,
  suggestions,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  suggestions: string[];
}) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const tag = raw.trim();
    if (tag && !value.includes(tag)) onChange([...value, tag]);
    setDraft("");
  };
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-2">
        {value.map((tag) => (
          <span
            key={tag}
            className="flex items-center gap-1 rounded-pill bg-accent-primary-soft px-3 py-1 text-sm text-accent-primary"
          >
            {tag}
            <button
              type="button"
              onClick={() => onChange(value.filter((t) => t !== tag))}
              className="text-accent-primary/70 hover:text-accent-primary"
              aria-label={`Remove ${tag}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        className={inputClass}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          }
        }}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        {suggestions
          .filter((s) => !value.includes(s))
          .map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              className="rounded-pill border border-border px-2.5 py-1 text-xs text-content-muted transition-colors duration-base ease-spring hover:border-accent-primary hover:text-accent-primary"
            >
              + {s}
            </button>
          ))}
      </div>
    </div>
  );
}

// --- Main component ---------------------------------------------------------

export default function OnboardingForm({
  onPlanStart,
  onPlanComplete,
  onError,
}: OnboardingFormProps) {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<"right" | "left">("right");
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    trigger,
    formState: { errors, isValid },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: "onChange",
    defaultValues: {
      medical_conditions: [],
      dietary_restrictions: [],
      weekly_budget_inr: 2000,
      gym_access: true,
    },
  });

  const values = watch();
  const isLast = step === STEP_FIELDS.length - 1;

  const next = async () => {
    const ok = await trigger(STEP_FIELDS[step]);
    if (!ok) return;
    setDirection("right");
    setStep((s) => Math.min(s + 1, STEP_FIELDS.length - 1));
  };
  const back = () => {
    setDirection("left");
    setStep((s) => Math.max(s - 1, 0));
  };

  const onSubmit = async (data: FormValues) => {
    const planId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `run-${Date.now()}`;
    setSubmitting(true);
    onPlanStart(planId); // parent opens the SSE trace before the run begins
    try {
      const plan = await runPlan({ profile: data as UserProfile, run_id: planId });
      onPlanComplete?.(plan);
    } catch (err) {
      onError?.(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex h-full flex-col">
      {/* Segmented progress bar */}
      <div className="mb-6 flex gap-1.5">
        {STEP_TITLES.map((title, i) => (
          <div
            key={title}
            className="h-1.5 flex-1 overflow-hidden rounded-pill bg-surface-2"
          >
            <div
              className="h-full rounded-pill transition-all duration-base ease-spring"
              style={{
                width: i <= step ? "100%" : "0%",
                background: "var(--gradient-primary)",
              }}
            />
          </div>
        ))}
      </div>

      {/* Step body (keyed so it re-animates on change) */}
      <div
        key={step}
        className="flex-1"
        style={{
          animation: `${
            direction === "right" ? "slideInRight" : "slideInLeft"
          } var(--duration-base) var(--spring)`,
        }}
      >
        <h3 className="mb-4 font-display text-xl font-semibold">{STEP_TITLES[step]}</h3>

        {step === 0 && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Age" error={errors.age?.message}>
                <input
                  type="number"
                  className={inputClass}
                  placeholder="34"
                  {...register("age", { valueAsNumber: true })}
                />
              </Field>
              <Field label="Weight (kg)" error={errors.weight_kg?.message}>
                <input
                  type="number"
                  className={inputClass}
                  placeholder="88"
                  {...register("weight_kg", { valueAsNumber: true })}
                />
              </Field>
            </div>
            <Field label="Height (cm)" error={errors.height_cm?.message}>
              <input
                type="number"
                className={inputClass}
                placeholder="175"
                {...register("height_cm", { valueAsNumber: true })}
              />
            </Field>
            <Field label="Sex" error={errors.sex?.message}>
              <CardSelect
                options={SEX_OPTIONS}
                value={values.sex}
                onSelect={(v) => setValue("sex", v, { shouldValidate: true })}
              />
            </Field>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-5">
            <Field label="Primary goal" error={errors.primary_goal?.message}>
              <CardSelect
                options={GOAL_OPTIONS}
                value={values.primary_goal}
                onSelect={(v) => setValue("primary_goal", v, { shouldValidate: true })}
              />
            </Field>
            <Field label="Activity level" error={errors.activity_level?.message}>
              <CardSelect
                options={ACTIVITY_OPTIONS}
                value={values.activity_level}
                onSelect={(v) => setValue("activity_level", v, { shouldValidate: true })}
              />
            </Field>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <Field label="Medical conditions (optional)">
              <TagInput
                value={values.medical_conditions ?? []}
                onChange={(v) =>
                  setValue("medical_conditions", v, { shouldValidate: true })
                }
                placeholder="Type a condition and press Enter"
                suggestions={COMMON_CONDITIONS}
              />
            </Field>
            <Field label="Dietary restrictions (optional)">
              <TagInput
                value={values.dietary_restrictions ?? []}
                onChange={(v) =>
                  setValue("dietary_restrictions", v, { shouldValidate: true })
                }
                placeholder="Type a restriction and press Enter"
                suggestions={COMMON_RESTRICTIONS}
              />
            </Field>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-6">
            <Field label="Weekly budget">
              <div className="mb-2 font-display text-2xl text-accent-primary">
                ₹{(values.weekly_budget_inr ?? 0).toLocaleString("en-IN")}
                <span className="ml-1 text-sm text-content-muted">/ week</span>
              </div>
              <input
                type="range"
                min={500}
                max={20000}
                step={100}
                className="w-full accent-[var(--color-accent-primary)]"
                {...register("weekly_budget_inr", { valueAsNumber: true })}
              />
            </Field>
            <Field label="Gym access">
              <button
                type="button"
                onClick={() =>
                  setValue("gym_access", !values.gym_access, { shouldValidate: true })
                }
                className={`relative flex h-8 w-16 items-center rounded-pill border transition-colors duration-base ease-spring ${
                  values.gym_access
                    ? "border-accent-primary bg-accent-primary-soft"
                    : "border-border bg-surface-2"
                }`}
                role="switch"
                aria-checked={values.gym_access}
              >
                <span
                  className="absolute h-6 w-6 rounded-full transition-all duration-base ease-spring"
                  style={{
                    left: values.gym_access ? "calc(100% - 1.75rem)" : "0.25rem",
                    background: values.gym_access
                      ? "var(--gradient-primary)"
                      : "var(--color-text-muted)",
                  }}
                />
              </button>
              <span className="ml-3 text-sm text-content-secondary">
                {values.gym_access ? "Yes" : "No"}
              </span>
            </Field>
          </div>
        )}
      </div>

      {/* Navigation / CTA */}
      <div className="mt-6 flex items-center gap-3">
        {step > 0 && (
          <button
            type="button"
            onClick={back}
            className="rounded-md border border-border px-4 py-2.5 text-sm text-content-secondary transition-colors duration-base ease-spring hover:border-border-strong"
          >
            Back
          </button>
        )}

        {!isLast ? (
          <button
            type="button"
            onClick={next}
            className="flex-1 rounded-md bg-accent-primary py-2.5 font-display font-semibold text-base transition-all duration-base ease-spring hover:scale-[1.02] hover:shadow-glow-primary active:scale-100"
          >
            Continue
          </button>
        ) : (
          <button
            type="submit"
            disabled={!isValid || submitting}
            className="flex flex-1 items-center justify-center gap-2 rounded-md bg-accent-primary py-2.5 font-display font-semibold text-base transition-all duration-base ease-spring hover:scale-[1.02] hover:shadow-glow-primary active:scale-100 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100 disabled:hover:shadow-none"
          >
            {submitting ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-base/40 border-t-base" />
                AI agents working…
              </>
            ) : (
              "Generate My Health Plan"
            )}
          </button>
        )}
      </div>
    </form>
  );
}
