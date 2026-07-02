import {
  Accidental as VexAccidental,
  Beam,
  Dot,
  Formatter,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  Voice,
} from 'vexflow';
import type { Clef, Measure, NoteEvent, NoteLocation, Score } from '../types/score';
import { measureCapacityBeats, pitchToVexKey, vexDurationString } from './scoreUtils';

const FIRST_MEASURE_WIDTH = 300;
const MEASURE_WIDTH = 220;
const TREBLE_Y = 40;
const BASS_Y = 160;
const STAVE_SELECT_MARGIN = 50;
const NOTE_HIT_RADIUS = 16;

export interface NoteHitbox {
  measureIndex: number;
  clef: Clef;
  noteIndex: number;
  centerX: number;
}

export interface StaffHitbox {
  measureIndex: number;
  clef: Clef;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  refY0: number;
  spacing: number;
}

export interface RenderResult {
  noteHitboxes: NoteHitbox[];
  staffHitboxes: StaffHitbox[];
  width: number;
  height: number;
}

const REST_KEY: Record<Clef, string> = {
  treble: 'b/4',
  bass: 'd/3',
};

function buildStaveNotes(
  clef: Clef,
  measureIndex: number,
  notes: NoteEvent[],
  selected: NoteLocation | null,
): StaveNote[] {
  return notes.map((note, noteIndex) => {
    const keys = note.isRest ? [REST_KEY[clef]] : note.pitches.map(pitchToVexKey);
    const staveNote = new StaveNote({
      clef,
      keys,
      duration: vexDurationString(note),
    });

    if (note.dotted) {
      Dot.buildAndAttach([staveNote], note.isRest ? { index: 0 } : { all: true });
    }

    if (!note.isRest) {
      note.pitches.forEach((pitch, i) => {
        if (pitch.accidental) {
          staveNote.addModifier(new VexAccidental(pitch.accidental), i);
        }
      });
    }

    const isSelected =
      selected &&
      selected.measureIndex === measureIndex &&
      selected.clef === clef &&
      selected.noteIndex === noteIndex;
    if (isSelected) {
      staveNote.setStyle({ fillStyle: '#d6432b', strokeStyle: '#d6432b' });
    }

    return staveNote;
  });
}

export function renderScore(
  container: HTMLDivElement,
  score: Score,
  selected: NoteLocation | null,
): RenderResult {
  container.innerHTML = '';

  const width =
    FIRST_MEASURE_WIDTH + Math.max(0, score.measures.length - 1) * MEASURE_WIDTH + 20;
  const height = 300;

  const renderer = new Renderer(container, Renderer.Backends.SVG);
  renderer.resize(width, height);
  const context = renderer.getContext();

  const noteHitboxes: NoteHitbox[] = [];
  const staffHitboxes: StaffHitbox[] = [];

  let x = 10;
  score.measures.forEach((measure: Measure, measureIndex: number) => {
    const isFirst = measureIndex === 0;
    const measureWidth = isFirst ? FIRST_MEASURE_WIDTH : MEASURE_WIDTH;

    const trebleStave = new Stave(x, TREBLE_Y, measureWidth);
    const bassStave = new Stave(x, BASS_Y, measureWidth);

    if (isFirst) {
      trebleStave.addClef('treble');
      trebleStave.addTimeSignature(`${score.timeSignature.numerator}/${score.timeSignature.denominator}`);
      trebleStave.addKeySignature(score.keySignature);
      bassStave.addClef('bass');
      bassStave.addTimeSignature(`${score.timeSignature.numerator}/${score.timeSignature.denominator}`);
      bassStave.addKeySignature(score.keySignature);
    }

    trebleStave.setContext(context).draw();
    bassStave.setContext(context).draw();

    if (isFirst) {
      new StaveConnector(trebleStave, bassStave).setType('brace').setContext(context).draw();
      new StaveConnector(trebleStave, bassStave).setType('singleLeft').setContext(context).draw();
    }
    if (measureIndex === score.measures.length - 1) {
      new StaveConnector(trebleStave, bassStave).setType('boldDoubleRight').setContext(context).draw();
    } else {
      new StaveConnector(trebleStave, bassStave).setType('singleRight').setContext(context).draw();
    }

    const capacity = measureCapacityBeats(score.timeSignature);

    ([
      ['treble', trebleStave, measure.treble.notes],
      ['bass', bassStave, measure.bass.notes],
    ] as const).forEach(([clef, stave, notes]) => {
      const staveNotes = buildStaveNotes(clef, measureIndex, notes, selected);

      if (staveNotes.length > 0) {
        const voice = new Voice({ numBeats: capacity, beatValue: 4 }).setStrict(false);
        voice.addTickables(staveNotes);
        new Formatter().joinVoices([voice]).format([voice], measureWidth - (isFirst ? 100 : 20));
        voice.draw(context, stave);

        try {
          const beamable = staveNotes.filter((n) => !n.isRest());
          const beams = Beam.generateBeams(beamable);
          beams.forEach((b) => b.setContext(context).draw());
        } catch {
          // Beaming is a visual nicety; ignore failures on unusual note groupings.
        }

        staveNotes.forEach((sn, noteIndex) => {
          noteHitboxes.push({
            measureIndex,
            clef,
            noteIndex,
            centerX: sn.getAbsoluteX(),
          });
        });
      }

      const refY0 = stave.getYForNote(0);
      const spacing = refY0 - stave.getYForNote(1);
      staffHitboxes.push({
        measureIndex,
        clef,
        x0: x,
        x1: x + measureWidth,
        y0: stave.getYForLine(0) - STAVE_SELECT_MARGIN,
        y1: stave.getYForLine(4) + STAVE_SELECT_MARGIN,
        refY0,
        spacing,
      });
    });

    x += measureWidth;
  });

  return { noteHitboxes, staffHitboxes, width, height };
}

export interface ClickResultSelect {
  type: 'select';
  measureIndex: number;
  clef: Clef;
  noteIndex: number;
}

export interface ClickResultAdd {
  type: 'add';
  measureIndex: number;
  clef: Clef;
  line: number;
}

export type ClickResult = ClickResultSelect | ClickResultAdd | null;

export function resolveClick(result: RenderResult, x: number, y: number): ClickResult {
  const staff = result.staffHitboxes.find(
    (s) => x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1,
  );
  if (!staff) return null;

  const hitNote = result.noteHitboxes.find(
    (n) =>
      n.measureIndex === staff.measureIndex &&
      n.clef === staff.clef &&
      Math.abs(n.centerX - x) < NOTE_HIT_RADIUS,
  );
  if (hitNote) {
    return { type: 'select', measureIndex: hitNote.measureIndex, clef: hitNote.clef, noteIndex: hitNote.noteIndex };
  }

  const line = (staff.refY0 - y) / staff.spacing;
  return { type: 'add', measureIndex: staff.measureIndex, clef: staff.clef, line };
}
