/** @type {import('tailwindcss').Config} */

/*
 * Tailwind theme is wired to the VibeFlow OS tokens in src/styles/vibeflow.css.
 * Every value below references a CSS custom property, so vibeflow.css remains
 * the single source of truth — change a token there and the utility updates.
 *
 * Note: because colours resolve to var() (not raw channels), Tailwind's opacity
 * modifiers (e.g. `bg-accent-primary/50`) won't compute. Use the dedicated
 * `*-soft` tokens or arbitrary values for translucency.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: "var(--color-base)",
        surface: {
          1: "var(--color-surface-1)",
          2: "var(--color-surface-2)",
          3: "var(--color-surface-3)",
        },
        accent: {
          primary: "var(--color-accent-primary)",
          "primary-soft": "var(--color-accent-primary-soft)",
          secondary: "var(--color-accent-secondary)",
          "secondary-soft": "var(--color-accent-secondary-soft)",
          warning: "var(--color-accent-warning)",
          danger: "var(--color-accent-danger)",
          info: "var(--color-accent-info)",
        },
        content: {
          primary: "var(--color-text-primary)",
          secondary: "var(--color-text-secondary)",
          muted: "var(--color-text-muted)",
        },
        border: {
          subtle: "var(--color-border-subtle)",
          DEFAULT: "var(--color-border)",
          strong: "var(--color-border-strong)",
        },
      },
      fontFamily: {
        display: "var(--font-display)",
        body: "var(--font-body)",
        mono: "var(--font-mono)",
      },
      fontSize: {
        xs: "var(--text-xs)",
        sm: "var(--text-sm)",
        base: "var(--text-base)",
        lg: "var(--text-lg)",
        xl: "var(--text-xl)",
        "2xl": "var(--text-2xl)",
        "3xl": "var(--text-3xl)",
        "4xl": "var(--text-4xl)",
        "5xl": "var(--text-5xl)",
      },
      spacing: {
        1: "var(--space-1)",
        2: "var(--space-2)",
        3: "var(--space-3)",
        4: "var(--space-4)",
        5: "var(--space-5)",
        6: "var(--space-6)",
        8: "var(--space-8)",
        10: "var(--space-10)",
        12: "var(--space-12)",
        16: "var(--space-16)",
        20: "var(--space-20)",
        24: "var(--space-24)",
      },
      borderRadius: {
        xs: "var(--radius-xs)",
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        "2xl": "var(--radius-2xl)",
        pill: "var(--radius-pill)",
      },
      boxShadow: {
        xs: "var(--shadow-xs)",
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        xl: "var(--shadow-xl)",
        "glow-primary": "var(--glow-primary)",
        "glow-secondary": "var(--glow-secondary)",
        "glow-warning": "var(--glow-warning)",
        "glow-danger": "var(--glow-danger)",
      },
      transitionTimingFunction: {
        spring: "var(--spring)",
        "ease-out-soft": "var(--ease-out)",
      },
      transitionDuration: {
        fast: "200ms",
        base: "300ms",
        slow: "400ms",
      },
      backdropBlur: {
        glass: "var(--glass-blur)",
      },
      keyframes: {
        // Mirrors the @keyframes in vibeflow.css so Tailwind's animate-* works.
        gradientFlow: {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
        },
        springIn: {
          "0%": { opacity: "0", transform: "translateY(12px) scale(0.96)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        pulseGlow: {
          "0%, 100%": { boxShadow: "var(--glow-primary)", opacity: "1" },
          "50%": { boxShadow: "var(--glow-primary-lg)", opacity: "0.78" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "gradient-flow": "gradientFlow 18s var(--ease-in-out) infinite",
        "spring-in": "springIn var(--duration-slow) var(--spring) both",
        "pulse-glow": "pulseGlow 2.4s var(--ease-in-out) infinite",
        shimmer: "shimmer 1.6s linear infinite",
      },
    },
  },
  plugins: [],
};
