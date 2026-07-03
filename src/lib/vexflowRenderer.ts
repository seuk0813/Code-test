import {
  Accidental as VexAccidental,
  Beam,
  Curve,
  Dot,
  Formatter,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  StaveTie,
  Voice,
} from 'vexflow';
import type { ChordSymbol, Clef, NoteEvent, NoteLocation, Score } from '../types/score';
import {
  chordLabel,
  computeRows,
  isStaffMeasureFull,
  measureCapacityBeats,
  pitchToLine,
  pitchToVexKey,
  vexDurationString,
} from './scoreUtils';

/** Right-hand padding kept clear of notes inside a measure, for free-X mapping. */
const NOTE_AREA_RIGHT_PAD = 16;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

const FIRST_MEASURE_WIDTH = 300;
const MEASURE_WIDTH = 220;
const ROW_HEIGHT = 320;
const CHORD_BAND_Y = 78;
const TREBLE_Y = 60;
const BASS_Y = 185;
const STAVE_TOP_MARGIN = 40;
const NOTE_HIT_RADIUS = 16;
export const MEASURES_PER_ROW = 4;
const LINE_BREAK_MARKER_WIDTH = 24;

export interface NoteHitbox {
  measureIndex: number;
  clef: Clef;
  noteIndex: number;
  centerX: number;
  /** Y of each notehead (a chord has several), for pitch-aware click hit-testing. */
  ys: number[];
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
  /** Usable note area (excludes clef/key/time signature glyphs), for grid-snapped previews. */
  contentX0: number;
  contentWidth: number;
  /** Left edge where notes begin (after clef/key/time glyphs). */
  noteStartX: number;
  /** Width of the free-placement note area (noteStartX .. right padding). */
  noteAreaWidth: number;
  /** True when the measure is filled to capacity and auto-formatted. */
  full: boolean;
}

export interface ChordHitbox {
  measureIndex: number;
  chordId: string;
  x: number;
  y: number;
  halfWidth: number;
}

export interface ChordBandHitbox {
  measureIndex: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  measureX: number;
  measureWidth: number;
}

