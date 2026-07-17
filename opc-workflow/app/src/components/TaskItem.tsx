import type { Task } from '../store/TaskStore'
// Same pattern as TaskInput: mutations go straight to the shared singleton
// store instead of through prop callbacks, so TaskList stays a pure mapper.
import { taskStore } from '../store/TaskStore'

interface TaskItemProps {
  task: Task
}

// Presentational row for a single task: a toggle for completion and a
// delete button — exactly the mutations TaskStore currently exposes.
function TaskItem({ task }: TaskItemProps) {
  return (
    <li className="task-item">
      <label className="task-item__label">
        <input
          type="checkbox"
          checked={task.completed}
          onChange={() => taskStore.toggleTask(task.id)}
        />
        <span
          className={
            task.completed
              ? 'task-item__description task-item__description--completed'
              : 'task-item__description'
          }
        >
          {task.description}
        </span>
      </label>
      {/* aria-label repeats the description so the action is identifiable
          when several identical "Delete" buttons are on screen. */}
      <button
        type="button"
        className="task-item__delete"
        onClick={() => taskStore.deleteTask(task.id)}
        aria-label={`Delete task: ${task.description}`}
      >
        Delete
      </button>
    </li>
  )
}

export default TaskItem
