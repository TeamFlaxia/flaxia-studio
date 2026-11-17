/**
 * Right-hand inspector for the media editor.
 *
 * The inspector is the single control surface for non-destructive adjustments.
 * Every row pairs a slider with a numeric field so a value can be dialled in
 * roughly (drag) or exactly (type). Values are stored per source path in the
 * timeline document, exactly like the media preview used to do.
 */

import { el, formatBytes, iconButton } from '../lib/dom';
import { icon } from '../lib/icons';
import { DEFAULT_MEDIA_ADJUSTMENTS, type MediaAdjustments, type MediaKind, mediaKind } from '../lib/media';

export interface InspectorSource {
  path: string;
  kind?: MediaKind;
  size?: number;
  mime?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  adjustments?: Partial<MediaAdjustments>;
}

export interface InspectorOptions {
  /** Persists changed adjustments for a source path. */
  onAdjustmentsChange: (path: string, adjustments: MediaAdjustments) => void;
}

type AdjustableKey = 'brightness' | 'contrast' | 'saturation';
type Tab = 'adjust' | 'details';

const ADJUSTMENT_CONTROLS: Array<{ key: AdjustableKey; label: string }> = [
  { key: 'brightness', label: 'Brightness' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'saturation', label: 'Saturation' },
];

const MIN_VALUE = 0;
const MAX_VALUE = 200;

interface Control {
  range: HTMLInputElement;
  number: HTMLInputElement;
}

export class InspectorView {
  readonly host: HTMLElement;
  private readonly title: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly content: HTMLElement;
  private readonly tabsBar: HTMLElement;
  private readonly adjustPanel: HTMLElement;
  private readonly detailsPanel: HTMLElement;
  private readonly details: HTMLElement;
  private readonly rotateButton: HTMLButtonElement;
  private readonly flipButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly controls = new Map<AdjustableKey, Control>();

  private currentPath: string | null = null;
  private currentKind: MediaKind | null = null;
  private adjustments: MediaAdjustments = { ...DEFAULT_MEDIA_ADJUSTMENTS };
  private detailSource: InspectorSource | null = null;
  private tab: Tab = 'adjust';

  constructor(private readonly options: InspectorOptions) {
    this.title = el('span', { class: 'inspector-title', text: 'Inspector' });
    this.empty = el('div', { class: 'inspector-empty' }, [
      el('span', { class: 'inspector-empty-icon' }, [icon('monitor', 18)]),
      el('span', { class: 'inspector-empty-title', text: 'No selection' }),
      el('span', {
        class: 'inspector-empty-hint',
        text: 'Open media or select a timeline clip to edit its picture.',
      }),
    ]);

    this.adjustPanel = el('div', { class: 'inspector-panel' });
    this.detailsPanel = el('div', { class: 'inspector-panel hidden' });
    this.details = el('dl', { class: 'inspector-details' });
    this.detailsPanel.appendChild(this.details);

    this.tabsBar = el('div', { class: 'inspector-tabs', role: 'tablist' }, [
      this.tabButton('adjust', 'Adjust'),
      this.tabButton('details', 'Details'),
    ]);

    this.rotateButton = iconButton('rotate-cw', 'Rotate 90°', () => this.rotate(), { size: 14 });
    this.flipButton = iconButton('external', 'Flip horizontally', () => this.flip(), { size: 14 });
    this.resetButton = iconButton('refresh', 'Reset adjustments', () => this.reset(), { size: 14 });

    this.buildAdjustPanel();

    this.content = el('div', { class: 'inspector-content' }, [this.adjustPanel, this.detailsPanel]);
    this.host = el('aside', { class: 'inspector', attrs: { 'aria-label': 'Inspector' } }, [
      el('div', { class: 'inspector-head' }, [this.title]),
      this.tabsBar,
      el('div', { class: 'inspector-body' }, [this.empty, this.content]),
    ]);
    this.setTab('adjust');
    this.clear();
  }

  /** Path currently under the inspector, or null when nothing is selected. */
  get sourcePath(): string | null {
    return this.currentPath;
  }

  /** Shows a source and its stored adjustments. */
  showSource(source: InspectorSource): void {
    const kind = source.kind ?? mediaKind(source.path);
    if (!kind) {
      this.clear();
      return;
    }
    this.currentPath = source.path;
    this.currentKind = kind;
    this.detailSource = source;
    this.adjustments = { ...DEFAULT_MEDIA_ADJUSTMENTS, ...source.adjustments };
    this.title.textContent = source.path.split('/').pop() ?? source.path;
    this.title.title = source.path;
    this.empty.classList.add('hidden');
    this.content.classList.remove('hidden');
    this.tabsBar.classList.remove('hidden');
    this.syncControls();
    this.setEnabled(kind !== 'audio');
    this.renderDetails(source, kind);
  }

  /** Drops the current source and disables the controls. */
  clear(): void {
    this.currentPath = null;
    this.currentKind = null;
    this.detailSource = null;
    this.adjustments = { ...DEFAULT_MEDIA_ADJUSTMENTS };
    this.title.textContent = 'Inspector';
    this.title.title = '';
    this.empty.classList.remove('hidden');
    this.content.classList.add('hidden');
    this.tabsBar.classList.add('hidden');
    this.details.replaceChildren();
    this.syncControls();
    this.setEnabled(false);
  }

  /** Mirrors adjustments changed elsewhere (e.g. the media preview). */
  setAdjustments(path: string, adjustments: Partial<MediaAdjustments>): void {
    if (this.currentPath !== path) return;
    this.adjustments = { ...DEFAULT_MEDIA_ADJUSTMENTS, ...adjustments };
    this.syncControls();
  }

