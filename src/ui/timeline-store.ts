/**
 * Timeline persistence.
 *
 * The document lives in the workspace as `.flaxia/timeline.json`, so it is
 * exported with the ZIP, and it is invisible to Test Play and the Linux guest
 * (both skip dotfiles / `.flaxia`). Saves are debounced like the editor's.
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

export class TimelineStore {
  private doc: TimelineDoc | null = null;
  private timer: number | undefined;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly workspace: Workspace,
    private readonly onChange: () => void,
  ) {}

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

  update(next: TimelineDoc): void {
    this.doc = next;
    this.onChange();
    this.scheduleSave();
  }

  updateWith(mutate: (doc: TimelineDoc) => TimelineDoc): void {
    if (!this.doc) return;
    this.update(mutate(this.doc));
  }

  /** Remembers a probed asset so clips can be added without re-probing. */
  registerAsset(asset: MediaAsset): void {
    this.updateWith((doc) => ({ ...doc, assets: { ...doc.assets, [asset.path]: asset } }));
  }

  scheduleSave(): void {
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
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.save();
  }
}
