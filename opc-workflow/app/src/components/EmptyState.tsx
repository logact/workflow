// Presentational only: no store, hooks, or state — the parent decides
// when to render this (e.g. `tasks.length === 0`), keeping it trivially testable.
function EmptyState() {
  return (
    // role="status" makes the message announced politely by screen readers.
    <div className="empty-state" role="status">
      <p className="empty-state__title">No tasks yet</p>
      <p className="empty-state__hint">Add your first task to get started.</p>
    </div>
  )
}

export default EmptyState
