export type Clef = 'treble' | 'bass';

/** VexFlow-style duration codes (without dot). */
export type DurationValue = 'w' | 'h' | 'q' | '8' | '16' | '32';

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
   * 셋잇단음표 (triplet): when true, this note's actual sounding/beat-capacity
   * duration is 2/3 of what `duration`/`dotted` alone would say — the
   * standard "3 in the time of 2" ratio (see scoreUtils' noteBeats/
   * TUPLET_RATIO). Purely a per-note flag: the renderer groups consecutive
   * tupleted notes of matching duration into runs of 3 for the bracket (see
   * vexflowRenderer's tuplet grouping), but nothing here enforces group size —
   * an incomplete run (not a multiple of 3) still sounds/exports correctly,
   * it just won't get a bracket.
   */
  tuplet?: boolean;
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
   * (see App's `selectedGrace`) for pitch/duration/position edits and
   * deletion — arrow keys mirror a main note's (up/down = pitch, left/right
   * = duration; see App's keydown handler). `duration` defaults to '8' (the
   * standard single-flag acciaccatura shape) when unset.
   */
  graceNote?: { letter: Pitch['letter']; octave: number; accidental?: Accidental; position?: 'before' | 'after'; duration?: DurationValue };
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
  /** Horizontal position within the measure, 0 (start) .. 1 (end). Freely draggable — purely cosmetic, does not affect which notes the chord harmonically covers (see startNoteIndex/startNoteClef). */
  offset: number;
  /** The melody note (by index within the SAME measure's startNoteClef staff) this chord starts harmonically applying from, for scale-degree computation (see activeChordAt) — chosen via the chord's "적용 시작 음표 선택" UI. When unset, falls back to the offset-derived beat (legacy behavior), so old scores without this field keep working. */
  startNoteIndex?: number;
  startNoteClef?: Clef;
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

/**
 * A purely visual rest marker (see #187) — lets a rest be sketched in on top
 * of an already-full staff (where a real NoteEvent can't fit any more beats)
 * as a small annotation glyph. Deliberately NOT a NoteEvent: it carries no
 * duration, isn't part of the note sequence, and is ignored by playback,
 * beat-capacity checks, and MusicXML/MIDI export — true second-voice
 * polyphony (a real overlapping rest that plays/exports) is a much larger,
 * separate effort than this lightweight overlay covers.
 */
export interface RestMark {
  id: string;
  clef: Clef;
  /** Horizontal position within the measure, 0 (start) .. 1 (end). */
  offset: number;
  /** Vertical staff line position — same units as scoreUtils.pitchToLine. */
  line: number;
  /** Which rest glyph is drawn (whole/half/quarter/8th/16th) — set once at
   * placement time from whichever duration was armed on the toolbar. */
  duration: DurationValue;
  /**
   * On-screen visual size multiplier for the glyph, completely independent of
   * `duration` — dragging one of the selected mark's 4 corner handles changes
   * THIS, not the rest type. Undefined = 1 (normal size).
   */
  scale?: number;
}

export interface Measure {
  id: string;
  treble: StaffMeasure;
  bass: StaffMeasure;
  /** Chord symbols shown above the measure. */
  chords: ChordSymbol[];
  /** Lyric syllables shown in the band between the treble and bass staves. */
  lyrics: LyricSyllable[];
  /** Visual-only rest annotations layered over existing notes (see RestMark / #187). */
  restMarks: RestMark[];
  /**
   * Temporarily overrides `Score.timeSignature` for just this ONE measure
   * (e.g. a 6/8 piece with a single 3/8 bar mid-song) — the next measure
   * reverts to the score's normal time signature unless it carries its own
   * override too. Set/cleared via Toolbar's "이 마디만 박자 변경" control
   * (see App's handleSetMeasureTimeSignature / scoreUtils' measureTimeSignature).
   * Undefined = use the score's time signature, same as every other measure.
   */
  timeSignatureOverride?: TimeSignature;
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
  /**
   * Hand-typed overrides for individual notes' scale-degree labels, set via
   * 도수 입력 모드 (see App's degreeInputMode). Keyed the same way
   * computeScaleDegreeLabels keys its output map: `${clef}:${measureIndex}:${noteIndex}:${pitchIndex}`.
   * A value of '' means "force-hide" (suppress whatever computeScaleDegreeLabels
   * would have auto-computed there); any other string replaces it outright.
   * Applied as a final overlay on top of the auto-computed labels, independent
   * of whether an active chord actually produced one.
   */
  manualScaleDegreeLabels?: Record<string, string>;
}

/**
 * A note's interval from the currently-active chord's root, named the way a
 * lead-sheet player would read it. '3'/'7' auto-alternate their displayed
 * text (b3/3, 7/세모7) by which exact semitone the note lands on — see
 * scoreUtils' DEGREE_TABLE — so checking "3" or "7" covers both qualities at
 * once. 'dim7' and '6' both name the same semitone (a diminished 7th is
 * enharmonic to a major 6th); when 'dim7' is checked it takes precedence.
 *
 * The extended/altered tensions ('9', '#9', '11', '#11', '13', 'b13') are
 * jazz-lead-sheet ALTERNATE SPELLINGS for a semitone that already has a
 * plain triad-tone label — '9' is the same pitch class as '2', '#9' the same
 * as 'b3' (part of '3'), '11' the same as '4', '#11' the same as 'b5', '13'
 * the same as '6', and 'b13' the same as '#5'. They exist as their own
 * checkboxes (see SCALE_DEGREE_LABELS) so a note can be labeled with
 * whichever reading fits the context (e.g. a chord's extension vs. its
 * altered fifth), independent of the plain-tone checkbox for that same
 * semitone — see DEGREE_TABLE for which labels share a slot.
 */
export type ScaleDegreeLabel =
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | 'b5'
  | '#5'
  | 'b9'
  | 'dim7'
  | '9'
  | '#9'
  | '11'
  | '#11'
  | '13'
  | 'b13';

export interface NoteLocation {
  measureIndex: number;
  clef: Clef;
  noteIndex: number;
}