export interface LineBreakHitbox {
  /** Registering a break happens after this measure index. */
  afterMeasureIndex: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface RenderResult {
  noteHitboxes: NoteHitbox[];
  staffHitboxes: StaffHitbox[];
  chordHitboxes: ChordHitbox[];
  chordBandHitboxes: ChordBandHitbox[];
  lineBreakHitboxes: LineBreakHitbox[];
  width: number;
  height: number;
}

const REST_KEY: Record<Clef, string> = {
  treble: 'b/4',
  bass: 'd/3',
};

function pitchesMatch(a: NoteEvent, b: NoteEvent): boolean {
  if (a.pitches.length !== b.pitches.length) return false;
  const aKeys = a.pitches.map(pitchToVexKey).sort();
  const bKeys = b.pitches.map(pitchToVexKey).sort();
  return aKeys.every((k, i) => k === bKeys[i]);
}

function buildStaveNotes(
  clef: Clef,
  measureIndex: number,
  notes: NoteEvent[],
  selected: NoteLocation | null,
  hiddenNoteIndex: number | null,
): StaveNote[] {
  return notes.map((note, noteIndex) => {
    const keys = note.isRest ? [REST_KEY[clef]] : note.pitches.map(pitchToVexKey);
    const staveNote = new StaveNote({
      clef,
      keys,
      duration: vexDurationString(note),
      autoStem: true,
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
    if (hiddenNoteIndex === noteIndex) {
      staveNote.setStyle({ fillStyle: 'transparent', strokeStyle: 'transparent' });
    }

    return staveNote;
  });
}

export interface DraggingNote {
  measureIndex: number;
  clef: Clef;
  noteIndex: number;
}

export function renderScore(
  container: HTMLDivElement,
  score: Score,
  selected: NoteLocation | null,
  draggingNote: DraggingNote | null,
): RenderResult {
  container.innerHTML = '';

  const rows = computeRows(score.measures.length, score.lineBreaks);

  const rowWidths = rows.map((row) =>
    row.reduce((sum, _, localIndex) => sum + (localIndex === 0 ? FIRST_MEASURE_WIDTH : MEASURE_WIDTH), 20),
  );
  const width = Math.max(...rowWidths, FIRST_MEASURE_WIDTH + 20);
  const height = rows.length * ROW_HEIGHT;

  const renderer = new Renderer(container, Renderer.Backends.SVG);
  renderer.resize(width, height);
  const context = renderer.getContext();

  const noteHitboxes: NoteHitbox[] = [];
  const staffHitboxes: StaffHitbox[] = [];
  const chordHitboxes: ChordHitbox[] = [];
  const chordBandHitboxes: ChordBandHitbox[] = [];
  const lineBreakHitboxes: LineBreakHitbox[] = [];

  const capacity = measureCapacityBeats(score.timeSignature);

  // Flat, in-order chain of every rendered note per staff (spanning measures
  // and rows), used after the layout pass to connect ties/slurs between
  // consecutive notes — including across a barline or a line break.
  const noteChain: Record<Clef, { event: NoteEvent; staveNote: StaveNote }[]> = { treble: [], bass: [] };

  rows.forEach((row, rowIndex) => {
    const rowY = rowIndex * ROW_HEIGHT;
    const chordY = rowY + CHORD_BAND_Y;
    const trebleY = rowY + TREBLE_Y;
    const bassY = rowY + BASS_Y;

    let x = 10;
    row.forEach((measureIndex, localIndex) => {
      const measure = score.measures[measureIndex];
      const isRowStart = localIndex === 0;
      const isPieceStart = measureIndex === 0;
      const isLastMeasure = measureIndex === score.measures.length - 1;
      const measureWidth = isRowStart ? FIRST_MEASURE_WIDTH : MEASURE_WIDTH;

      const trebleStave = new Stave(x, trebleY, measureWidth);
      const bassStave = new Stave(x, bassY, measureWidth);

      if (isRowStart) {
        trebleStave.addClef('treble');
        bassStave.addClef('bass');
        if (score.keySignature !== 'C') {
          trebleStave.addKeySignature(score.keySignature);
          bassStave.addKeySignature(score.keySignature);
        }
      }
      if (isPieceStart) {
        trebleStave.addTimeSignature(`${score.timeSignature.numerator}/${score.timeSignature.denominator}`);
        bassStave.addTimeSignature(`${score.timeSignature.numerator}/${score.timeSignature.denominator}`);
      }

      trebleStave.setContext(context).draw();
      bassStave.setContext(context).draw();

      if (isRowStart) {
        new StaveConnector(trebleStave, bassStave).setType('brace').setContext(context).draw();
        new StaveConnector(trebleStave, bassStave).setType('singleLeft').setContext(context).draw();
      }
      if (isLastMeasure) {
        new StaveConnector(trebleStave, bassStave).setType('boldDoubleRight').setContext(context).draw();
      } else {
        new StaveConnector(trebleStave, bassStave).setType('singleRight').setContext(context).draw();
      }

      const midY = (trebleStave.getYForLine(4) + bassStave.getYForLine(0)) / 2;

      ([
        ['treble', trebleStave, measure.treble.notes, trebleStave.getYForLine(0) - STAVE_TOP_MARGIN, midY],
        ['bass', bassStave, measure.bass.notes, midY, bassStave.getYForLine(4) + STAVE_TOP_MARGIN],
      ] as const).forEach(([clef, stave, notes, y0, y1]) => {
        const hiddenNoteIndex =
          draggingNote && draggingNote.measureIndex === measureIndex && draggingNote.clef === clef
            ? draggingNote.noteIndex
            : null;
        const staveNotes = buildStaveNotes(clef, measureIndex, notes, selected, hiddenNoteIndex);

        const refY0 = stave.getYForNote(0);
        const spacing = refY0 - stave.getYForNote(1);
        const noteStartX = stave.getNoteStartX();
        const noteAreaWidth = Math.max(40, stave.getX() + stave.getWidth() - NOTE_AREA_RIGHT_PAD - noteStartX);
        // Once a measure is full it auto-formats (free X positions ignored) so
        // the score tidies itself; until then notes sit where they were placed.
        const full = isStaffMeasureFull({ notes }, score.timeSignature);

        if (staveNotes.length > 0) {
          const voice = new Voice({ numBeats: capacity, beatValue: 4 }).setStrict(false);
          voice.addTickables(staveNotes);

          // Beams must be built before the notes are drawn: creating a Beam
          // marks its notes so they skip drawing their own individual flag.
          // Doing this after voice.draw() left both the flag and the beam
          // rendered on top of each other. Only beam auto-formatted (full)
          // measures; free-placed notes would produce misshapen beams.
          let beams: Beam[] = [];
          if (full) {
            try {
              const beamable = staveNotes.filter((n) => !n.isRest());
              beams = Beam.generateBeams(beamable);
            } catch {
              // Beaming is a visual nicety; ignore failures on unusual groupings.
            }
          }

          new Formatter().joinVoices([voice]).format([voice], measureWidth - (isRowStart ? 100 : 20));

          // getAbsoluteX() is only meaningful once each note knows its stave
          // (Voice.draw sets this internally, but we need the formatted X now to
          // compute free-X shifts before drawing).
          staveNotes.forEach((sn) => sn.setStave(stave));

          // Free-X placement: shift each positioned note from its formatted spot
          // to the requested fraction of the note area.
          const centerXs: number[] = staveNotes.map((sn) => sn.getAbsoluteX());
          if (!full) {
            staveNotes.forEach((sn, i) => {
              const fx = notes[i].x;
              if (fx === undefined) return;
              const desiredX = noteStartX + clamp01(fx) * noteAreaWidth;
              sn.setXShift(desiredX - sn.getAbsoluteX());
              centerXs[i] = desiredX;
            });
          }

          voice.draw(context, stave);
          beams.forEach((b) => b.setContext(context).draw());

          staveNotes.forEach((sn, noteIndex) => {
            const note = notes[noteIndex];
            const ys = note.isRest
              ? [refY0 - 3 * spacing]
              : note.pitches.map((p) => refY0 - pitchToLine(clef, p.letter, p.octave) * spacing);
            noteHitboxes.push({
              measureIndex,
              clef,
              noteIndex,
              centerX: centerXs[noteIndex],
              ys,
            });
            noteChain[clef].push({ event: note, staveNote: sn });
          });
        }

        const contentStartOffset = isRowStart ? 100 : 20;
        staffHitboxes.push({
          measureIndex,
          clef,
          x0: x,
          x1: x + measureWidth,
          y0,
          y1,
          refY0,
          spacing,
          contentX0: x + contentStartOffset,
          contentWidth: measureWidth - contentStartOffset,
          noteStartX,
          noteAreaWidth,
          full,
        });
      });

      // Chord symbol band above the treble stave.
      measure.chords.forEach((chord: ChordSymbol) => {
        const cx = x + chord.offset * measureWidth;
        chordHitboxes.push({ measureIndex, chordId: chord.id, x: cx, y: chordY, halfWidth: 20 });
      });
      chordBandHitboxes.push({
        measureIndex,
        x0: x,
        x1: x + measureWidth,
        y0: chordY - 14,
        y1: chordY + 8,
        measureX: x,
        measureWidth,
      });

      // Clickable "next line" marker after every 4th measure of a row.
      if (localIndex === MEASURES_PER_ROW - 1 && !score.lineBreaks.includes(measureIndex) && !isLastMeasure) {
        lineBreakHitboxes.push({
          afterMeasureIndex: measureIndex,
          x0: x + measureWidth + 2,
          x1: x + measureWidth + 2 + LINE_BREAK_MARKER_WIDTH,
          y0: trebleY - 10,
          y1: bassY + 50,
        });
      }

      x += measureWidth;
    });
  });

  (['treble', 'bass'] as const).forEach((clef) => {
    const chain = noteChain[clef];
    for (let i = 0; i < chain.length - 1; i++) {
      const cur = chain[i];
      const next = chain[i + 1];
      if (cur.event.isRest || next.event.isRest) continue;
      if (cur.event.tieToNext && pitchesMatch(cur.event, next.event)) {
        try {
          new StaveTie({ firstNote: cur.staveNote, lastNote: next.staveNote }).setContext(context).draw();
        } catch {
          // Skip ties VexFlow can't render (e.g. mismatched key counts).
        }
      } else if (cur.event.slurToNext) {
        try {
          new Curve(cur.staveNote, next.staveNote, {}).setContext(context).draw();
        } catch {
          // Skip slurs VexFlow can't render.
        }
      }
    }
  });

  const svg = container.querySelector('svg');
  if (svg) {
    drawChordLabels(svg, score, chordHitboxes);
    drawLineBreakMarkers(svg, lineBreakHitboxes);
  }

  return { noteHitboxes, staffHitboxes, chordHitboxes, chordBandHitboxes, lineBreakHitboxes, width, height };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function drawChordLabels(svg: SVGSVGElement, score: Score, chordHitboxes: ChordHitbox[]): void {
  chordHitboxes.forEach((hb) => {
    const measure = score.measures[hb.measureIndex];
    const chord = measure.chords.find((c) => c.id === hb.chordId);
    if (!chord) return;
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(hb.x));
    text.setAttribute('y', String(hb.y));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '15');
    text.setAttribute('font-weight', '700');
    text.setAttribute('fill', '#2f3a8f');
    text.textContent = chordLabel(chord);
    svg.appendChild(text);
  });
}

function drawLineBreakMarkers(svg: SVGSVGElement, markers: LineBreakHitbox[]): void {
  markers.forEach((m) => {
    const midY = (m.y0 + m.y1) / 2;
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(m.x0));
    rect.setAttribute('y', String(midY - 12));
    rect.setAttribute('width', String(m.x1 - m.x0));
    rect.setAttribute('height', '24');
    rect.setAttribute('rx', '4');
    rect.setAttribute('fill', '#efeaff');
    rect.setAttribute('stroke', '#aa3bff');
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String((m.x0 + m.x1) / 2));
    text.setAttribute('y', String(midY + 5));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '13');
    text.setAttribute('fill', '#aa3bff');
    text.textContent = '↵';
    svg.appendChild(rect);
    svg.appendChild(text);
  });
}

