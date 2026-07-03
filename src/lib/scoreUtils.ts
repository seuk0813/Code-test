import type {
  Accidental,
  ChordQuality,
  ChordSymbol,
  Clef,
  DurationValue,
  LyricSyllable,
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

/** Shortest to longest. Long-press (toolbar or staff) steps toward the end of this list. */
export const DURATION_ORDER: DurationValue[] = ['16', '8', 'q', 'h', 'w'];

/** Next longer duration, or the same value if already a whole note. */
export function cycleDurationLonger(duration: DurationValue): DurationValue {
  const idx = DURATION_ORDER.indexOf(duration);
  return DURATION_ORDER[Math.min(idx + 1, DURATION_ORDER.length - 1)];
}

export function measureCapacityBeats(timeSignature: TimeSignature): number {
  return timeSignature.numerator * (4 / timeSignature.denominator);
}

export function staffMeasureBeats(staffMeasure: StaffMeasure): number {
  return staffMeasure.notes.reduce((sum, n) => sum + noteBeats(n), 0);
}

/**
 * Whether a staff-measure is filled to the time signature's capacity. Full
 * measures are auto-formatted (notes' free X positions are ignored) so the
 * score tidies itself once a measure is complete.
 */
export function isStaffMeasureFull(staffMeasure: StaffMeasure, timeSignature: TimeSignature): boolean {
  return staffMeasureBeats(staffMeasure) >= measureCapacityBeats(timeSignature) - 1e-6;
}

/** Whether a staff-measure holds more beats than the time signature allows. */
export function isStaffMeasureOverflow(staffMeasure: StaffMeasure, timeSignature: TimeSignature): boolean {
  return staffMeasureBeats(staffMeasure) > measureCapacityBeats(timeSignature) + 1e-6;
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
    lyrics: [],
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
  x?: number,
): NoteEvent {
  return {
    id: nextId('n'),
    pitches: isRest ? [] : pitches,
    duration,
    dotted,
    isRest,
    connectToNext: false,
    x,
  };
}

/** Whether a note connects to the next one (new flag or either legacy tie/slur flag). */
export function noteConnects(note: NoteEvent): boolean {
  return Boolean(note.connectToNext || note.tieToNext || note.slurToNext);
}

// --- Pitch <-> VexFlow key helpers -----------------------------------------

export function pitchToVexKey(pitch: Pitch): string {
  return `${pitch.letter.toLowerCase()}${pitch.accidental}/${pitch.octave}`;
}

const LETTERS: Pitch['letter'][] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

/**
 * Reference note sitting exactly on VexFlow's stave line 0 for each clef.
 * This is NOT the bottom staff line — VexFlow's own line numbering (as
 * returned by StaveNote.getKeyProps()) anchors line 0 two diatonic steps
 * below the bottom line: middle C for treble, E2 for bass. Verified against
 * the actual library (`new StaveNote({...}).getKeyProps()[0].line`) rather
 * than assumed, since getting this wrong silently shifts every clicked pitch
 * by a fixed number of steps.
 */
const CLEF_LINE0_REFERENCE: Record<Clef, { letter: Pitch['letter']; octave: number }> = {
  treble: { letter: 'C', octave: 4 },
  bass: { letter: 'E', octave: 2 },
};

/**
 * Convert a fractional VexFlow stave "line" position (see CLEF_LINE0_REFERENCE,
 * 0.5 per diatonic step) into a natural pitch. Used to map a mouse click's Y
 * position to a pitch on the staff.
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

export function chordLabel(chord: Pick<ChordSymbol, 'root' | 'accidental' | 'quality' | 'text'>): string {
  if (chord.text !== undefined) return chord.text;
  return `${chord.root}${ACCIDENTAL_SYMBOL[chord.accidental]}${CHORD_QUALITY_SUFFIX[chord.quality]}`;
}

/** Parsed left-to-right, case-sensitive so "M7" (major 7th) and "m7" (minor 7th) resolve differently. */
const QUALITY_PATTERNS: [RegExp, ChordQuality][] = [
  [/^(maj7|M7|major7|Δ7?)$/, 'maj7'],
  [/^(m7|min7|-7)$/, 'min7'],
  [/^(m7b5|m7-5|ø7?)$/, 'm7b5'],
  [/^(dim7|o7|°7)$/, 'dim7'],
  [/^(dim|o|°)$/, 'dim'],
  [/^(aug|\+)$/, 'aug'],
  [/^(sus2)$/, 'sus2'],
  [/^(sus4|sus)$/, 'sus4'],
  [/^(7|dom7)$/, '7'],
  [/^(m|min|-)$/, 'min'],
  [/^(maj|M|major)?$/, 'maj'],
];

/** Parses free-text chord input like "Cm7" or "F#dim" into root/accidental/quality. */
export function parseChordText(
  text: string,
): { root: Pitch['letter']; accidental: Accidental; quality: ChordQuality } | null {
  const trimmed = text.trim();
  const match = /^([A-Ga-g])([#b]?)(.*)$/.exec(trimmed);
  if (!match) return null;
  const root = match[1].toUpperCase() as Pitch['letter'];
  const accidental = (match[2] as Accidental) || '';
  const suffix = match[3].trim();
  for (const [pattern, quality] of QUALITY_PATTERNS) {
    if (pattern.test(suffix)) {
      return { root, accidental, quality };
    }
  }
  return null;
}

function nextChordOffset(existingCount: number): number {
  return 0.1 + ((existingCount * 0.22) % 0.8);
}

/**
 * Adds a chord symbol from raw free-text. The exact text is stored and shown
 * verbatim; if it happens to parse as a known chord we also keep the structured
 * root/quality (handy for any future harmony features), otherwise sensible
 * defaults are used.
 */
export function addChordToScore(score: Score, measureIndex: number, text: string): Score {
  const trimmed = text.trim();
  if (!trimmed) return score;
  const parsed = parseChordText(trimmed);
  const chords = score.measures[measureIndex].chords;
  const chord: ChordSymbol = {
    id: nextId('c'),
    root: parsed?.root ?? 'C',
    accidental: parsed?.accidental ?? '',
    quality: parsed?.quality ?? 'maj',
    text: trimmed,
    offset: nextChordOffset(chords.length),
  };
  const measures = score.measures.map((m, i) => (i === measureIndex ? { ...m, chords: [...m.chords, chord] } : m));
  return { ...score, measures };
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

// --- Lyrics (between-staff syllables) ---------------------------------------

/**
 * Adds a line of lyrics to a measure, split into one draggable syllable per
 * character (spaces separate but are dropped) so each can be nudged into place
 * under its note. New syllables are spread evenly across the measure width.
 */
export function addLyricsToScore(score: Score, measureIndex: number, text: string): Score {
  const chars = Array.from(text.trim()).filter((c) => c.trim().length > 0);
  if (chars.length === 0) return score;
  const existing = score.measures[measureIndex].lyrics ?? [];
  const startIndex = existing.length;
  const total = startIndex + chars.length;
  const newSyllables: LyricSyllable[] = chars.map((c, i) => ({
    id: nextId('ly'),
    text: c,
    offset: Math.min(0.95, Math.max(0.05, (startIndex + i + 0.5) / total)),
  }));
  const measures = score.measures.map((m, i) =>
    i === measureIndex ? { ...m, lyrics: [...existing, ...newSyllables] } : m,
  );
  return { ...score, measures };
}

/**
 * Repositions a lyric syllable, optionally moving it into a different measure
 * (dragging past a measure's edge). When the target measure differs from the
 * source, the syllable is spliced out of the source's list and appended to
 * the target's.
 */
export function moveLyricInScore(
  score: Score,
  fromMeasureIndex: number,
  lyricId: string,
  offset: number,
  toMeasureIndex: number = fromMeasureIndex,
): Score {
  const clamped = Math.min(0.97, Math.max(0.03, offset));
  if (toMeasureIndex === fromMeasureIndex) {
    const measures = score.measures.map((m, i) =>
      i === fromMeasureIndex
        ? { ...m, lyrics: (m.lyrics ?? []).map((l) => (l.id === lyricId ? { ...l, offset: clamped } : l)) }
        : m,
    );
    return { ...score, measures };
  }
  const source = score.measures[fromMeasureIndex]?.lyrics ?? [];
  const syllable = source.find((l) => l.id === lyricId);
  if (!syllable) return score;
  const measures = score.measures.map((m, i) => {
    if (i === fromMeasureIndex) return { ...m, lyrics: source.filter((l) => l.id !== lyricId) };
    if (i === toMeasureIndex) return { ...m, lyrics: [...(m.lyrics ?? []), { ...syllable, offset: clamped }] };
    return m;
  });
  return { ...score, measures };
}

export function removeLyricFromScore(score: Score, measureIndex: number, lyricId: string): Score {
  const measures = score.measures.map((m, i) =>
    i === measureIndex ? { ...m, lyrics: (m.lyrics ?? []).filter((l) => l.id !== lyricId) } : m,
  );
  return { ...score, measures };
}

// --- Line breaks (systems / rows) -------------------------------------------

export function addLineBreak(score: Score, afterMeasureIndex: number): Score {
  if (score.lineBreaks.includes(afterMeasureIndex)) return score;
  return { ...score, lineBreaks: [...score.lineBreaks, afterMeasureIndex].sort((a, b) => a - b) };
}

/**
 * Groups measure indices into rows (systems). A row wraps automatically once it
 * holds `maxPerRow` measures, and a manually registered line break forces an
 * earlier wrap after that measure.
 */
export function computeRows(measureCount: number, lineBreaks: number[], maxPerRow = 4): number[][] {
  const breaks = new Set(lineBreaks.filter((i) => i >= 0 && i < measureCount - 1));
  const rows: number[][] = [];
  let row: number[] = [];
  for (let i = 0; i < measureCount; i++) {
    row.push(i);
    if (breaks.has(i) || row.length >= maxPerRow) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0 || rows.length === 0) rows.push(row);
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

/** Removes a measure and reindexes any manual line breaks that referenced measures after it. Keeps at least one measure. */
export function removeMeasure(score: Score, measureIndex: number): Score {
  if (score.measures.length <= 1) return score;
  const measures = score.measures.filter((_, i) => i !== measureIndex);
  const lineBreaks = score.lineBreaks
    .filter((b) => b !== measureIndex)
    .map((b) => (b > measureIndex ? b - 1 : b));
  return { ...score, measures, lineBreaks };
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
  insertIndex?: number,
): AddNoteResult {
  const measure = score.measures[measureIndex];
  const staffMeasure = measure[clef];
  const capacity = measureCapacityBeats(score.timeSignature);
  const currentBeats = staffMeasureBeats(staffMeasure);
  if (currentBeats + noteBeats(note) > capacity + 1e-6) {
    return { score, noteIndex: -1, overflow: true };
  }
  const noteIndex =
    insertIndex === undefined ? staffMeasure.notes.length : Math.max(0, Math.min(insertIndex, staffMeasure.notes.length));
  const nextScore = updateMeasure(score, measureIndex, clef, (sm) => {
    const notes = [...sm.notes];
    notes.splice(noteIndex, 0, note);
    return { notes };
  });
  return { score: nextScore, noteIndex, overflow: false };
}

/** Adds or removes a pitch from an existing (non-rest) note, building a chord. Keeps at least one pitch. */
export function togglePitchInNote(
  score: Score,
  location: NoteLocation,
  letter: Pitch['letter'],
  accidental: Accidental,
  octave: number,
): Score {
  return updateNoteInScore(score, location, (note) => {
    if (note.isRest) return note;
    const existingIndex = note.pitches.findIndex((p) => p.letter === letter && p.octave === octave);
    if (existingIndex >= 0) {
      if (note.pitches.length <= 1) return note;
      return { ...note, pitches: note.pitches.filter((_, i) => i !== existingIndex) };
    }
    return { ...note, pitches: [...note.pitches, { letter, accidental, octave }] };
  });
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
 * Toggles whether the note connects to the next one. A single flag now covers
 * both tie and slur: the renderer picks a tie when the pitches match, a slur
 * otherwise. Legacy tie/slur flags are cleared so old data doesn't conflict.
 */
export function toggleConnectToNext(score: Score, location: NoteLocation): Score {
  return updateNoteInScore(score, location, (note) => ({
    ...note,
    connectToNext: !noteConnects(note),
    tieToNext: false,
    slurToNext: false,
    connectToId: undefined,
  }));
}

/**
 * Connects a note to an arbitrary other note (by id) — set by dragging the
 * connector handle onto a target, for chords or out-of-sequence notes where
 * "the next note" isn't the one you want. Clears the sequential flag so the
 * two mechanisms don't fight over rendering the same note.
 */
export function connectNoteTo(score: Score, source: NoteLocation, targetId: string): Score {
  return updateNoteInScore(score, source, (note) => ({
    ...note,
    connectToId: targetId,
    connectToNext: false,
    tieToNext: false,
    slurToNext: false,
  }));
}

/** Removes any connection (sequential or arbitrary-target) from a note. */
export function clearNoteConnection(score: Score, location: NoteLocation): Score {
  return updateNoteInScore(score, location, (note) => ({
    ...note,
    connectToNext: false,
    tieToNext: false,
    slurToNext: false,
    connectToId: undefined,
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
