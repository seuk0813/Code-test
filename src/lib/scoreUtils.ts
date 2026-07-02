import type {
  Accidental,
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
  let octave = ref.octave + Math.floor(idx / 7);
  idx = ((idx % 7) + 7) % 7;
  return { letter: LETTERS[idx], octave };
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
