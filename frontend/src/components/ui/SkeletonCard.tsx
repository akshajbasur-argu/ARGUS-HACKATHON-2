/**
 * SkeletonCard — shimmer placeholder matching an AgentTraceView agent card's
 * layout (glass card, left border, icon + name row, confidence bar, two verdict
 * lines). Shown before the first SSE event arrives. Shimmer = 1.5s loop via the
 * `.skeleton` utility in vibeflow.css.
 */
export default function SkeletonCard() {
  return (
    <div className="glass border-l-4 border-border p-4" aria-hidden="true">
      {/* header: icon + name | status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="skeleton h-5 w-5 rounded-full" />
          <div className="skeleton h-4 w-24" />
        </div>
        <div className="skeleton h-3 w-16" />
      </div>

      {/* confidence bar */}
      <div className="mt-3">
        <div className="skeleton mb-1 h-3 w-20" />
        <div className="skeleton h-1.5 w-full rounded-pill" />
      </div>

      {/* verdict (2 lines) */}
      <div className="mt-3 space-y-1.5">
        <div className="skeleton h-3 w-full" />
        <div className="skeleton h-3 w-4/5" />
      </div>
    </div>
  );
}
