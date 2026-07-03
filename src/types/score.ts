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
   * Connect to the next note in this staff with a curved line. The renderer
   * draws a tie (붙임줄) when the next note has the same pitch, otherwise a
   * slur (이음줄). Replaces the old separate tieToNext/slurToNext flags, which
   * are still read from older saved files.
   */
  connectToNext?: boolean;
  /** @deprecated Legacy tie flag, migrated to connectToNext on load. */
  tieToNext?: boolean;
  /** @deprecated Legacy slur flag, migrated to connectToNext on load. */
  slurToNext?: boolean;
  /**
   * Connects to an arbitrary other note (by id), set by dragging the small
   * connector handle that appears on a selected note onto the target — for
   * chords or out-of-sequence notes where "the next note" isn't the one you
   * want. Takes precedence over connectToNext when both are somehow set.
   */
  connectToId?: string;
  /**
   * Which pitch (index into this note's own `pitches`) the tie visually
   * starts from, when this note is a chord — set by dragging one of several
   * per-pitch connect handles. Undefined means "all pitches" (the default
   * whole-chord tie).
   */
  connectFromIndex?: number;
  /**
   * Which pitch (index into the TARGET note's `pitches`) the tie visually
   * ends at, when the target is a chord — set by where (vertically) the
   * connect-drag was dropped. Undefined means "all pitches".
   */
  connectToIndex?: number;
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
