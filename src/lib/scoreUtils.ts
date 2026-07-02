import type {
  Accidental,
  ChordQuality,
  ChordSymbol,
  Clef,
  DurationValue,
  Measure,
  NoteEvent,
  NoteLocation,
  Pitch,
  Score,
  StaffMeasure,
  TimeSignature,
} from '../types/score';

let idCounter = 0;
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

export const DURATION_BEATS: Record<DurationValue, number> = {
  w: 4,
  h: 2,
  q: 1,
  '8': 0.5,
  '16': 0.25,
};

export const DURATION_LABELS: Record<DurationValue, string> = {
  w: '온음표',
  h: '2분음표',
  q: '4분음표',
  '8': '8분음표',
  '16': '16분음표',
};

export function noteBeats(note: Pick<NoteEvent, 'duration' | 'dotted'>): number {
  const base = DURATION_BEATS[note.duration];
  return note.dotted ? base * 1.5 : base;
}

export function measureCapacityBeats(timeSignature: TimeSignature): number {
  return timeSignature.numerator * (4 / timeSignature.denominator);
}

export function staffMeasureBeats(staffMeasure: StaffMeasure): number {
  return staffMeasure.notes.reduce((sum, n) => sum + noteBeats(n), 0);
}

function emptyStaffMeasure(): StaffMeasure {
  return { notes: [] };
}

export function createEmptyMeasure(): Measure {
  return {
    id: nextId('m'),
    treble: emptyStaffMeasure(),
    bass: emptyStaffMeasure(),
    chords: [],
  };
}

export function createEmptyScore(): Score {
  return {
    title: '제목 없는 악보',
    composer: '',
    tempo: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    keySignature: 'C',
    measures: [createEmptyMeasure()],
    lineBreaks: [],
  };
}

export function createNote(
  pitches: Pitch[],
  duration: DurationValue,
  dotted: boolean,
  isRest: boolean,
): NoteEvent {
  return {
    id: nextId('n'),
    pitches: isRest ? [] : pitches,
    duration,
    dotted,
    isRest,
  };
}

// --- Pitch <-> VexFlow key helpers -----------------------------------------

export function pitchToVexKey(pitch: Pitch): string {
  return `${pitch.letter.toLowerCase()}${pitch.accidental}/${pitch.octave}`;
}

const LETTERS: Pitch['letter'][] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

/** Reference note sitting exactly on stave line 0 (the bottom line) for each clef. */
const CLEF_LINE0_REFERENCE: Record<Clef, { letter: Pitch['letter']; octave: number }> = {
  treble: { letter: 'E', octave: 4 },
  bass: { letter: 'G', octave: 2 },
};

/**
 * Convert a fractional VexFlow stave "line" position (0 = bottom line, 0.5 per
 * diatonic step) into a natural pitch. Used to map a mouse click's Y position
 * to a pitch on the staff.
 */
export function lineToPitch(clef: Clef, line: number): { letter: Pitch['letter']; octave: number } {
  const ref = CLEF_LINE0_REFERENCE[clef];
  const steps = Math.round(line * 2);
  const refIndex = LETTERS.indexOf(ref.letter);
  let idx = refIndex + steps;
  const octave = ref.octave + Math.floor(idx / 7);
  idx = ((idx % 7) + 7) % 7;
  return { letter: LETTERS[idx], octave };
}

/**
 * Inverse of lineToPitch: the fractional stave line a pitch sits on for a clef.
 * Used to size ledger lines and stem direction for the hover/drag preview.
 */
export function pitchToLine(clef: Clef, letter: Pitch['letter'], octave: number): number {
  const ref = CLEF_LINE0_REFERENCE[clef];
  const refIndex = LETTERS.indexOf(ref.letter);
  const letterIndex = LETTERS.indexOf(letter);
  const steps = (octave - ref.octave) * 7 + (letterIndex - refIndex);
  return steps / 2;
}

