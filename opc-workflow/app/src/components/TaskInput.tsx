import { useState } from 'react'
import type { FormEvent } from 'react'
// Shared singleton store; addTask is the only mutation this component
// needs, so it calls the store directly instead of going through props.
import { taskStore } from '../store/TaskStore'

// Controlled form: local state owns the field + error, the store only sees
// validated, trimmed descriptions.
function TaskInput() {
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault() // keep it an SPA — no full-page form post

    const trimmed = description.trim()
    if (trimmed.length === 0) {
      // Reject empty/whitespace-only input: show feedback and bail out
      // BEFORE touching the store, so no task is ever added.
      setError('Please enter a task description.')
      return
    }

    taskStore.addTask(trimmed) // store gets the trimmed value, not raw input
    setDescription('') // clear only happens on a successful add
    setError(null)
  }

  return (
    <form className="task-input" onSubmit={handleSubmit} noValidate>
      <label htmlFor="task-input-field">New task</label>
      <input
        id="task-input-field"
        type="text"
        value={description}
        onChange={(event) => {
          setDescription(event.target.value)
          // Clear stale feedback as soon as the user starts fixing the input.
          if (error !== null) setError(null)
        }}
        placeholder="What needs to be done?"
        aria-invalid={error !== null}
        aria-describedby={error !== null ? 'task-input-error' : undefined}
      />
      <button type="submit">Add task</button>
      {/* role="alert" announces the rejection immediately to screen readers. */}
      {error !== null && (
        <p id="task-input-error" className="task-input__error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

export default TaskInput
