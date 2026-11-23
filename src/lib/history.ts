/**
 * Application-wide undo/redo history.
 *
 * Every mutation goes through a `Command` so text edits, workspace operations,
 * timeline edits and settings share one undo stack. Monaco text edits are
 * represented by commands that delegate to Monaco's own undo stop, which keeps
 * a single user-visible timeline without duplicating text buffers.
 *
 * Commands are queued so keyboard repeats and async operations cannot
 * interleave `execute`/`undo` calls.
 */

export interface Command {
  /** Stable operation id, useful for tests and diagnostics. */
  readonly id: string;
  /** Human readable label (an i18n key once the caller resolves it). */
  readonly label: string;
  execute(): void | Promise<void>;
  undo(): void | Promise<void>;
  /** Defaults to `execute()` when omitted. */
  redo?(): void | Promise<void>;
  /** Consecutive commands with the same key can be merged into one step. */
  readonly mergeKey?: string;
  /** Returns a command representing both edits. */
  merge?(next: Command): Command;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  /** Number of undoable steps. */
  depth: number;
}

type Listener = (state: HistoryState) => void;

const DEFAULT_LIMIT = 200;
const MERGE_WINDOW_MS = 600;

export class HistoryService {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private readonly listeners = new Set<Listener>();
  private tail: Promise<void> = Promise.resolve();
  private lastMerge: { key: string; at: number } | null = null;
  private readonly limit: number;

  constructor(limit: number = DEFAULT_LIMIT) {
    if (limit < 1) throw new Error('History limit must be at least 1.');
    this.limit = limit;
  }

  get state(): HistoryState {
    const undo = this.undoStack[this.undoStack.length - 1];
    const redo = this.redoStack[this.redoStack.length - 1];
    return {
      canUndo: undo !== undefined,
      canRedo: redo !== undefined,
      undoLabel: undo?.label ?? null,
      redoLabel: redo?.label ?? null,
      depth: this.undoStack.length,
    };
  }

  /** Subscribes to history changes; returns an unsubscribe function. */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Executes a command and records it as one undo step. */
  async run(command: Command): Promise<void> {
    return this.enqueue(async () => {
      await command.execute();
      this.record(command);
    });
  }

  /** Records a command that was already executed (e.g. a Monaco undo stop). */
  async push(command: Command): Promise<void> {
    return this.enqueue(() => this.record(command));
  }

  async undo(): Promise<boolean> {
    return this.enqueue(async () => {
      const command = this.undoStack.pop();
      if (!command) return false;
      await command.undo();
      this.redoStack.push(command);
      this.lastMerge = null;
      this.emit();
      return true;
    });
  }

  async redo(): Promise<boolean> {
    return this.enqueue(async () => {
      const command = this.redoStack.pop();
      if (!command) return false;
      if (command.redo) await command.redo();
      else await command.execute();
      this.undoStack.push(command);
      this.lastMerge = null;
      this.emit();
      return true;
    });
  }

  /** Removes all steps with a merge key, e.g. when a file's models are closed. */
  async removeByKey(key: string): Promise<void> {
    return this.enqueue(() => {
      this.undoStack = this.undoStack.filter((command) => command.mergeKey !== key);
      this.redoStack = this.redoStack.filter((command) => command.mergeKey !== key);
      this.lastMerge = null;
      this.emit();
    });
  }

  /** Clears both stacks, e.g. when switching workspaces. */
  async clear(): Promise<void> {
    return this.enqueue(() => {
      this.undoStack = [];
      this.redoStack = [];
      this.lastMerge = null;
      this.emit();
    });
  }

  /** Serializes mutations so `run`, `push`, `undo` and `redo` never interleave. */
  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private record(command: Command): void {
    const previous = this.undoStack[this.undoStack.length - 1];
    const now = Date.now();
    const canMerge =
      command.mergeKey !== undefined &&
      previous?.mergeKey === command.mergeKey &&
      previous.merge !== undefined &&
      this.lastMerge?.key === command.mergeKey &&
      now - this.lastMerge.at <= MERGE_WINDOW_MS;

    if (canMerge && previous.merge) {
      this.undoStack[this.undoStack.length - 1] = previous.merge(command);
    } else {
      this.undoStack.push(command);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.lastMerge = command.mergeKey === undefined ? null : { key: command.mergeKey, at: now };
    this.redoStack = [];
    this.emit();
  }

  private emit(): void {
    const state = this.state;
    for (const listener of this.listeners) listener(state);
  }
}