/**
 * VexFlow's own autoStem rule (see calculateOptimalStemDirection): a note
 * whose stave line is below 3 (the space just above the middle line) points
 * up; line 3 and above points down. Exposed so the UI can explain the exact
 * pitch where the stem flips.
 */
export function stemPointsUp(line: number): boolean {
  return line < 3;
}

/** MIDI note number for a pitch, used for audio playback. */
export function pitchToMidi(pitch: Pitch): number {
  const semitonesFromC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[pitch.letter];
  const accidentalShift = pitch.accidental === '#' ? 1 : pitch.accidental === 'b' ? -1 : 0;
  return (pitch.octave + 1) * 12 + semitonesFromC + accidentalShift;
}

export function pitchToToneNote(pitch: Pitch): string {
  const acc = pitch.accidental === '#' ? '#' : pitch.accidental === 'b' ? 'b' : '';
  return `${pitch.letter}${acc}${pitch.octave}`;
}

export function accidentalCycle(current: Accidental): Accidental {
  const order: Accidental[] = ['', '#', 'b', 'n'];
  return order[(order.indexOf(current) + 1) % order.length];
}

export function vexDurationString(note: Pick<NoteEvent, 'duration' | 'dotted' | 'isRest'>): string {
  return `${note.duration}${note.dotted ? 'd' : ''}${note.isRest ? 'r' : ''}`;
}

// --- Chord symbols -----------------------------------------------------------

export const MAX_CHORDS_PER_MEASURE = 4;

export const CHORD_QUALITY_LABELS: Record<ChordQuality, string> = {
  maj: '메이저',
  min: '마이너',
  '7': '7th',
  maj7: 'Major 7th',
  min7: 'Minor 7th',
  dim: 'Diminished',
  aug: 'Augmented',
  sus2: 'Sus2',
  sus4: 'Sus4',
  m7b5: 'Half-diminished',
  dim7: 'Diminished 7th',
};

const CHORD_QUALITY_SUFFIX: Record<ChordQuality, string> = {
  maj: '',
  min: 'm',
  '7': '7',
  maj7: 'maj7',
  min7: 'm7',
  dim: 'dim',
  aug: 'aug',
  sus2: 'sus2',
  sus4: 'sus4',
  m7b5: 'm7♭5',
  dim7: 'dim7',
};

const ACCIDENTAL_SYMBOL: Record<Accidental, string> = {
  '#': '♯',
  b: '♭',
  n: '',
  '': '',
};

export function chordLabel(chord: Pick<ChordSymbol, 'root' | 'accidental' | 'quality'>): string {
  return `${chord.root}${ACCIDENTAL_SYMBOL[chord.accidental]}${CHORD_QUALITY_SUFFIX[chord.quality]}`;
}

const DEFAULT_CHORD_SLOTS = [0.125, 0.375, 0.625, 0.875];

export interface AddChordResult {
  score: Score;
  overflow: boolean;
}

export function addChordToScore(
  score: Score,
  measureIndex: number,
  root: Pitch['letter'],
  accidental: Accidental,
  quality: ChordQuality,
): AddChordResult {
  const chords = score.measures[measureIndex].chords;
  if (chords.length >= MAX_CHORDS_PER_MEASURE) {
    return { score, overflow: true };
  }
  const chord: ChordSymbol = {
    id: nextId('c'),
    root,
    accidental,
    quality,
    offset: DEFAULT_CHORD_SLOTS[chords.length],
  };
  const measures = score.measures.map((m, i) => (i === measureIndex ? { ...m, chords: [...m.chords, chord] } : m));
  return { score: { ...score, measures }, overflow: false };
}

export function moveChordInScore(score: Score, measureIndex: number, chordId: string, offset: number): Score {
  const clamped = Math.min(0.95, Math.max(0.05, offset));
  const measures = score.measures.map((m, i) =>
    i === measureIndex
      ? { ...m, chords: m.chords.map((c) => (c.id === chordId ? { ...c, offset: clamped } : c)) }
      : m,
  );
  return { ...score, measures };
}

