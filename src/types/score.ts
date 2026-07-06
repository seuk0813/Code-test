export type Clef = 'treble' | 'bass';

/** VexFlow-style duration codes (without dot). */
export type DurationValue = 'w' | 'h' | 'q' | '8' | '16';

export type Accidental = '#' | 'b' | 'n' | '';

export interface Pitch {
  letter: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  accidental: Accidental;
  octave: number;
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
}

export interface NoteLocation {
  measureIndex: number;
  clef: Clef;
  noteIndex: number;
}