// --- Click / hover resolution -------------------------------------------------

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

export function findStaffAt(result: RenderResult, x: number, y: number): StaffHitbox | null {
  return result.staffHitboxes.find((s) => x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1) ?? null;
}

export function resolveClick(result: RenderResult, x: number, y: number): ClickResult {
  const staff = findStaffAt(result, x, y);
  if (!staff) return null;

  // A note is "hit" only near one of its noteheads (pitch-aware), so that
  // clicking clearly above or below a note falls through to an add preview.
  const yRadius = staff.spacing * 0.45;
  const hitNote = result.noteHitboxes.find(
    (n) =>
      n.measureIndex === staff.measureIndex &&
      n.clef === staff.clef &&
      Math.abs(n.centerX - x) < NOTE_HIT_RADIUS &&
      n.ys.some((ny) => Math.abs(ny - y) < yRadius),
  );
  if (hitNote) {
    return { type: 'select', measureIndex: hitNote.measureIndex, clef: hitNote.clef, noteIndex: hitNote.noteIndex };
  }

  const line = (staff.refY0 - y) / staff.spacing;
  return { type: 'add', measureIndex: staff.measureIndex, clef: staff.clef, line };
}

export function lineAt(staff: StaffHitbox, y: number): number {
  return (staff.refY0 - y) / staff.spacing;
}