export function removeChordFromScore(score: Score, measureIndex: number, chordId: string): Score {
  const measures = score.measures.map((m, i) =>
    i === measureIndex ? { ...m, chords: m.chords.filter((c) => c.id !== chordId) } : m,
  );
  return { ...score, measures };
}

// --- Line breaks (systems / rows) -------------------------------------------

export function addLineBreak(score: Score, afterMeasureIndex: number): Score {
  if (score.lineBreaks.includes(afterMeasureIndex)) return score;
  return { ...score, lineBreaks: [...score.lineBreaks, afterMeasureIndex].sort((a, b) => a - b) };
}

/** Groups measure indices into rows (systems), splitting after each registered line break. */
export function computeRows(measureCount: number, lineBreaks: number[]): number[][] {
  const breaks = Array.from(new Set(lineBreaks))
    .filter((i) => i >= 0 && i < measureCount - 1)
    .sort((a, b) => a - b);
  const rows: number[][] = [];
  let start = 0;
  for (const b of breaks) {
    const row: number[] = [];
    for (let i = start; i <= b; i++) row.push(i);
    rows.push(row);
    start = b + 1;
  }
  const tail: number[] = [];
  for (let i = start; i < measureCount; i++) tail.push(i);
  if (tail.length > 0 || rows.length === 0) rows.push(tail);
  return rows;
}

// --- Immutable score editing helpers ---------------------------------------

function cloneStaffMeasure(sm: StaffMeasure): StaffMeasure {
  return { notes: [...sm.notes] };
}

function updateMeasure(score: Score, measureIndex: number, clef: Clef, updater: (sm: StaffMeasure) => StaffMeasure): Score {
  const measures = score.measures.map((measure, i) => {
    if (i !== measureIndex) return measure;
    const updated = updater(cloneStaffMeasure(measure[clef]));
    return { ...measure, [clef]: updated };
  });
  return { ...score, measures };
}

export function addMeasure(score: Score): Score {
  return { ...score, measures: [...score.measures, createEmptyMeasure()] };
}

export interface AddNoteResult {
  score: Score;
  noteIndex: number;
  overflow: boolean;
}

export function addNoteToScore(
  score: Score,
  measureIndex: number,
  clef: Clef,
  note: NoteEvent,
): AddNoteResult {
  const measure = score.measures[measureIndex];
  const staffMeasure = measure[clef];
  const capacity = measureCapacityBeats(score.timeSignature);
  const currentBeats = staffMeasureBeats(staffMeasure);
  if (currentBeats + noteBeats(note) > capacity + 1e-6) {
    return { score, noteIndex: -1, overflow: true };
  }
  const noteIndex = staffMeasure.notes.length;
  const nextScore = updateMeasure(score, measureIndex, clef, (sm) => ({
    notes: [...sm.notes, note],
  }));
  return { score: nextScore, noteIndex, overflow: false };
}

export function removeNoteFromScore(score: Score, location: NoteLocation): Score {
  return updateMeasure(score, location.measureIndex, location.clef, (sm) => ({
    notes: sm.notes.filter((_, i) => i !== location.noteIndex),
  }));
}

export function updateNoteInScore(
  score: Score,
  location: NoteLocation,
  updater: (note: NoteEvent) => NoteEvent,
): Score {
  return updateMeasure(score, location.measureIndex, location.clef, (sm) => ({
    notes: sm.notes.map((n, i) => (i === location.noteIndex ? updater(n) : n)),
  }));
}

/**
 * After deleting the note at `deletedIndex` (list length was `oldLength`),
 * which index should become selected: the previous (left) note if one
 * exists, otherwise the note that shifted into its place (the old right
 * neighbor), otherwise none.
 */
export function adjacentIndexAfterDelete(deletedIndex: number, oldLength: number): number | null {
  const left = deletedIndex - 1;
  if (left >= 0) return left;
  const newLength = oldLength - 1;
  return newLength > 0 ? 0 : null;
}
