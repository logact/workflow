import { useSyncExternalStore } from 'react';

export interface Task {
  id: string;
  description: string;
  completed: boolean;
}

type Listener = () => void;

// Module-level counter guarantees unique, readable ids without extra deps.
let nextId = 0;
const createId = () => `task-${++nextId}`;

class TaskStore {
  private tasks: Task[] = [];
  private listeners = new Set<Listener>();

  // Returns an unsubscribe function — the contract useSyncExternalStore expects.
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  // Snapshot must be referentially stable between mutations, so state is
  // only ever replaced (never mutated in place) and this is a plain getter.
  getSnapshot = (): Task[] => this.tasks;

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  addTask(description: string): void {
    const task: Task = { id: createId(), description, completed: false };
    this.tasks = [...this.tasks, task];
    this.notify();
  }

  toggleTask(id: string): void {
    this.tasks = this.tasks.map((task) =>
      task.id === id ? { ...task, completed: !task.completed } : task,
    );
    this.notify();
  }

  deleteTask(id: string): void {
    this.tasks = this.tasks.filter((task) => task.id !== id);
    this.notify();
  }
}

// Single shared instance so every component observes the same state.
export const taskStore = new TaskStore();

// Bridge to React: re-renders the component whenever the store notifies.
export function useTasks(): Task[] {
  return useSyncExternalStore(taskStore.subscribe, taskStore.getSnapshot);
}
