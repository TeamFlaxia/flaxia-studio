/**
 * Music workspace: tempo, scale and an expanded note-track editor.
 *
 * The piano roll is a magnified view of a note track. Notes live in a separate
 * `.flaxia/music.json` document so the video timeline stays untouched.
 */

import { t } from '../i18n/index.ts';
import { el } from '../lib/dom';
import { icon } from '../lib/icons';
import { type NoteClip, SCALES, type ScaleName } from '../lib/music';
import type { Tempo } from '../lib/timeline';
import { PianoRollView } from './piano-roll';

export interface MusicPanelOptions {
  onTempoChange: (tempo: Tempo) => void;
  onClipChange: (clip: NoteClip) => void;
}

export class MusicPanel {
  readonly host: HTMLElement;
  private readonly piano: PianoRollView;
  private readonly bpmInput: HTMLInputElement;
  private readonly scaleSelect: HTMLSelectElement;
  private readonly noteCount: HTMLElement;
  private clip: NoteClip;

  constructor(options: MusicPanelOptions) {
    this.clip = { id: 'note-1', notes: [] };
    this.piano = new PianoRollView({
      onNoteChange: (clip) => {
        this.clip = clip;
        this.noteCount.textContent = String(clip.notes.length);
        options.onClipChange(clip);
      },
    });

    this.bpmInput = el('input', {
      class: 'input',
      type: 'number',
      attrs: { 'aria-label': t('play.bpm'), min: '40', max: '240', step: '1' },
      on: {
        change: () => {
          const bpm = Number(this.bpmInput.value);
          if (!Number.isFinite(bpm)) return;
          options.onTempoChange({
            bpm: Math.min(240, Math.max(40, Math.round(bpm))),
            numerator: 4,
            denominator: 4,
          });
        },
      },
    }) as HTMLInputElement;
    this.bpmInput.value = '120';

    this.scaleSelect = el('select', {
      class: 'input',
      attrs: { 'aria-label': t('play.scale') },
      on: {
        change: () => {
          this.host.dataset.scale = this.scaleSelect.value;
        },
      },
    }) as HTMLSelectElement;
    for (const name of Object.keys(SCALES) as ScaleName[]) {
      this.scaleSelect.appendChild(el('option', { attrs: { value: name }, text: name }));
    }
    this.scaleSelect.value = 'minorPentatonic';

    this.noteCount = el('span', { class: 'mono', text: '0' });

    const head = el('div', { class: 'piano-roll-head' }, [
      el('span', { class: 'piano-roll-title', text: t('play.noteTrack') }),
      el('label', { class: 'music-field' }, [t('play.bpm'), this.bpmInput]),
      el('label', { class: 'music-field' }, [t('play.scale'), this.scaleSelect]),
      el('span', { class: 'music-field' }, [`${t('template.apply')}:`, this.noteCount]),
      el('span', { class: 'tab-spacer' }),
      icon('file-audio', 14),
    ]);

    this.host = el('div', { class: 'music-panel', attrs: { 'aria-label': 'Music editor' } }, [
      head,
      this.piano.host,
    ]);
  }

  getClip(): NoteClip {
    return this.clip;
  }

  setClip(clip: NoteClip): void {
    this.clip = clip;
    this.noteCount.textContent = String(clip.notes.length);
    this.piano.setClip(clip);
  }

  setTempo(tempo: Tempo): void {
    this.bpmInput.value = String(tempo.bpm);
  }

  setPlayheadTick(tick: number): void {
    this.piano.setPlayheadTick(tick);
  }

  get scale(): ScaleName {
    return this.scaleSelect.value as ScaleName;
  }

  dispose(): void {
    this.piano.dispose();
  }
}