  /** Re-renders the details block after the asset metadata changes. */
  updateDetails(source: Partial<InspectorSource>): void {
    if (!this.currentPath || !this.currentKind) return;
    const merged: InspectorSource = {
      ...this.detailSource,
      ...source,
      path: this.currentPath,
      kind: this.currentKind,
    };
    this.detailSource = merged;
    this.renderDetails(merged, this.currentKind);
  }

  private buildAdjustPanel(): void {
    for (const control of ADJUSTMENT_CONTROLS) {
      const range = el('input', {
        class: 'inspector-range',
        type: 'range',
        attrs: {
          min: String(MIN_VALUE),
          max: String(MAX_VALUE),
          step: '1',
          value: '100',
          'aria-label': control.label,
        },
        on: {
          input: () => this.readControl(control.key, 'range'),
          pointerdown: (event) => {
            range.step = event.shiftKey ? '0.1' : '1';
          },
          pointermove: (event) => {
            const nextStep = event.shiftKey ? '0.1' : '1';
            if (range.step !== nextStep) range.step = nextStep;
          },
          dblclick: () => this.setValue(control.key, 100),
        },
      }) as HTMLInputElement;
      const number = el('input', {
        class: 'inspector-number',
        type: 'number',
        attrs: {
          min: String(MIN_VALUE),
          max: String(MAX_VALUE),
          step: '0.1',
          value: '100',
          'aria-label': `${control.label} value`,
        },
        on: {
          input: () => {
            if (number.value === '') return;
            const value = Number(number.value);
            if (Number.isFinite(value)) this.setValue(control.key, value);
          },
          dblclick: () => this.setValue(control.key, 100),
        },
      }) as HTMLInputElement;
      this.controls.set(control.key, { range, number });
      this.adjustPanel.appendChild(
        el('div', { class: 'inspector-row' }, [
          el('span', { class: 'inspector-row-label', text: control.label }),
          range,
          number,
        ]),
      );
    }

    this.adjustPanel.appendChild(
      el('div', { class: 'inspector-actions' }, [this.rotateButton, this.flipButton, this.resetButton]),
    );
  }

  private tabButton(tab: Tab, label: string): HTMLButtonElement {
    return el(
      'button',
      {
        class: 'inspector-tab',
        type: 'button',
        dataset: { inspectorTab: tab },
        attrs: { role: 'tab', 'aria-selected': String(this.tab === tab) },
        on: { click: () => this.setTab(tab) },
      },
      [label],
    ) as HTMLButtonElement;
  }

  private setTab(tab: Tab): void {
    this.tab = tab;
    for (const button of this.tabsBar.querySelectorAll<HTMLElement>('[data-inspector-tab]')) {
      button.setAttribute('aria-selected', String(button.dataset.inspectorTab === tab));
    }
    this.adjustPanel.classList.toggle('hidden', tab !== 'adjust');
    this.detailsPanel.classList.toggle('hidden', tab !== 'details');
  }

  private readControl(key: AdjustableKey, source: 'range' | 'number'): void {
    const control = this.controls.get(key);
    if (!control) return;
    const raw = source === 'range' ? control.range.value : control.number.value;
    if (raw === '') return;
    this.setValue(key, Number(raw));
  }

  private setValue(key: AdjustableKey, value: number): void {
    const next = clamp(value, MIN_VALUE, MAX_VALUE);
    this.adjustments = { ...this.adjustments, [key]: next };
    this.syncControl(key);
    this.emit();
  }

  private syncControls(): void {
    for (const key of this.controls.keys()) this.syncControl(key);
  }

  private syncControl(key: AdjustableKey): void {
    const control = this.controls.get(key);
    if (!control) return;
    const value = this.adjustments[key];
    control.range.value = String(value);
    control.number.value = formatValue(value);
  }

  private rotate(): void {
    const next = ((this.adjustments.rotate + 90) % 360) as MediaAdjustments['rotate'];
    this.adjustments = { ...this.adjustments, rotate: next };
    this.emit();
  }

  private flip(): void {
    this.adjustments = { ...this.adjustments, flip: !this.adjustments.flip };
    this.emit();
  }

  private reset(): void {
    this.adjustments = { ...DEFAULT_MEDIA_ADJUSTMENTS };
    this.syncControls();
    this.emit();
  }

  private emit(): void {
    if (!this.currentPath) return;
    this.options.onAdjustmentsChange(this.currentPath, { ...this.adjustments });
  }

  private setEnabled(enabled: boolean): void {
    this.rotateButton.disabled = !enabled;
    this.flipButton.disabled = !enabled;
    this.resetButton.disabled = !enabled;
    for (const control of this.controls.values()) {
      control.range.disabled = !enabled;
      control.number.disabled = !enabled;
    }
    this.adjustPanel.classList.toggle('is-disabled', !enabled);
  }

  private renderDetails(source: InspectorSource, kind: MediaKind): void {
    const rows: Array<[string, string]> = [
      ['File', source.path.split('/').pop() ?? source.path],
      ['Path', source.path],
      ['Type', kind],
    ];
    if (source.size !== undefined) rows.push(['Size', formatBytes(source.size)]);
    if (source.mime) rows.push(['MIME', source.mime]);
    if (source.width && source.height) rows.push(['Dimensions', `${source.width}×${source.height}`]);
    if (source.durationMs && source.durationMs > 0) {
      rows.push(['Duration', formatClock(source.durationMs)]);
    }
    this.details.replaceChildren(
      ...rows.flatMap(([label, value]) => [el('dt', { text: label }), el('dd', { text: value })]),
    );
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
