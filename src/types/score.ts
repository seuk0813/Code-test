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
}

export interface StaffMeasure {
  notes: NoteEvent[];
}

export interface Measure {
  id: string;
  treble: StaffMeasure;
  bass: StaffMeasure;
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
}

export interface NoteLocation {
  measureIndex: number;
  clef: Clef;
  noteIndex: number;
}
