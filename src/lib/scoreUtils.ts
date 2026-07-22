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
  RestMark,
  ScaleDegreeLabel,
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

/** Next shorter duration, or the same value if already a 16th note. */
export function cycleDurationShorter(duration: DurationValue): DurationValue {
  const idx = DURATION_ORDER.indexOf(duration);
  return DURATION_ORDER[Math.max(idx - 1, 0)];
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

/**
 * How many beats the given measure spans for absolute-timing purposes (used
 * to place it on the playback/seek timeline) — the full time-signature
 * capacity for every ordinary measure. The exceptions are the two optional
 * partial measures a piece can have: 못갖춘마디 (an anacrusis/pickup measure,
 * `score.pickupBeats`) at index 0, and a mirrored trailing partial closing
 * measure (`score.trailingBeats`) at the very last index — each spans
 * exactly its declared beat count instead of the full capacity, so it
 * doesn't get padded with trailing silence. Both are set explicitly by the
 * user via the seek bar (see splitPickupMeasure/splitTrailingMeasure).
 */
export function measureDurationBeats(score: Score, measureIndex: number): number {
  const capacity = measureCapacityBeats(score.timeSignature);
  if (measureIndex === 0 && score.pickupBeats !== undefined && score.measures.length > 0) {
    return Math.min(capacity, Math.max(0, score.pickupBeats));
  }
  if (measureIndex === score.measures.length - 1 && score.trailingBeats !== undefined) {
    return Math.min(capacity, Math.max(0, score.trailingBeats));
  }
  return capacity;
}

/** Absolute beat offset where the given measure starts — see measureDurationBeats. */
export function measureStartBeat(score: Score, measureIndex: number): number {
  if (score.pickupBeats === undefined && score.trailingBeats === undefined) {
    return measureIndex * measureCapacityBeats(score.timeSignature);
  }
  let start = 0;
  for (let i = 0; i < measureIndex; i++) start += measureDurationBeats(score, i);
  return start;
}

/** Every selectable scale-degree label (see ScaleDegreeLabel) — the checkbox list's full contents. */
export const SCALE_DEGREE_LABELS: ScaleDegreeLabel[] = ['1', '2', '3', '4', '5', '6', '7', 'b9', 'b5', '#5', 'dim7'];
/** Checked by default when 표기 is first turned on — the plain diatonic 7, no altered/extended tones. */
export const DEFAULT_SCALE_DEGREE_LABELS: ScaleDegreeLabel[] = ['1', '2', '3', '4', '5', '6', '7'];

const LETTER_PITCH_CLASS: Record<Pitch['letter'], number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function pitchClass(letter: Pitch['letter'], accidental: Accidental): number {
  const shift = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0;
  return (((LETTER_PITCH_CLASS[letter] + shift) % 12) + 12) % 12;
}

/** Semitones-from-root → { checkbox key, display text } — see ScaleDegreeLabel's
 * doc comment for why '3'/'7' cover two semitones each and 'dim7'/'6' share one. */
const DEGREE_TABLE: Record<number, { key: ScaleDegreeLabel; text: string }> = {
  0: { key: '1', text: '1' },
  1: { key: 'b9', text: 'b9' },
  2: { key: '2', text: '2' },
  3: { key: '3', text: 'b3' },
  4: { key: '3', text: '3' },
  5: { key: '4', text: '4' },
  6: { key: 'b5', text: 'b5' },
  7: { key: '5', text: '5' },
  8: { key: '#5', text: '#5' },
  9: { key: '6', text: '6' },
  10: { key: '7', text: '7' },
  11: { key: '7', text: '△7' },
};

/** The scale-degree label text for `pitch` against a chord rooted at
 * (`chordRoot`, `chordRootAccidental`) — e.g. D against a C-rooted chord is
 * "2". Returns null when that particular degree's checkbox isn't in
 * `enabledLabels` (see ScaleDegreeLabel/SCALE_DEGREE_LABELS), so it's simply
 * not drawn. Octave-independent (only the pitch classes matter).
 *
 * `pitch.accidental` alone isn't enough: a note with NO explicit accidental
 * still sounds sharped/flatted whenever the key signature affects its letter
 * (see KEY_SIGNATURE_ACCIDENTALS/effectiveAccidental) — e.g. a plain "C" in
 * the key of A actually sounds C#. Using the raw (blank) field here used to
 * label that C a "b3" against an A chord instead of the correct "3". An
 * explicit accidental on the note (including 'n' cancelling the key
 * signature) always overrides `keySignature`, matching effectiveAccidental. */
export function scaleDegreeFor(
  pitch: Pick<Pitch, 'letter' | 'accidental'>,
  chordRoot: Pitch['letter'],
  chordRootAccidental: Accidental,
  enabledLabels: ScaleDegreeLabel[],
  keySignature: string,
): string | null {
  const soundingAccidental = pitch.accidental !== '' ? pitch.accidental : keySignatureAccidentalFor(pitch.letter, keySignature);
  const semitone = (pitchClass(pitch.letter, soundingAccidental) - pitchClass(chordRoot, chordRootAccidental) + 12) % 12;
  if (semitone === 9) {
    if (enabledLabels.includes('dim7')) return 'dim7';
    return enabledLabels.includes('6') ? '6' : null;
  }
  const entry = DEGREE_TABLE[semitone];
  return entry && enabledLabels.includes(entry.key) ? entry.text : null;
}

/** Every chord symbol in the score, in playing order, with its absolute beat
 * position (see measureStartBeat) — used to find whichever chord is
 * "active" at any given note (see activeChordAt). A measure's EARLIEST chord
 * (by offset) is snapped to that measure's own start beat, ignoring its own
 * small cosmetic offset (new chords default to offset 0.1, a few pixels in
 * from the barline, purely so the symbol doesn't collide with it) — that
 * chord is meant to govern the whole measure from beat 0, matching how a
 * lead-sheet player reads "the chord written over this bar" (see item 7's
 * spec: the first chord of a measure counts from that measure's downbeat).
 * Any later chords in the same measure keep their real offset, since those
 * genuinely mark a harmony change partway through the bar. */
function flattenChords(score: Score): { chord: ChordSymbol; beat: number }[] {
  const flat: { chord: ChordSymbol; beat: number }[] = [];
  score.measures.forEach((measure, measureIndex) => {
    const start = measureStartBeat(score, measureIndex);
    const duration = measureDurationBeats(score, measureIndex);
    const sorted = [...measure.chords].sort((a, b) => a.offset - b.offset);
    sorted.forEach((chord, i) => {
      flat.push({ chord, beat: i === 0 ? start : start + chord.offset * duration });
    });
  });
  flat.sort((a, b) => a.beat - b.beat);
  return flat;
}

/** The chord symbol sounding at `beat` (the last one at or before it, across
 * the whole score — a chord keeps applying until the next one starts, even
 * across measure or line breaks). Null before the first chord symbol. */
export function activeChordAt(sortedChords: { chord: ChordSymbol; beat: number }[], beat: number): ChordSymbol | null {
  let active: ChordSymbol | null = null;
  for (const entry of sortedChords) {
    if (entry.beat > beat + 1e-6) break;
    active = entry.chord;
  }
  return active;
}

/** Precomputes every note's scale-degree label text (see scaleDegreeFor), for
 * both staves across the whole score, keyed by `${clef}:${measureIndex}:${noteIndex}`.
 * Empty when showScaleDegrees is off. */
export function computeScaleDegreeLabels(score: Score): Map<string, string> {
  const labels = new Map<string, string>();
  if (!score.showScaleDegrees) return labels;
  const enabled = score.scaleDegreeLabels ?? DEFAULT_SCALE_DEGREE_LABELS;
  const sortedChords = flattenChords(score);
  if (sortedChords.length === 0) return labels;
  (['treble', 'bass'] as Clef[]).forEach((clef) => {
    score.measures.forEach((measure, measureIndex) => {
      let beat = measureStartBeat(score, measureIndex);
      measure[clef].notes.forEach((note, noteIndex) => {
        if (!note.isRest && note.pitches.length > 0) {
          const chord = activeChordAt(sortedChords, beat);
          if (chord) {
            const text = scaleDegreeFor(note.pitches[0], chord.root, chord.accidental, enabled, score.keySignature);
            if (text) labels.set(`${clef}:${measureIndex}:${noteIndex}`, text);
          }
        }
        beat += noteBeats(note);
      });
    });
  });
  return labels;
}

/**
 * True only when BOTH a 못갖춘마디(pickup) and a trailing partial closing
 * measure are set, but their beats don't add up to one full measure's worth
 * — the classical convention that a pickup "borrows" beats from the piece's
 * closing measure. A pickup with no trailing measure has nothing to borrow
 * from, so it's never flagged (the mismatch only makes sense once the user
 * has deliberately paired the two). Surfaced as a warning in Toolbar next to
 * the 못갖춘마디 toggle.
 */
export function pickupTrailingMismatch(score: Score): boolean {
  if (score.pickupBeats === undefined || score.trailingBeats === undefined) return false;
  const capacity = measureCapacityBeats(score.timeSignature);
  return Math.abs(score.pickupBeats + score.trailingBeats - capacity) > 1e-6;
}

function clampMeasureOffset(x: number): number {
  return Math.min(0.97, Math.max(0.03, x));
}

interface MeasureSplitHalf {
  treble: StaffMeasure;
  bass: StaffMeasure;
  chords: ChordSymbol[];
  lyrics: LyricSyllable[];
  restMarks: RestMark[];
}

/** Splits a measure's content at `splitBeat` (0..capacity) into a head half (everything before) and a tail half (everything from splitBeat onward). Notes split by cumulative onset; chord/lyric offsets (fractions of the whole measure) are rescaled to fractions of whichever half they land in. */
function splitMeasureContent(measure: Measure, splitBeat: number, capacity: number): { head: MeasureSplitHalf; tail: MeasureSplitHalf } {
  const splitStaff = (sm: StaffMeasure): { head: StaffMeasure; tail: StaffMeasure } => {
    let t = 0;
    const head: NoteEvent[] = [];
    const tail: NoteEvent[] = [];
    sm.notes.forEach((n) => {
      if (t < splitBeat - 1e-6) head.push(n);
      else tail.push(n);
      t += noteBeats(n);
    });
    return { head: { notes: head }, tail: { notes: tail } };
  };
  const treble = splitStaff(measure.treble);
  const bass = splitStaff(measure.bass);
  const frac = Math.min(0.999, Math.max(0.001, splitBeat / capacity));
  function splitByOffset<T extends { offset: number }>(items: T[]): { head: T[]; tail: T[] } {
    const head: T[] = [];
    const tail: T[] = [];
    items.forEach((item) => {
      if (item.offset < frac) head.push({ ...item, offset: clampMeasureOffset(item.offset / frac) });
      else tail.push({ ...item, offset: clampMeasureOffset((item.offset - frac) / (1 - frac)) });
    });
    return { head, tail };
  }
  const chords = splitByOffset(measure.chords);
  const lyrics = splitByOffset(measure.lyrics);
  const restMarks = splitByOffset(measure.restMarks ?? []);
  return {
    head: { treble: treble.head, bass: bass.head, chords: chords.head, lyrics: lyrics.head, restMarks: restMarks.head },
    tail: { treble: treble.tail, bass: bass.tail, chords: chords.tail, lyrics: lyrics.tail, restMarks: restMarks.tail },
  };
}

/**
 * Creates the 못갖춘마디: splits the first measure's content at `splitBeat`
 * (captured from the current seek bar position) into a short pickup — kept
 * at index 0 — and a fresh full-capacity measure holding the rest, inserted
 * right after. See the "못갖춘마디" toggle in Toolbar.
 */
export function splitPickupMeasure(score: Score, splitBeat: number): Score {
  const capacity = measureCapacityBeats(score.timeSignature);
  const clamped = Math.min(capacity - 0.01, Math.max(0.01, splitBeat));
  const original = score.measures[0];
  if (!original) return score;
  const { head, tail } = splitMeasureContent(original, clamped, capacity);
  const pickupMeasure: Measure = { id: original.id, ...head };
  const restMeasure: Measure = { id: nextId('m'), ...tail };
  const measures = [pickupMeasure, restMeasure, ...score.measures.slice(1)];
  const lineBreaks = score.lineBreaks.map((b) => b + 1);
  return { ...score, measures, lineBreaks, pickupBeats: clamped };
}

/** Undoes splitPickupMeasure: merges the pickup and the measure after it back into one normal first measure. */
export function clearPickupMeasure(score: Score): Score {
  if (score.pickupBeats === undefined || score.measures.length < 2) return { ...score, pickupBeats: undefined };
  const capacity = measureCapacityBeats(score.timeSignature);
  const head = score.measures[0];
  const tail = score.measures[1];
  const frac = Math.min(0.999, Math.max(0.001, score.pickupBeats / capacity));
  function mergeOffsets<T extends { offset: number }>(headItems: T[], tailItems: T[]): T[] {
    return [
      ...headItems.map((it) => ({ ...it, offset: clampMeasureOffset(it.offset * frac) })),
      ...tailItems.map((it) => ({ ...it, offset: clampMeasureOffset(frac + it.offset * (1 - frac)) })),
    ];
  }
  const merged: Measure = {
    id: head.id,
    treble: { notes: [...head.treble.notes, ...tail.treble.notes] },
    bass: { notes: [...head.bass.notes, ...tail.bass.notes] },
    chords: mergeOffsets(head.chords, tail.chords),
    lyrics: mergeOffsets(head.lyrics, tail.lyrics),
    restMarks: mergeOffsets(head.restMarks ?? [], tail.restMarks ?? []),
  };
  const measures = [merged, ...score.measures.slice(2)];
  const lineBreaks = score.lineBreaks.filter((b) => b !== 1).map((b) => (b > 1 ? b - 1 : b));
  return { ...score, measures, lineBreaks, pickupBeats: undefined };
}

/**
 * Creates a trailing partial closing measure: splits the last measure's
 * content at `splitBeat` (a beat position within that measure, captured from
 * the current seek bar position) into a fresh full-capacity measure — inserted
 * just before it — holding everything before the split, and a short trailing
 * measure holding the rest, kept as the new last measure. Mirrors
 * splitPickupMeasure at the other end of the piece.
 */
export function splitTrailingMeasure(score: Score, splitBeat: number): Score {
  const capacity = measureCapacityBeats(score.timeSignature);
  const clamped = Math.min(capacity - 0.01, Math.max(0.01, splitBeat));
  const lastIndex = score.measures.length - 1;
  const original = score.measures[lastIndex];
  if (!original) return score;
  const { head, tail } = splitMeasureContent(original, clamped, capacity);
  const headMeasure: Measure = { id: nextId('m'), ...head };
  const trailingMeasure: Measure = { id: original.id, ...tail };
  const measures = [...score.measures.slice(0, lastIndex), headMeasure, trailingMeasure];
  return { ...score, measures, trailingBeats: capacity - clamped };
}

/** Undoes splitTrailingMeasure: merges the trailing measure and the one before it back into one normal last measure. */
export function clearTrailingMeasure(score: Score): Score {
  if (score.trailingBeats === undefined || score.measures.length < 2) return { ...score, trailingBeats: undefined };
  const capacity = measureCapacityBeats(score.timeSignature);
  const lastIndex = score.measures.length - 1;
  const head = score.measures[lastIndex - 1];
  const tail = score.measures[lastIndex];
  const splitBeat = capacity - score.trailingBeats;
  const frac = Math.min(0.999, Math.max(0.001, splitBeat / capacity));
  function mergeOffsets<T extends { offset: number }>(headItems: T[], tailItems: T[]): T[] {
    return [
      ...headItems.map((it) => ({ ...it, offset: clampMeasureOffset(it.offset * frac) })),
      ...tailItems.map((it) => ({ ...it, offset: clampMeasureOffset(frac + it.offset * (1 - frac)) })),
    ];
  }
  const merged: Measure = {
    id: tail.id,
    treble: { notes: [...head.treble.notes, ...tail.treble.notes] },
    bass: { notes: [...head.bass.notes, ...tail.bass.notes] },
    chords: mergeOffsets(head.chords, tail.chords),
    lyrics: mergeOffsets(head.lyrics, tail.lyrics),
    restMarks: mergeOffsets(head.restMarks ?? [], tail.restMarks ?? []),
  };
  const measures = [...score.measures.slice(0, lastIndex - 1), merged];
  return { ...score, measures, trailingBeats: undefined };
}

/**
 * Moves an already-created 못갖춘마디's end boundary to a new beat position
 * (dragging the handle at the barline after it). Only the declared beat
 * count changes — the notes/chords/lyrics already placed in the pickup and
 * the measure after it stay exactly where they are, so nothing jumps
 * measures mid-drag. No-op if there's no pickup measure to resize.
 */
export function resizePickupMeasure(score: Score, newPickupBeats: number): Score {
  if (score.pickupBeats === undefined) return score;
  const capacity = measureCapacityBeats(score.timeSignature);
  const clamped = Math.min(capacity - 0.01, Math.max(0.01, newPickupBeats));
  return { ...score, pickupBeats: clamped };
}

/**
 * Mirrors resizePickupMeasure for the trailing partial closing measure's
 * start boundary. `splitBeat` is measured the same way as splitTrailingMeasure
 * expects (a beat position within the full measure, not the resulting
 * trailing length) — only the declared trailingBeats changes; existing
 * note/chord/lyric content is left untouched. No-op if there's no trailing
 * measure to resize.
 */
export function resizeTrailingMeasure(score: Score, splitBeat: number): Score {
  if (score.trailingBeats === undefined) return score;
  const capacity = measureCapacityBeats(score.timeSignature);
  const clamped = Math.min(capacity - 0.01, Math.max(0.01, splitBeat));
  return { ...score, trailingBeats: capacity - clamped };
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
    restMarks: [],
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
    x,
  };
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

/** Index of a chord's highest-sounding pitch (treble-clef line order) — the one shown on the derived melody staff and the one melody-staff edits/drags apply to. */
export function topPitchIndex(pitches: Pitch[]): number {
  let bestIndex = 0;
  let bestLine = -Infinity;
  pitches.forEach((p, i) => {
    const line = pitchToLine('treble', p.letter, p.octave);
    if (line > bestLine) {
      bestLine = line;
      bestIndex = i;
    }
  });
  return bestIndex;
}

/**
 * Derives the melody-staff notes shown by the lead-sheet layout (see
 * Score.showMelodyStaff): the same rhythm as the treble staff, but chords
 * collapsed to just their highest pitch (the customary "top line" of a piano
 * part's right hand). Rests and already-single-pitch notes pass through
 * unchanged. A rendering-time view derived from the treble staff's own notes
 * — edits made by clicking on it (see StaffEditor) are applied back to that
 * same treble data (the highest pitch when narrowed to one), not stored separately.
 */
export function deriveMelodyNotes(notes: NoteEvent[]): NoteEvent[] {
  return notes.map((note) => {
    if (note.isRest || note.pitches.length <= 1) return note;
    const top = note.pitches[topPitchIndex(note.pitches)];
    return { ...note, pitches: [top] };
  });
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

/**
 * Sharps/flats a key signature implies for each diatonic letter (standard
 * order-of-sharps/flats). A pitch with no explicit accidental of its own
 * (accidental === '') sounds with whatever this table says; an explicit '#',
 * 'b', or 'n' on the pitch always overrides it — see effectiveAccidental.
 */
const KEY_SIGNATURE_ACCIDENTALS: Record<string, Partial<Record<Pitch['letter'], '#' | 'b'>>> = {
  C: {},
  G: { F: '#' },
  D: { F: '#', C: '#' },
  A: { F: '#', C: '#', G: '#' },
  E: { F: '#', C: '#', G: '#', D: '#' },
  F: { B: 'b' },
  Bb: { B: 'b', E: 'b' },
  Eb: { B: 'b', E: 'b', A: 'b' },
  Ab: { B: 'b', E: 'b', A: 'b', D: 'b' },
};

/**
 * The accidental a pitch actually sounds with: an explicit accidental on the
 * note ('#', 'b', or 'n' to cancel a key-signature sharp/flat) always wins;
 * otherwise it falls back to the key signature's implied sharp/flat for that
 * letter (or none, in a key that doesn't affect it).
 */
export function effectiveAccidental(pitch: Pitch, keySignature: string): Accidental {
  if (pitch.accidental !== '') return pitch.accidental;
  return KEY_SIGNATURE_ACCIDENTALS[keySignature]?.[pitch.letter] ?? '';
}

/** The sharp/flat a given letter carries in a key signature (e.g. 'B' in F major -> 'b'), or '' if unaffected. */
export function keySignatureAccidentalFor(letter: Pitch['letter'], keySignature: string): Accidental {
  return KEY_SIGNATURE_ACCIDENTALS[keySignature]?.[letter] ?? '';
}

/** MIDI note number for a pitch, used for audio playback. */
export function pitchToMidi(pitch: Pitch, keySignature: string): number {
  const semitonesFromC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[pitch.letter];
  const acc = effectiveAccidental(pitch, keySignature);
  const accidentalShift = acc === '#' ? 1 : acc === 'b' ? -1 : 0;
  return (pitch.octave + 1) * 12 + semitonesFromC + accidentalShift;
}

export function pitchToToneNote(pitch: Pitch, keySignature: string): string {
  const acc = effectiveAccidental(pitch, keySignature);
  const symbol = acc === '#' ? '#' : acc === 'b' ? 'b' : '';
  return `${pitch.letter}${symbol}${pitch.octave}`;
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

/** Plain-ASCII suffixes — every value here round-trips through parseChordText's QUALITY_PATTERNS (used to build free-text chord input from a structured root+quality pair, e.g. the toolbar chord builder). */
export const CHORD_QUALITY_SUFFIX: Record<ChordQuality, string> = {
  maj: '',
  min: 'm',
  '7': '7',
  maj7: 'maj7',
  min7: 'm7',
  dim: 'dim',
  aug: 'aug',
  sus2: 'sus2',
  sus4: 'sus4',
  m7b5: 'm7b5',
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

/** Parses free-text chord input like "Cm7" or "F#dim" into root/accidental/quality.
 * A trailing slash bass note ("F/A", "Bb/D") is stripped before matching the
 * quality suffix — the root above the slash is the functional root (what
 * scale-degree labeling and any other harmony logic should key off), the
 * bass note itself is display-only (it's kept verbatim in the chord's raw
 * `text`, never parsed into a separate field).
 *
 * The root/accidental letter always parses on its own (only the leading
 * `[A-G][#b]?` needs to match); an unrecognized quality suffix (extended/6th
 * chords like "Dm6", "Cadd9") no longer fails the WHOLE parse and silently
 * keeps whatever root the chord previously had — that used to make
 * scale-degree labeling key off a stale, unrelated root the moment someone
 * typed a chord quality this app doesn't have a dedicated pattern for.
 * `quality` falls back to 'maj' in that case; it's only ever used as a
 * structured hint (e.g. for future harmony features) — the exact glyph the
 * user typed is preserved verbatim in `text` and always wins for display
 * (see chordLabel). */
export function parseChordText(
  text: string,
): { root: Pitch['letter']; accidental: Accidental; quality: ChordQuality } | null {
  const trimmed = text.trim().split('/')[0];
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
  return { root, accidental, quality: 'maj' };
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

/** Adds a chord symbol at an exact clicked position, instead of auto-spacing it. */
export function addChordToScoreAt(score: Score, measureIndex: number, text: string, offset: number): Score {
  const trimmed = text.trim();
  if (!trimmed) return score;
  const parsed = parseChordText(trimmed);
  const chord: ChordSymbol = {
    id: nextId('c'),
    root: parsed?.root ?? 'C',
    accidental: parsed?.accidental ?? '',
    quality: parsed?.quality ?? 'maj',
    text: trimmed,
    offset: Math.min(0.95, Math.max(0.05, offset)),
  };
  const measures = score.measures.map((m, i) => (i === measureIndex ? { ...m, chords: [...m.chords, chord] } : m));
  return { ...score, measures };
}

/** Edits an existing chord's text in place. Clearing it entirely removes the chord. */
export function editChordText(score: Score, measureIndex: number, chordId: string, text: string): Score {
  const trimmed = text.trim();
  const measures = score.measures.map((m, i) => {
    if (i !== measureIndex) return m;
    if (!trimmed) return { ...m, chords: m.chords.filter((c) => c.id !== chordId) };
    const parsed = parseChordText(trimmed);
    return {
      ...m,
      chords: m.chords.map((c) =>
        c.id === chordId
          ? { ...c, text: trimmed, root: parsed?.root ?? c.root, accidental: parsed?.accidental ?? c.accidental, quality: parsed?.quality ?? c.quality }
          : c,
      ),
    };
  });
  return { ...score, measures };
}

/**
 * Repositions a chord symbol, optionally moving it into a different measure
 * (dragging past a measure's edge) — mirrors moveLyricInScore. When the
 * target measure differs from the source, the chord is spliced out of the
 * source's list and appended to the target's.
 */
export function moveChordInScore(
  score: Score,
  measureIndex: number,
  chordId: string,
  offset: number,
  toMeasureIndex: number = measureIndex,
): Score {
  const clamped = Math.min(0.95, Math.max(0.05, offset));
  if (toMeasureIndex === measureIndex) {
    const measures = score.measures.map((m, i) =>
      i === measureIndex
        ? { ...m, chords: m.chords.map((c) => (c.id === chordId ? { ...c, offset: clamped } : c)) }
        : m,
    );
    return { ...score, measures };
  }
  const source = score.measures[measureIndex]?.chords ?? [];
  const chord = source.find((c) => c.id === chordId);
  if (!chord) return score;
  const measures = score.measures.map((m, i) => {
    if (i === measureIndex) return { ...m, chords: source.filter((c) => c.id !== chordId) };
    if (i === toMeasureIndex) return { ...m, chords: [...m.chords, { ...chord, offset: clamped }] };
    return m;
  });
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

/** Adds lyric text starting at an exact clicked offset, spreading subsequent characters evenly to the right. */
export function addLyricsToScoreAt(score: Score, measureIndex: number, text: string, startOffset: number): Score {
  const chars = Array.from(text.trim()).filter((c) => c.trim().length > 0);
  if (chars.length === 0) return score;
  const existing = score.measures[measureIndex].lyrics ?? [];
  const step = 0.09;
  const newSyllables: LyricSyllable[] = chars.map((c, i) => ({
    id: nextId('ly'),
    text: c,
    offset: Math.min(0.97, Math.max(0.03, startOffset + i * step)),
  }));
  const measures = score.measures.map((m, i) =>
    i === measureIndex ? { ...m, lyrics: [...existing, ...newSyllables] } : m,
  );
  return { ...score, measures };
}

/**
 * Edits an existing lyric syllable's text in place. Clearing it entirely
 * removes the syllable. Typing more than one character (e.g. replacing "안"
 * with "안녕하세요") splits the input the same way addLyricsToScoreAt does,
 * so every character stays its own independently-draggable syllable instead
 * of being crammed into the one original syllable slot.
 */
export function editLyricText(score: Score, measureIndex: number, lyricId: string, text: string): Score {
  const trimmed = text.trim();
  const measures = score.measures.map((m, i) => {
    if (i !== measureIndex) return m;
    const lyrics = m.lyrics ?? [];
    const existing = lyrics.find((l) => l.id === lyricId);
    if (!existing) return m;
    if (!trimmed) return { ...m, lyrics: lyrics.filter((l) => l.id !== lyricId) };
    const chars = Array.from(trimmed).filter((c) => c.trim().length > 0);
    if (chars.length <= 1) {
      return { ...m, lyrics: lyrics.map((l) => (l.id === lyricId ? { ...l, text: trimmed } : l)) };
    }
    const step = 0.09;
    const newSyllables: LyricSyllable[] = chars.map((c, idx) => ({
      id: nextId('ly'),
      text: c,
      offset: Math.min(0.97, Math.max(0.03, existing.offset + idx * step)),
    }));
    return { ...m, lyrics: [...lyrics.filter((l) => l.id !== lyricId), ...newSyllables] };
  });
  return { ...score, measures };
}

export function removeLyricFromScore(score: Score, measureIndex: number, lyricId: string): Score {
  const measures = score.measures.map((m, i) =>
    i === measureIndex ? { ...m, lyrics: (m.lyrics ?? []).filter((l) => l.id !== lyricId) } : m,
  );
  return { ...score, measures };
}

/**
 * Adds a visual-only rest mark (see RestMark / #187) at an exact clicked
 * position — the "sketch a rest on top of a full staff" gesture. Unlike a
 * real NoteEvent this never checks beat capacity: it's explicitly meant to
 * be droppable even where a staff is already full.
 */
export function addRestMarkAt(
  score: Score,
  measureIndex: number,
  clef: Clef,
  offset: number,
  line: number,
  duration: DurationValue = 'q',
): Score {
  const mark: RestMark = { id: nextId('rm'), clef, offset: Math.min(0.97, Math.max(0.03, offset)), line, duration };
  const measures = score.measures.map((m, i) => (i === measureIndex ? { ...m, restMarks: [...(m.restMarks ?? []), mark] } : m));
  return { ...score, measures };
}

export function removeRestMark(score: Score, measureIndex: number, restMarkId: string): Score {
  const measures = score.measures.map((m, i) =>
    i === measureIndex ? { ...m, restMarks: (m.restMarks ?? []).filter((r) => r.id !== restMarkId) } : m,
  );
  return { ...score, measures };
}

/** Drag-a-corner-handle gesture (see StaffEditor): changes a selected rest
 * mark's on-screen visual size (RestMark.scale), independent of its duration/glyph. */
export function setRestMarkScale(score: Score, measureIndex: number, restMarkId: string, scale: number): Score {
  const clamped = Math.min(3.5, Math.max(0.4, scale));
  const measures = score.measures.map((m, i) =>
    i === measureIndex ? { ...m, restMarks: (m.restMarks ?? []).map((r) => (r.id === restMarkId ? { ...r, scale: clamped } : r)) } : m,
  );
  return { ...score, measures };
}

/** Drag-the-glyph-body gesture (see StaffEditor): repositions a rest mark elsewhere on the score. */
export function moveRestMark(score: Score, measureIndex: number, restMarkId: string, offset: number, line: number): Score {
  const clampedOffset = Math.min(0.97, Math.max(0.03, offset));
  const measures = score.measures.map((m, i) =>
    i === measureIndex
      ? { ...m, restMarks: (m.restMarks ?? []).map((r) => (r.id === restMarkId ? { ...r, offset: clampedOffset, line } : r)) }
      : m,
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

/**
 * Like computeRows, but pickup/trailing-aware: a 못갖춘마디 (pickup) first
 * measure rides along as an extra slot on the first row (pickup + up to 4
 * regular measures) instead of competing for one of the 4 regular slots, and
 * a trailing partial closing measure is never left alone on the last row —
 * it's pulled back into the row before it (up to 4 regular + the trailing
 * measure). See the "못갖춘마디" toggle in Toolbar.
 */
export function computeScoreRows(
  measureCount: number,
  lineBreaks: number[],
  hasPickup: boolean,
  hasTrailing: boolean,
  maxPerRow = 4,
): number[][] {
  const firstRowCap = hasPickup ? maxPerRow + 1 : maxPerRow;
  const breaks = new Set(lineBreaks.filter((i) => i >= 0 && i < measureCount - 1));
  const rows: number[][] = [];
  let row: number[] = [];
  for (let i = 0; i < measureCount; i++) {
    row.push(i);
    const cap = rows.length === 0 ? firstRowCap : maxPerRow;
    if (breaks.has(i) || row.length >= cap) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0 || rows.length === 0) rows.push(row);

  if (hasTrailing && rows.length >= 2 && rows[rows.length - 1].length === 1) {
    const trailingRow = rows.pop()!;
    rows[rows.length - 1] = [...rows[rows.length - 1], ...trailingRow];
  }
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

/** Deep-clones a measure's musical content with fresh ids (so the copy is a
 * fully independent measure, not sharing note/chord/lyric identities). */
export function cloneMeasure(measure: Measure): Measure {
  const cloneNotes = (notes: NoteEvent[]): NoteEvent[] =>
    notes.map((n) => ({ ...n, id: nextId('n'), pitches: n.pitches.map((p) => ({ ...p })) }));
  return {
    id: nextId('m'),
    treble: { notes: cloneNotes(measure.treble.notes) },
    bass: { notes: cloneNotes(measure.bass.notes) },
    chords: measure.chords.map((c) => ({ ...c, id: nextId('c') })),
    lyrics: measure.lyrics.map((l) => ({ ...l, id: nextId('ly') })),
    restMarks: (measure.restMarks ?? []).map((r) => ({ ...r, id: nextId('rm') })),
  };
}

/** Inserts a (freshly-cloned) measure right after the given index, shifting any manual line breaks after it. */
export function insertMeasureAfter(score: Score, measureIndex: number, measure: Measure): Score {
  const measures = [...score.measures];
  measures.splice(measureIndex + 1, 0, cloneMeasure(measure));
  const lineBreaks = score.lineBreaks.map((b) => (b > measureIndex ? b + 1 : b));
  return { ...score, measures, lineBreaks };
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
  manualAccidental: boolean,
): Score {
  return updateNoteInScore(score, location, (note) => {
    if (note.isRest) return note;
    const existingIndex = note.pitches.findIndex((p) => p.letter === letter && p.octave === octave);
    if (existingIndex >= 0) {
      if (note.pitches.length <= 1) return note;
      return { ...note, pitches: note.pitches.filter((_, i) => i !== existingIndex) };
    }
    return { ...note, pitches: [...note.pitches, { letter, accidental, octave, manualAccidental }] };
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
 * Adds an acciaccatura grace note (see NoteEvent.graceNote) to the note at
 * `location`, or removes it if that note already has one — a single click
 * (in 꾸밈음 mode) toggles it on/off rather than needing a separate delete
 * gesture. No-op on rests, which never carry a grace note.
 */
export function toggleGraceNote(score: Score, location: NoteLocation, letter: Pitch['letter'], octave: number): Score {
  return updateNoteInScore(score, location, (note) =>
    note.isRest ? note : { ...note, graceNote: note.graceNote ? undefined : { letter, octave } },
  );
}

/**
 * Toggles a grace note directly onto/off the note at `location`, at that
 * note's own top pitch — the one-click flow from pressing the 꾸밈음 toolbar
 * button while a note is already selected (see App's handleGraceNoteButton),
 * as opposed to toggleGraceNote's click-at-a-chosen-pitch flow (꾸밈음 mode).
 */
export function attachOrRemoveGraceNote(score: Score, location: NoteLocation): Score {
  return updateNoteInScore(score, location, (note) => {
    if (note.isRest) return note;
    if (note.graceNote) return { ...note, graceNote: undefined };
    const top = note.pitches[topPitchIndex(note.pitches)];
    if (!top) return note;
    return { ...note, graceNote: { letter: top.letter, octave: top.octave, position: 'before' } };
  });
}

/** Removes the grace note at `location`, if any — used by Delete on a selected grace note. */
export function removeGraceNote(score: Score, location: NoteLocation): Score {
  return updateNoteInScore(score, location, (note) => (note.graceNote ? { ...note, graceNote: undefined } : note));
}

/** Flips a grace note between leading into its host note (before, the
 * default acciaccatura) and trailing off it (after, a nachschlag-style
 * grace note leaning toward the next note). */
export function toggleGraceNotePosition(score: Score, location: NoteLocation): Score {
  return updateNoteInScore(score, location, (note) =>
    note.graceNote ? { ...note, graceNote: { ...note.graceNote, position: note.graceNote.position === 'after' ? 'before' : 'after' } } : note,
  );
}

/** Sets a grace note's pitch directly (see App's handleStepGracePitch for diatonic stepping). */
export function setGraceNotePitch(score: Score, location: NoteLocation, letter: Pitch['letter'], octave: number, accidental: Accidental): Score {
  return updateNoteInScore(score, location, (note) =>
    note.graceNote ? { ...note, graceNote: { ...note.graceNote, letter, octave, accidental } } : note,
  );
}

/**
 * Finds the note immediately following `location` in the same clef, crossing
 * into the next measure(s) if the current one has no more notes. Used for
 * tie/slur connections, which always join to "the next note in the staff"
 * regardless of measure boundaries. Returns null at the end of the score.
 */
export function nextNoteLocation(score: Score, location: NoteLocation): NoteLocation | null {
  const sameMeasureNext = score.measures[location.measureIndex]?.[location.clef].notes[location.noteIndex + 1];
  if (sameMeasureNext) return { ...location, noteIndex: location.noteIndex + 1 };
  for (let mi = location.measureIndex + 1; mi < score.measures.length; mi++) {
    const notes = score.measures[mi][location.clef].notes;
    if (notes.length > 0) return { measureIndex: mi, clef: location.clef, noteIndex: 0 };
  }
  return null;
}

/**
 * Detaches one pitch of a chord into its own new note: the original note
 * keeps its position and remaining pitches, and the detached pitch becomes
 * an independent note (same duration/dot) inserted right after it, at the
 * given pitch and free-x position. Used when a narrowed chord tone is
 * dragged away — it splits off instead of hauling the whole chord along.
 * Returns the new note's index so the caller can select it.
 */
export function splitPitchFromNote(
  score: Score,
  location: NoteLocation,
  pitchIndex: number,
  newPitch: Pitch,
  x?: number,
): { score: Score; noteIndex: number } {
  const newIndex = location.noteIndex + 1;
  const updated = updateMeasure(score, location.measureIndex, location.clef, (sm) => {
    const note = sm.notes[location.noteIndex];
    if (!note || note.pitches.length <= 1) return sm;
    const notes = [...sm.notes];
    notes[location.noteIndex] = { ...note, pitches: note.pitches.filter((_, i) => i !== pitchIndex) };
    notes.splice(newIndex, 0, createNote([newPitch], note.duration, note.dotted, false, x));
    return { notes };
  });
  return { score: updated, noteIndex: newIndex };
}

/**
 * Merges one note's pitches into another note in the same staff — dragging a
 * separate note onto an existing one to form a chord — and removes the
 * now-redundant source note. A pitch that would exactly duplicate one
 * already in the target is skipped. Returns the merged note's new index
 * (the array shifts by one once the source is removed, if it came first).
 */
export function mergeNoteIntoChord(
  score: Score,
  location: NoteLocation,
  targetNoteIndex: number,
  movedPitches: Pitch[],
): { score: Score; noteIndex: number } {
  const updated = updateMeasure(score, location.measureIndex, location.clef, (sm) => {
    const target = sm.notes[targetNoteIndex];
    if (!target) return sm;
    const existingKeys = new Set(target.pitches.map(pitchToVexKey));
    const mergedPitches = [...target.pitches, ...movedPitches.filter((p) => !existingKeys.has(pitchToVexKey(p)))];
    const notes = sm.notes
      .map((n, i) => (i === targetNoteIndex ? { ...n, pitches: mergedPitches } : n))
      .filter((_, i) => i !== location.noteIndex);
    return { notes };
  });
  const noteIndex = targetNoteIndex > location.noteIndex ? targetNoteIndex - 1 : targetNoteIndex;
  return { score: updated, noteIndex };
}

/**
 * After deleting the note at `deletedIndex` (list length was `oldLength`),
 * which index should become selected: the previous (left) note if one
 * exists, otherwise the note that shifted into its place (the old right
 * neighbor), otherwise none.
 */
export function adjacentIndexAfterDelete(deletedIndex: number, oldLength: number): number | null {
  const newLength = oldLength - 1;
  if (newLength <= 0) return null;
  // The note that was to the right shifts into the deleted slot — prefer it;
  // deleting the last note has none, so fall back to the new last (old left).
  if (deletedIndex < newLength) return deletedIndex;
  return deletedIndex - 1;
}
