/**
 * QuickFillModal — the structured form as an optional shortcut.
 *
 * Reuses the multi-step OnboardingForm but, instead of POSTing /run, assembles a
 * single natural-language message and posts it as one chat turn (the intake agent
 * then classifies it as "ready" and spawns the plan).
 */
import OnboardingForm from "./OnboardingForm";

interface QuickFillModalProps {
  onClose: () => void;
  onSubmit: (message: string) => void;
}

export default function QuickFillModal({ onClose, onSubmit }: QuickFillModalProps) {
  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0"
        style={{ background: "var(--color-overlay)" }}
      />
      <div
        className="glass-strong relative max-h-[90vh] w-[min(34rem,95vw)] overflow-y-auto p-6"
        style={{ animation: "springIn var(--duration-base) var(--spring)" }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-display text-lg font-bold text-content-primary">
            Quick fill your profile
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-content-muted hover:bg-surface-2 hover:text-content-primary"
          >
            ✕
          </button>
        </div>
        <OnboardingForm
          onQuickFill={(msg) => {
            onSubmit(msg);
            onClose();
          }}
        />
      </div>
    </div>
  );
}