/** Fractional (0..1) horizontal position of an X within a staff's free-placement note area. */
export function xFractionAt(staff: StaffHitbox, x: number): number {
  return Math.min(1, Math.max(0, (x - staff.noteStartX) / staff.noteAreaWidth));
}

/** Where a new note should be spliced into the staff's note list for a given click X. */
export function findInsertIndex(result: RenderResult, measureIndex: number, clef: Clef, x: number): number {
  const notes = result.noteHitboxes
    .filter((n) => n.measureIndex === measureIndex && n.clef === clef)
    .sort((a, b) => a.noteIndex - b.noteIndex);
  const next = notes.find((n) => x < n.centerX);
  return next ? next.noteIndex : notes.length;
}

export function findChordAt(result: RenderResult, x: number, y: number): ChordHitbox | null {
  return (
    result.chordHitboxes.find(
      (c) => Math.abs(c.x - x) < c.halfWidth && Math.abs(c.y - y) < 14,
    ) ?? null
  );
}

export function findChordBandAt(result: RenderResult, x: number, y: number): ChordBandHitbox | null {
  return result.chordBandHitboxes.find((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) ?? null;
}

export function findLineBreakAt(result: RenderResult, x: number, y: number): LineBreakHitbox | null {
  return result.lineBreakHitboxes.find((m) => x >= m.x0 && x <= m.x1 && y >= m.y0 && y <= m.y1) ?? null;
}
