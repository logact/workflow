// useTasks() is the store's React bridge (useSyncExternalStore): it hands
// back the current snapshot and re-renders this component on every store
// mutation — so the list stays in sync automatically, no local state needed.
import { useTasks } from '../store/TaskStore'
import EmptyState from './EmptyState'
import TaskItem from './TaskItem'

// Pure read-model component: it owns no state and only maps the store
// snapshot to UI, delegating each entry's rendering to TaskItem and the
// empty case to EmptyState.
function TaskList() {
  const tasks = useTasks()

  // Empty list is a distinct UI state with its own component — bail out
  // early so the list markup below only ever deals with real entries.
  if (tasks.length === 0) {
    return <EmptyState />
  }

  return (
    <ul className="task-list">
      {tasks.map((task) => (
        // task.id is assigned once at creation and never changes, so it is
        // a stable key (index keys would break on deletes/reorders).
        <TaskItem key={task.id} task={task} />
      ))}
    </ul>
  )
}

export default TaskList
