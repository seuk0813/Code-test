export type Clef = 'treble' | 'bass';

/** VexFlow-style duration codes (without dot). */
export type DurationValue = 'w' | 'h' | 'q' | '8' | '16';

export type Accidental = '#' | 'b' | 'n' | '';

export interface Pitch {
  letter: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  accidental: Accidental;
  octave: number;
  /** Optional fingering number (1-5) shown to the right of the notehead (and its accidental). */
  finger?: number;
  /**
   * True when this accidental was explicitly chosen by the user (an
   * accidental toolbar button pressed on a placed/selected note), as opposed
   * to auto-derived from the key signature. The "C키 기준 임시표" toggle only
   * ever adds/removes auto accidentals — a manual one is never touched.
   */
  manualAccidental?: boolean;
}

export interface NoteEvent {
  id: string;
  /** One pitch = single note, multiple = chord. Empty when isRest. */
  pitches: Pitch[];
  duration: DurationValue;
  dotted: boolean;
  isRest: boolean;
  /**
   * Free horizontal position within the measure's note area, 0 (start)..1 (end).
   * Set when a note is placed/dragged freely. Ignored (auto-formatted) once the
   * measure is filled to the time signature's capacity. Undefined = auto layout.
   */
  x?: number;
  /**
   * Connect to the next note in the same staff with a curved line — a tie
   * (붙임줄, same pitch) or a slur (이음줄, phrase mark). When set without
   * `connectKind` (older saved scores), the renderer falls back to
   * auto-detecting tie-vs-slur by comparing the whole chord's pitches.
   */
  connectToNext?: boolean;
  /** Which kind of curve `connectToNext` draws. See `connectToNext`. */
  connectKind?: 'tie' | 'slur';
  /**
   * Index into this note's `pitches` that anchors the connection — lets the
   * user pick which pitch in a chord to tie/slur instead of the renderer
   * guessing. Ties re-derive the matching pitch index in the next note by
   * key; slurs reuse this same index (clamped) on the next note's chord.
   */
  connectPitchIndex?: number | null;
  /**
   * A short acciaccatura ("crushed note") grace note played just before (or,
   * with `position: 'after'`, just after) this one — drawn small with a
   * slash through its stem, taking essentially no time from the beat, and
   * slurred to it. Toggled on/off by clicking an existing note while the
   * 꾸밈음 toolbar button is active, or by pressing that button with a note
   * already selected. Rests never carry one. Selectable in its own right
   * (see App's `selectedGrace`) for pitch/position edits and deletion.
   */
  graceNote?: { letter: Pitch['letter']; octave: number; accidental?: Accidental; position?: 'before' | 'after' };
}

/** Chord symbol quality (the part after the root, e.g. "m" in "Am"). */
export type ChordQuality =
  | 'maj'
  | 'min'
  | '7'
  | 'maj7'
  | 'min7'
  | 'dim'
  | 'aug'
  | 'sus2'
  | 'sus4'
  | 'm7b5'
  | 'dim7';

export interface ChordSymbol {
  id: string;
  root: Pitch['letter'];
  accidental: Accidental;
  quality: ChordQuality;
  /** Raw free-text label as typed. When set, shown verbatim instead of the parsed root/quality. */
  text?: string;
  /** Horizontal position within the measure, 0 (start) .. 1 (end). Freely draggable. */
  offset: number;
}

/** A single draggable lyric syllable placed in the band between the two staves. */
export interface LyricSyllable {
  id: string;
  text: string;
  /** Horizontal position within the measure, 0 (start) .. 1 (end). Freely draggable. */
  offset: number;
}

export interface StaffMeasure {
  notes: NoteEvent[];
}

export interface Measure {
  id: string;
  treble: StaffMeasure;
  bass: StaffMeasure;
  /** Chord symbols shown above the measure. */
  chords: ChordSymbol[];
  /** Lyric syllables shown in the band between the treble and bass staves. */
  lyrics: LyricSyllable[];
}

export interface TimeSignature {
  numerator: number;
  denominator: number;
}

export interface Score {
  title: string;
  composer: string;
  tempo: number;
  timeSignature: TimeSignature;
  keySignature: string;
  measures: Measure[];
  /** Measure indices after which a manual line break (new system) starts. */
  lineBreaks: number[];
  /**
   * 못갖춘마디 (anacrusis/pickup measure): when set, the FIRST measure is a
   * real, distinct Measure that spans exactly this many beats instead of the
   * full time-signature capacity — playback/seek don't pad it with trailing
   * silence, and it gets its own slot when grouping measures into rows (see
   * computeScoreRows: the first row holds the pickup plus up to 4 regular
   * measures). Set explicitly by the user — drag the seek bar to the desired
   * position inside the first measure, then press the "못갖춘마디" toggle,
   * which SPLITS whatever was in the first measure at that point into a
   * short pickup and a fresh normal measure holding the rest (see
   * splitPickupMeasure/clearPickupMeasure in scoreUtils). Always strictly
   * less than the time signature's capacity; undefined means no pickup.
   */
  pickupBeats?: number;
  /**
   * Mirrors `pickupBeats` at the other end of the piece: when set, the LAST
   * measure is a short, real, distinct closing measure spanning exactly this
   * many beats (see splitTrailingMeasure/clearTrailingMeasure). By classical
   * convention, `pickupBeats` and `trailingBeats` together should add up to
   * exactly one full measure's worth of beats — see pickupTrailingMismatch,
   * which flags it when they don't.
   */
  trailingBeats?: number;
  /**
   * When true, each row additionally shows a standalone melody staff above
   * the piano grand staff — chords above it, lyrics below it — mirroring the
   * top note of each treble chord (see deriveMelodyNotes). The piano staff
   * itself keeps its notes; this is a display-only lead-sheet-style layout
   * toggle, not a separate composition. Undefined/false = the original
   * layout (chords/lyrics directly on the piano treble staff).
   */
  showMelodyStaff?: boolean;
  /** When true, every note shows the scale degree it represents relative to
   * whichever chord symbol is currently active at its beat (see
   * scaleDegreeFor/activeChordAt in scoreUtils) — e.g. a D over a C chord
   * shows "2". Toggled from the key-signature "+" panel. */
  showScaleDegrees?: boolean;
  /** Which degree labels are shown when showScaleDegrees is on — see
   * SCALE_DEGREE_LABELS/DEFAULT_SCALE_DEGREE_LABELS in scoreUtils.
   * Undefined = the default set (the basic 7). */
  scaleDegreeLabels?: ScaleDegreeLabel[];
}

/**
 * A note's interval from the currently-active chord's root, named the way a
 * lead-sheet player would read it. '3'/'7' auto-alternate their displayed
 * text (b3/3, 7/세모7) by which exact semitone the note lands on — see
 * scoreUtils' DEGREE_TABLE — so checking "3" or "7" covers both qualities at
 * once. 'dim7' and '6' both name the same semitone (a diminished 7th is
 * enharmonic to a major 6th); when 'dim7' is checked it takes precedence.
 */
export type ScaleDegreeLabel = '1' | '2' | '3' | '4' | '5' | '6' | '7' | 'b5' | '#5' | 'b9' | 'dim7';

export interface NoteLocation {
  measureIndex: number;
  clef: Clef;
  noteIndex: number;
}
