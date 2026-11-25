/**
 * Timeline persistence.
 *
 * The document lives in the workspace as `.flaxia/timeline.json`, so it is
 * exported with the ZIP, and it is invisible to Test Play and the Linux guest
 * (both skip dotfiles / `.flaxia`). Saves are debounced like the editor's.
 *
 * Every user edit goes through `update` / `updateWith`, which report the old
 * and new document so the app can push an undo command. `apply` replays a
 * history command and deliberately skips that callback to avoid recursion.
 */

import type { Workspace } from '../fs/workspace.ts';
import {
  createTimeline,
  type MediaAsset,
  parseTimeline,
  serializeTimeline,
  type TimelineDoc,
} from '../lib/timeline.ts';

export const TIMELINE_PATH = '.flaxia/timeline.json';

const SAVE_DELAY_MS = 400;

export type TimelineHistoryListener = (previous: TimelineDoc, next: TimelineDoc, label: string) => void;

export class TimelineStore {
  private readonly workspace: Workspace;
  private readonly onChange: () => void;
  private readonly onHistory?: TimelineHistoryListener;
  private doc: TimelineDoc | null = null;
  private timer: number | undefined;
  private saving: Promise<void> = Promise.resolve();

  constructor(workspace: Workspace, onChange: () => void, onHistory?: TimelineHistoryListener) {
    this.workspace = workspace;
    this.onChange = onChange;
    this.onHistory = onHistory;
  }

  get current(): TimelineDoc | null {
    return this.doc;
  }

  /** Loads the document once; subsequent calls return the cached state. */
  async load(): Promise<TimelineDoc> {
    if (this.doc) return this.doc;
    const raw = this.workspace.readFile(TIMELINE_PATH);
    let parsed: TimelineDoc;
    try {
      parsed = raw ? parseTimeline(JSON.parse(raw)) : createTimeline();
    } catch {
      parsed = createTimeline();
    }
    this.doc = parsed;
    return parsed;
  }

  /** Applies a user edit and records it in the shared undo history. */
  update(next: TimelineDoc, label = 'Timeline edit'): void {
    const previous = this.doc ?? createTimeline();
    this.onHistory?.(previous, next, label);
    this.apply(next);
  }

  updateWith(mutate: (doc: TimelineDoc) => TimelineDoc, label?: string): void {
    if (!this.doc) return;
    this.update(mutate(this.doc), label);
  }

  /**
   * Replays an already recorded edit (undo/redo). Updates the document and
   * persists it, but never feeds the history callback again.
   */
  apply(next: TimelineDoc): void {
    this.doc = next;
    this.onChange();
    this.scheduleSave();
  }

  /** Remembers a probed asset so clips can be added without re-probing. */
  registerAsset(asset: MediaAsset): void {
    if (!this.doc) return;
    // Probing is bookkeeping rather than an edit: it must not add undo steps.
    this.apply({ ...this.doc, assets: { ...this.doc.assets, [asset.path]: asset } });
  }

  scheduleSave(): void {
    if (typeof window === 'undefined') return;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.save();
    }, SAVE_DELAY_MS);
  }

  async save(): Promise<void> {
    if (!this.doc) return;
    const text = serializeTimeline(this.doc);
    this.saving = this.saving
      .then(() => this.workspace.writeFile(TIMELINE_PATH, text))
      .catch(() => {
        // A failed save must not wedge the queue; the next edit retries.
      });
    await this.saving;
  }

  /** Flushes pending changes (used on pagehide). */
  async flush(): Promise<void> {
    if (typeof window !== 'undefined' && this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.save();
  }
}
