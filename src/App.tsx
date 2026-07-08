import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import './App.css';
import { StaffEditor, type StaffEditorHandle } from './components/StaffEditor';
import { Toolbar, MoreMenu, type EditTool } from './components/Toolbar';
import type { Accidental, ChordQuality, Clef, DurationValue, Measure, NoteEvent, NoteLocation, Pitch, Score } from './types/score';
import {
  addChordToScore,
  addChordToScoreAt,
  addLineBreak,
  addLyricsToScoreAt,
  addMeasure,
  addNoteToScore,
  adjacentIndexAfterDelete,
  CHORD_QUALITY_SUFFIX,
  createEmptyMeasure,
  createEmptyScore,
  createNote,
  editChordText,
  editLyricText,
  insertMeasureAfter,
  keySignatureAccidentalFor,
  lineToPitch,
  measureCapacityBeats,
  mergeNoteIntoChord,
  moveChordInScore,
  moveLyricInScore,
  nextId,
  nextNoteLocation,
  noteBeats,
  pitchToLine,
  pitchToVexKey,
  removeChordFromScore,
  removeLyricFromScore,
  removeMeasure,
  removeNoteFromScore,
  splitPitchFromNote,
  togglePitchInNote,
  updateNoteInScore,
} from './lib/scoreUtils';
import { exportMusicXml } from './lib/exportMusicXml';
import { exportMidi } from './lib/exportMidi';
import { downloadBlob, loadAutosave, readScoreFile, saveAutosave, saveScorePdf, saveScoreJson } from './lib/fileIO';
import { playScore, type PlaybackHandle } from './lib/playback';
import { SaveDialog, type SaveFormat } from './components/SaveDialog';

const DEFAULT_EDIT_TOOL: EditTool = { duration: 'q', dotted: false, isRest: false, accidental: '' };

/** Ordered shortest -> longest, interleaving dotted values, for arrow-key duration stepping. */
const DURATION_LADDER: { duration: DurationValue; dotted: boolean }[] = [
  { duration: '16', dotted: false },
  { duration: '16', dotted: true },
  { duration: '8', dotted: false },
  { duration: '8', dotted: true },
  { duration: 'q', dotted: false },
  { duration: 'q', dotted: true },
  { duration: 'h', dotted: false },
  { duration: 'h', dotted: true },
  { duration: 'w', dotted: false },
];

const UNDO_HISTORY_LIMIT = 100;

function App() {
  const [score, setScoreRaw] = useState<Score>(() => loadAutosave() ?? createEmptyScore());
  const [selected, setSelected] = useState<NoteLocation | null>(null);
  // Narrows a chord (multi-pitch note) selection to one specific pitch —
  // clicking an already-selected chord's specific notehead again sets this;
  // clicking a different note or deselecting always clears it back to null.
  const [selectedPitchIndex, setSelectedPitchIndex] = useState<number | null>(null);
  // Toggled by re-clicking the active duration button while nothing is
  // selected (Toolbar's "새 음표 배치" highlight toggle). While true and no
  // note is selected, clicking the staff prefers selecting the nearest
  // existing note over adding a new one (see StaffEditor). Reset to false
  // whenever a note becomes selected or the duration actually changes.
  const [selectMode, setSelectMode] = useState(false);
  const [editTool, setEditTool] = useState<EditTool>(DEFAULT_EDIT_TOOL);
  // True while an accidental button was pressed with nothing selected — a
  // "one-shot" pen, not a persistent toggle: the very next note it touches
  // (existing note clicked, chord tone toggled, or brand-new note placed)
  // consumes it and it clears back to false/'' immediately after.
  const [accidentalArmed, setAccidentalArmed] = useState(false);
  // Same one-shot arming as accidentalArmed, but for the rest button: pressed
  // with nothing selected, it arms turning the next note it touches into a
  // rest of that note's own duration, then clears immediately after.
  const [restArmed, setRestArmed] = useState(false);
  // "C키 기준 임시표": when true (default), new/moved notes auto-inherit the
  // accidental the current key signature implies relative to C major — e.g.
  // placing a plain B in F major automatically shows/sounds as Bb. An
  // explicit accidental the user picks always overrides this. Turning the
  // toggle off also strips the auto flat/sharp from existing notes (see
  // handleToggleCKeyBasedAccidentals below) — a manually-chosen accidental
  // is indistinguishable from an auto one once baked in, so any note whose
  // stored accidental exactly matches what the key signature would have
  // implied is treated as auto and cleared; playback is unaffected since it
  // always falls back to the key signature (see effectiveAccidental).
  const [cKeyBasedAccidentals, setCKeyBasedAccidentals] = useState(true);
  const [focusedMeasureIndex, setFocusedMeasureIndex] = useState<number | null>(null);
  // In-memory clipboard for measure copy/paste (한 마디 통째 복사 → 붙여넣기).
  const [copiedMeasure, setCopiedMeasure] = useState<Measure | null>(null);
  // Notes multi-selected via shift+drag rubber-band, and a note clipboard for
  // batch copy (Ctrl+C) / paste (Ctrl+V) of those notes.
  const [marquee, setMarquee] = useState<NoteLocation[]>([]);
  const [noteClipboard, setNoteClipboard] = useState<{ clef: Clef; note: NoteEvent }[]>([]);
  // When a marquee selection spans multiple measures, Ctrl+C copies whole
  // measures instead (see handleCopyNotes) — pasting a flat run of several
  // measures' worth of notes into one target measure would badly overflow
  // it, so multi-measure copies pastes as new measures instead.
  const [measureClipboard, setMeasureClipboard] = useState<Measure[]>([]);
  // True while StaffEditor holds a locked placement preview — App's own arrow
  // and spacebar handlers yield to the preview's movement/commit when set.
  const previewLockedRef = useRef(false);
  // True right after a note is placed via the click-to-lock flow, as long as
  // it's still the selection — lets Left/Right chain into placing the NEXT
  // note (via StaffEditor's openAdjacentPreview) instead of editing this
  // one's duration. Cleared by any selection change that isn't that chain.
  const justPlacedRef = useRef(false);
  // Two separate "+/-" reveal toggles: one inline at the end of the score
  // (always operates on the very last measure), one floating bottom-right
  // that follows scroll (always operates on the currently focused measure,
  // so it can insert/delete in the middle of the score).
  const [endFabOpen, setEndFabOpen] = useState(false);
  const [midFabOpen, setMidFabOpen] = useState(false);
  // Beat position of the draggable "start playback here" seek bar (0 = very start).
  const [playbackStartBeat, setPlaybackStartBeat] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playingMeasure, setPlayingMeasure] = useState<number | null>(null);
  const [playbackClock, setPlaybackClock] = useState<{ get: () => number } | null>(null);
  const playbackRef = useRef<PlaybackHandle | null>(null);
  const staffEditorRef = useRef<StaffEditorHandle>(null);

  // Undo/redo history. Every setScore call (the wrapper below, used
  // everywhere else in this file) pushes the pre-change score onto the undo
  // stack, so Ctrl+Z can step back through edits one at a time.
  const scoreRef = useRef(score);
  scoreRef.current = score;
  const undoStackRef = useRef<Score[]>([]);
  const redoStackRef = useRef<Score[]>([]);

  const setScore = useCallback((updater: Score | ((prev: Score) => Score)) => {
    setScoreRaw((prev) => {
      const next = typeof updater === 'function' ? (updater as (p: Score) => Score)(prev) : updater;
      if (next === prev) return prev;
      undoStackRef.current.push(prev);
      if (undoStackRef.current.length > UNDO_HISTORY_LIMIT) undoStackRef.current.shift();
      redoStackRef.current = [];
      return next;
    });
  }, []);

  const handleUndo = useCallback(() => {
    const prevState = undoStackRef.current.pop();
    if (prevState === undefined) return;
    redoStackRef.current.push(scoreRef.current);
    setScoreRaw(prevState);
    setSelected(null);
    setSelectedPitchIndex(null);
  }, []);

  const handleRedo = useCallback(() => {
    const nextState = redoStackRef.current.pop();
    if (nextState === undefined) return;
    undoStackRef.current.push(scoreRef.current);
    setScoreRaw(nextState);
    setSelected(null);
    setSelectedPitchIndex(null);
  }, []);

  useEffect(() => {
    saveAutosave(score);
  }, [score]);

  const deleteNoteAndSelectAdjacent = useCallback(
    (location: NoteLocation) => {
      const note = score.measures[location.measureIndex][location.clef].notes[location.noteIndex];
      // A narrowed chord tone (selectedPitchIndex set — see handleSelectNote)
      // deletes just that one pitch, leaving the rest of the chord in place,
      // instead of removing the whole note.
      if (
        note &&
        selected &&
        selected.measureIndex === location.measureIndex &&
        selected.clef === location.clef &&
        selected.noteIndex === location.noteIndex &&
        selectedPitchIndex !== null &&
        note.pitches.length > 1
      ) {
        setScore((prev) =>
          updateNoteInScore(prev, location, (n) => ({
            ...n,
            pitches: n.pitches.filter((_, i) => i !== selectedPitchIndex),
          })),
        );
        setSelectedPitchIndex(null);
        return;
      }
      const oldLength = score.measures[location.measureIndex][location.clef].notes.length;
      const adjacent = adjacentIndexAfterDelete(location.noteIndex, oldLength);
      setScore((prev) => removeNoteFromScore(prev, location));
      setSelected(adjacent === null ? null : { measureIndex: location.measureIndex, clef: location.clef, noteIndex: adjacent });
      setSelectedPitchIndex(null);
    },
    [score, selected, selectedPitchIndex, setScore],
  );

  const handleScoreMetaChange = useCallback((patch: Partial<Score>) => {
    setScore((prev) => ({ ...prev, ...patch }));
  }, [setScore]);

  const handleSelectNote = useCallback(
    (location: NoteLocation, pitchIndex?: number) => {
      setSelected(location);
      setSelectedPitchIndex(pitchIndex ?? null);
      setMarquee([]);
      justPlacedRef.current = false;
      const note = score.measures[location.measureIndex][location.clef].notes[location.noteIndex];
      if (note) {
        if (accidentalArmed) {
          // A one-shot accidental was armed (button pressed with nothing
          // selected) — this click consumes it on the note (or its narrowed
          // pitch) instead of just selecting it, then the arming clears.
          const armedAccidental = editTool.accidental;
          setScore((prev) =>
            updateNoteInScore(prev, location, (n) => {
              const narrowedIndex = n.pitches.length > 1 ? pitchIndex ?? null : null;
              return {
                ...n,
                pitches: n.pitches.map((p, i) =>
                  narrowedIndex === null || i === narrowedIndex ? { ...p, accidental: armedAccidental, manualAccidental: true } : p,
                ),
              };
            }),
          );
          setAccidentalArmed(false);
        }
        if (restArmed) {
          // A one-shot rest was armed (button pressed with nothing selected)
          // — this click converts the note into a rest of its own duration.
          setScore((prev) => updateNoteInScore(prev, location, (n) => ({ ...n, isRest: true, pitches: [] })));
          setRestArmed(false);
        }
        const pitch = pitchIndex !== undefined ? note.pitches[pitchIndex] : note.pitches[0];
        // duration/dotted are NOT synced here — they're a "pen" that only
        // changes when the user explicitly presses those buttons (see the
        // decoupling in handleEditToolChange), not whenever a note happens
        // to be selected/clicked.
        setEditTool((prev) => ({
          ...prev,
          isRest: restArmed ? false : note.isRest,
          accidental: accidentalArmed ? '' : pitch?.accidental ?? '',
        }));
      }
    },
    [score, accidentalArmed, editTool.accidental, restArmed, setScore],
  );

  const handleAddNote = useCallback(
    (
      measureIndex: number,
      clef: Clef,
      letter: string,
      octave: number,
      insertIndex: number,
      durationOverride?: DurationValue,
      x?: number,
    ) => {
      // Only an explicitly-armed accidental (button pressed with nothing
      // selected) counts as the user's choice for a brand-new note/tone —
      // editTool.accidental also gets set just to reflect the CURRENTLY
      // SELECTED note's own accidental for display, and reusing that stale
      // value here used to leak it onto an unrelated new chord tone.
      const explicitAccidental = accidentalArmed ? editTool.accidental : '';
      const accidental =
        explicitAccidental || !cKeyBasedAccidentals
          ? explicitAccidental
          : keySignatureAccidentalFor(letter as Pitch['letter'], score.keySignature);
      const pitch: Pitch = { letter: letter as Pitch['letter'], accidental, octave, manualAccidental: !!explicitAccidental };
      const note = createNote([pitch], durationOverride ?? editTool.duration, editTool.dotted, editTool.isRest, x);
      const result = addNoteToScore(score, measureIndex, clef, note, insertIndex);
      if (result.overflow) {
        window.alert('마디가 가득 찼습니다. "마디 추가" 버튼으로 새 마디를 만들어주세요.');
        return;
      }
      setScore(result.score);
      setSelected({ measureIndex, clef, noteIndex: result.noteIndex });
      setSelectedPitchIndex(null);
      setMarquee([]);
      // This note is now eligible to chain into the next one via Left/Right
      // (see justPlacedRef) — cleared as soon as the selection moves away
      // from it through any other path.
      justPlacedRef.current = true;
      // One-shot: a newly placed note consumes the armed accidental/rest, so
      // it doesn't silently keep applying to every note placed after it.
      if (editTool.accidental || editTool.isRest) {
        setEditTool((prev) => ({ ...prev, accidental: '', isRest: false }));
      }
      setAccidentalArmed(false);
      setRestArmed(false);
    },
    [score, editTool, cKeyBasedAccidentals, accidentalArmed, setScore],
  );

  /**
   * `deltaLine` is how many staff-line units the drag moved (see
   * StaffEditor's `startLine`/`pitchAt`). With no `pitchIndex` (the whole
   * chord selected), every pitch shifts by the same amount so dragging one
   * doesn't collapse the note down to a single pitch (which used to silently
   * drop the other chord tones). With a `pitchIndex` (one specific pitch
   * narrowed via a second click — see handleSelectNote), that pitch SPLITS
   * OFF into its own note at the drop position — the chord is one note with
   * one shared x, so merely repitching in place would still drag the whole
   * chord sideways; the other tones must stay put at the original spot.
   */
  /** Recomputes the accidental for a pitch after a drag repositions it: a
   * changed letter almost certainly invalidates whatever accidental it had
   * (a C# dragged onto D shouldn't silently become a D#), so re-derive from
   * the key signature (respecting "C키 기준 임시표") like a fresh placement —
   * this always produces an auto (non-manual) accidental, since the specific
   * choice a manual accidental represented no longer applies to the new
   * letter. An octave-only move (same letter) keeps the pitch's existing
   * accidental AND manual/auto status as-is. */
  const accidentalAfterMove = useCallback(
    (
      oldLetter: Pitch['letter'],
      oldAccidental: Accidental,
      oldManual: boolean | undefined,
      newLetter: Pitch['letter'],
    ): { accidental: Accidental; manual: boolean } => {
      if (newLetter === oldLetter) return { accidental: oldAccidental, manual: !!oldManual };
      if (!cKeyBasedAccidentals) return { accidental: '', manual: false };
      return { accidental: keySignatureAccidentalFor(newLetter, score.keySignature), manual: false };
    },
    [cKeyBasedAccidentals, score.keySignature],
  );

  const handleMoveNote = useCallback((location: NoteLocation, deltaLine: number, x?: number, pitchIndex?: number | null) => {
    const note = score.measures[location.measureIndex][location.clef].notes[location.noteIndex];
    if (!note) return;
    if (pitchIndex !== undefined && pitchIndex !== null && note.pitches.length > 1) {
      // A pure horizontal drag (no pitch change) just nudges that notehead's
      // x within the chord — it must NOT detach into a new note, since that
      // would silently add a whole extra beat to the measure (and can push
      // it into overflow) for what the user meant as a cosmetic reposition.
      // Splitting into an independent note only makes sense when the pitch
      // itself actually changes (a real voice-separation move).
      if (deltaLine === 0) {
        setScore((prev) => updateNoteInScore(prev, location, (n) => ({ ...n, x: x ?? n.x })));
        return;
      }
      const p = note.pitches[pitchIndex];
      if (!p) return;
      const line = pitchToLine(location.clef, p.letter, p.octave) + deltaLine;
      const { letter, octave } = lineToPitch(location.clef, line);
      const { accidental, manual } = accidentalAfterMove(p.letter, p.accidental, p.manualAccidental, letter as Pitch['letter']);
      const result = splitPitchFromNote(
        score,
        location,
        pitchIndex,
        { ...p, letter: letter as Pitch['letter'], octave, accidental, manualAccidental: manual },
        x ?? note.x,
      );
      setScore(result.score);
      setSelected({ measureIndex: location.measureIndex, clef: location.clef, noteIndex: result.noteIndex });
      setSelectedPitchIndex(null);
      return;
    }
    setScore((prev) =>
      updateNoteInScore(prev, location, (n) => ({
        ...n,
        pitches: n.pitches.map((pitch) => {
          const line = pitchToLine(location.clef, pitch.letter, pitch.octave) + deltaLine;
          const { letter, octave } = lineToPitch(location.clef, line);
          const { accidental, manual } = accidentalAfterMove(pitch.letter, pitch.accidental, pitch.manualAccidental, letter as Pitch['letter']);
          return { ...pitch, letter: letter as Pitch['letter'], octave, accidental, manualAccidental: manual };
        }),
        x: x ?? n.x,
      })),
    );
  }, [score, setScore, accidentalAfterMove]);

  /**
   * Dragging one whole note onto another existing note in the same staff
   * merges them into a single chord instead of leaving two notes visually
   * overlapping but still rhythmically separate — the dragged note's pitches
   * (shifted by the same deltaLine a normal move would apply) join the
   * target's pitches, and the now-redundant source note is removed.
   */
  const handleMergeNoteIntoChord = useCallback(
    (location: NoteLocation, targetNoteIndex: number, deltaLine: number) => {
      const note = score.measures[location.measureIndex][location.clef].notes[location.noteIndex];
      if (!note) return;
      const movedPitches = note.pitches.map((pitch) => {
        const line = pitchToLine(location.clef, pitch.letter, pitch.octave) + deltaLine;
        const { letter, octave } = lineToPitch(location.clef, line);
        const { accidental, manual } = accidentalAfterMove(pitch.letter, pitch.accidental, pitch.manualAccidental, letter as Pitch['letter']);
        return { ...pitch, letter: letter as Pitch['letter'], octave, accidental, manualAccidental: manual };
      });
      const result = mergeNoteIntoChord(score, location, targetNoteIndex, movedPitches);
      setScore(result.score);
      setSelected({ measureIndex: location.measureIndex, clef: location.clef, noteIndex: result.noteIndex });
      setSelectedPitchIndex(null);
    },
    [score, setScore, accidentalAfterMove],
  );

  const handleChangeDuration = useCallback((location: NoteLocation, duration: DurationValue) => {
    setScore((prev) => updateNoteInScore(prev, location, (note) => ({ ...note, duration })));
  }, [setScore]);

  const handleTogglePitch = useCallback(
    (location: NoteLocation, letter: string, octave: number) => {
      const explicitAccidental = accidentalArmed ? editTool.accidental : '';
      setScore((prev) => {
        const accidental =
          explicitAccidental || !cKeyBasedAccidentals
            ? explicitAccidental
            : keySignatureAccidentalFor(letter as Pitch['letter'], prev.keySignature);
        return togglePitchInNote(prev, location, letter as Pitch['letter'], accidental, octave, !!explicitAccidental);
      });
      // One-shot: this added/toggled chord tone consumes the armed accidental.
      if (editTool.accidental) setEditTool((prev) => ({ ...prev, accidental: '' }));
      setAccidentalArmed(false);
    },
    [editTool.accidental, cKeyBasedAccidentals, accidentalArmed, setScore],
  );

  /** Toggling "C키 기준 임시표" adds/removes the key-signature-implied
   * flat/sharp on every non-manual pitch: turning it on sets each such
   * pitch's accidental to what the key signature implies for its letter
   * (e.g. B -> Bb in F major), turning it off clears it back to ''. A pitch
   * whose accidental was explicitly chosen via the accidental toolbar
   * buttons (manualAccidental) is never touched either way. Sound is
   * unaffected regardless: playback always falls back to the key signature
   * for non-explicit accidentals (see effectiveAccidental). */
  const handleToggleCKeyBasedAccidentals = useCallback(() => {
    setCKeyBasedAccidentals((wasOn) => {
      const turningOn = !wasOn;
      const restyle = (p: Pitch): Pitch => {
        if (p.manualAccidental) return p;
        const accidental = turningOn ? keySignatureAccidentalFor(p.letter, score.keySignature) : '';
        return { ...p, accidental };
      };
      setScore((prev) => ({
        ...prev,
        measures: prev.measures.map((measure) => ({
          ...measure,
          treble: { notes: measure.treble.notes.map((n) => ({ ...n, pitches: n.pitches.map(restyle) })) },
          bass: { notes: measure.bass.notes.map((n) => ({ ...n, pitches: n.pitches.map(restyle) })) },
        })),
      }));
      return turningOn;
    });
  }, [setScore, score.keySignature]);

  const handleFocusMeasure = useCallback((measureIndex: number) => {
    setFocusedMeasureIndex(measureIndex);
  }, []);

  /** Sets (or clears, when finger is null) the fingering number on the selected
   * note's pitch — the narrowed pitch if one is picked out, else the primary. */
  const handleSetFinger = useCallback(
    (finger: number | null) => {
      if (!selected) return;
      setScore((prev) =>
        updateNoteInScore(prev, selected, (note) => {
          if (note.isRest || note.pitches.length === 0) return note;
          const targetIndex = selectedPitchIndex !== null && note.pitches.length > 1 ? selectedPitchIndex : 0;
          return {
            ...note,
            pitches: note.pitches.map((p, i) =>
              i === targetIndex ? { ...p, finger: finger ?? undefined } : p,
            ),
          };
        }),
      );
    },
    [selected, selectedPitchIndex, setScore],
  );

  /** Step the selected note's duration one notch longer (dir=+1) or shorter
   * (dir=-1) through the full dotted+plain ladder (16 -> 16. -> 8 -> 8. -> …). */
  const handleStepDuration = useCallback(
    (dir: 1 | -1) => {
      if (!selected) return;
      setScore((prev) =>
        updateNoteInScore(prev, selected, (note) => {
          const idx = DURATION_LADDER.findIndex((s) => s.duration === note.duration && s.dotted === note.dotted);
          if (idx < 0) return note;
          const next = DURATION_LADDER[Math.min(DURATION_LADDER.length - 1, Math.max(0, idx + dir))];
          return { ...note, duration: next.duration, dotted: next.dotted };
        }),
      );
    },
    [selected, setScore],
  );

  /** Nudge the selected note's pitch one diatonic step up (dir=+1) or down
   * (dir=-1) in place — arrow-key editing of a placed note, decoupled from the
   * toolbar. A chord narrowed to one pitch re-pitches only that pitch (without
   * detaching it, unlike a drag); otherwise the whole note moves together. A
   * changed letter re-derives its accidental from the key signature. */
  const handleStepPitch = useCallback(
    (dir: 1 | -1) => {
      if (!selected) return;
      const delta = dir * 0.5;
      setScore((prev) =>
        updateNoteInScore(prev, selected, (note) => {
          if (note.isRest) return note;
          const narrowed = note.pitches.length > 1 ? selectedPitchIndex : null;
          const pitches = note.pitches.map((pitch, i) => {
            if (narrowed !== null && i !== narrowed) return pitch;
            const line = pitchToLine(selected.clef, pitch.letter, pitch.octave) + delta;
            const { letter, octave } = lineToPitch(selected.clef, line);
            const { accidental, manual } = accidentalAfterMove(pitch.letter, pitch.accidental, pitch.manualAccidental, letter as Pitch['letter']);
            return { ...pitch, letter: letter as Pitch['letter'], octave, accidental, manualAccidental: manual };
          });
          return { ...note, pitches };
        }),
      );
    },
    [selected, selectedPitchIndex, setScore, accidentalAfterMove],
  );

  /** Ctrl+C: copy the marquee selection. A selection confined to a single
   * measure copies its notes (in reading order) to the flat note clipboard,
   * pasted as a run. A selection spanning multiple measures copies those
   * whole measures instead — see handlePasteNotes for why. */
  const handleCopyNotes = useCallback(() => {
    if (marquee.length === 0) return;
    const measureIndices = [...new Set(marquee.map((l) => l.measureIndex))].sort((a, b) => a - b);
    if (measureIndices.length > 1) {
      const first = measureIndices[0];
      const last = measureIndices[measureIndices.length - 1];
      const measures = score.measures.slice(first, last + 1);
      setMeasureClipboard(measures);
      setNoteClipboard([]);
      return;
    }
    setMeasureClipboard([]);
    const ordered = [...marquee].sort(
      (a, b) => a.measureIndex - b.measureIndex || (a.clef === b.clef ? a.noteIndex - b.noteIndex : a.clef === 'treble' ? -1 : 1),
    );
    const copied = ordered
      .map((loc) => {
        const note = score.measures[loc.measureIndex]?.[loc.clef].notes[loc.noteIndex];
        return note ? { clef: loc.clef, note } : null;
      })
      .filter((x): x is { clef: Clef; note: NoteEvent } => x !== null);
    setNoteClipboard(copied);
  }, [marquee, score]);

  /** Ctrl+V: if the clipboard holds whole measures (a multi-measure marquee
   * copy), insert fresh clones of them one after another STARTING AT the
   * focused (or last) measure — i.e. right before it, so the pasted content
   * begins at the exact measure the user clicked rather than the one after
   * it — pushing that measure (and everything after) later. This never gets
   * flattened/crammed into one target measure and overflows it. Otherwise,
   * append the copied notes to the focused (or last) measure, each into its
   * original clef, in order — connections and free-x are dropped so the
   * pasted run lays out cleanly. */
  const handlePasteNotes = useCallback(() => {
    if (measureClipboard.length > 0) {
      const target = focusedMeasureIndex ?? score.measures.length - 1;
      setScore((prev) => {
        let next = prev;
        let insertAt = target - 1;
        measureClipboard.forEach((measure) => {
          next = insertMeasureAfter(next, insertAt, measure);
          insertAt += 1;
        });
        return next;
      });
      return;
    }
    if (noteClipboard.length === 0) return;
    const target = focusedMeasureIndex ?? score.measures.length - 1;
    setScore((prev) => {
      const measures = prev.measures.map((m, i) => {
        if (i !== target) return m;
        const treble = [...m.treble.notes];
        const bass = [...m.bass.notes];
        noteClipboard.forEach(({ clef, note }) => {
          const clone: NoteEvent = {
            id: nextId('note'),
            pitches: note.pitches.map((p) => ({ ...p })),
            duration: note.duration,
            dotted: note.dotted,
            isRest: note.isRest,
          };
          (clef === 'treble' ? treble : bass).push(clone);
        });
        return { ...m, treble: { notes: treble }, bass: { notes: bass } };
      });
      return { ...prev, measures };
    });
  }, [measureClipboard, noteClipboard, focusedMeasureIndex, score.measures.length, setScore]);

  /** Delete/Backspace with a marquee selection removes every selected note.
   * Notes are removed highest-noteIndex-first (within each measure/clef) so
   * deleting one doesn't shift the still-pending indices of the others. */
  const handleDeleteMarquee = useCallback(() => {
    if (marquee.length === 0) return;
    const ordered = [...marquee].sort((a, b) => b.noteIndex - a.noteIndex);
    setScore((prev) => ordered.reduce((s, loc) => removeNoteFromScore(s, loc), prev));
    setMarquee([]);
  }, [marquee, setScore]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
        return;
      }
      // Batch copy/paste of marquee-selected notes.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && marquee.length > 0) {
        e.preventDefault();
        handleCopyNotes();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && (noteClipboard.length > 0 || measureClipboard.length > 0)) {
        e.preventDefault();
        handlePasteNotes();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && (marquee.length > 0 || selected)) {
        e.preventDefault();
        if (marquee.length > 0) handleDeleteMarquee();
        else if (selected) deleteNoteAndSelectAdjacent(selected);
        return;
      }
      // A locked placement preview owns the arrow keys (moves the preview) —
      // yield to StaffEditor's own handler in that case.
      if (previewLockedRef.current && e.key.startsWith('Arrow')) return;
      // Arrow keys edit the selected note (decoupled from the toolbar):
      // up/down change pitch, left/right change duration.
      if (selected && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        handleStepPitch(e.key === 'ArrowUp' ? 1 : -1);
        return;
      }
      if (selected && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        // Right after placing a note (still selected, untouched since), Left/
        // Right instead opens a new placement preview next to it — chains
        // into continuous keyboard-only note entry (place, Right, place, …)
        // instead of editing the just-placed note's duration.
        if (justPlacedRef.current) {
          const opened = staffEditorRef.current?.openAdjacentPreview(selected, e.key === 'ArrowRight' ? 1 : -1);
          if (opened) return;
        }
        handleStepDuration(e.key === 'ArrowRight' ? 1 : -1);
        return;
      }
      // Tab/Shift+Tab jump straight to the start of the next/previous measure
      // (same clef and pitch) instead of arrow-stepping through the rest of
      // the current one — handy once a measure is done and you want to keep
      // placing notes right into the next.
      if (selected && e.key === 'Tab') {
        e.preventDefault();
        const targetMeasure = selected.measureIndex + (e.shiftKey ? -1 : 1);
        if (targetMeasure >= 0) staffEditorRef.current?.openMeasurePreview(selected, targetMeasure);
        return;
      }
      // Fingering: with a note selected, a digit sets its fingering (0 clears).
      if (selected && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        handleSetFinger(e.key === '0' ? null : Number(e.key));
        return;
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selected, marquee, noteClipboard, measureClipboard, deleteNoteAndSelectAdjacent, handleDeleteMarquee, handleUndo, handleRedo, handleStepDuration, handleStepPitch, handleSetFinger, handleCopyNotes, handlePasteNotes]);

  /**
   * Toolbar chord-builder ("+ 코드 추가"): if a chord text box is currently
   * open on the score (the user clicked the chord band to add/edit one),
   * fills that box in place instead of creating a separate chord elsewhere.
   * Otherwise adds a chord built from the root+quality pair to whichever
   * measure was last focused (or the first one, initially). Builds plain-
   * ASCII text (e.g. "D#m7") rather than a prettified label — the add path
   * (and the inline editor's own commit) re-derives the structured root/
   * quality by parsing this text the same way free-text chord entry does,
   * and parseChordText's patterns only match ASCII '#'/'b', not the ♯/♭
   * display symbols.
   */
  const handleAddChordTool = useCallback(
    (root: Pitch['letter'], accidental: Accidental, quality: ChordQuality) => {
      const text = `${root}${accidental}${CHORD_QUALITY_SUFFIX[quality]}`;
      if (staffEditorRef.current?.fillActiveChordEditor(text)) return;
      const measureIndex = focusedMeasureIndex ?? 0;
      setScore((prev) => addChordToScore(prev, measureIndex, text));
    },
    [focusedMeasureIndex, setScore],
  );

  const handleDeselectNote = useCallback(() => {
    setSelected(null);
    setSelectedPitchIndex(null);
    setMarquee([]);
    justPlacedRef.current = false;
  }, []);

  /** Commits a rubber-band multi-selection; a non-empty one supersedes the single selection. */
  const handleMarqueeSelect = useCallback((locations: NoteLocation[]) => {
    setMarquee(locations);
    justPlacedRef.current = false;
    if (locations.length > 0) {
      setSelected(null);
      setSelectedPitchIndex(null);
    }
  }, []);

  const handleAddLineBreak = useCallback((afterMeasureIndex: number) => {
    setScore((prev) => addLineBreak(prev, afterMeasureIndex));
  }, [setScore]);

  const handleEditToolChange = useCallback(
    (patch: Partial<EditTool>) => {
      // Clicking an accidental button while a note is selected is a one-shot
      // edit of that note, not a persistent "pen" like duration/dotted — the
      // toolbar resets to no-accidental right after applying it, so the next
      // unrelated new note placed elsewhere doesn't silently inherit it too.
      const isOneShotAccidental = !!selected && patch.accidental !== undefined;
      // isRest is NOT force-reset here the way accidental is: while a note
      // stays selected, editTool.isRest must keep faithfully mirroring that
      // note's true current state (so pressing the button again correctly
      // toggles it back) — resetting it immediately broke exactly that.
      // The "don't leak into unrelated new notes" concern is handled
      // separately in handleAddNote, which resets it right after a note is
      // actually created.
      setEditTool((prev) => ({
        ...prev,
        ...patch,
        ...(isOneShotAccidental ? { accidental: '' } : {}),
      }));
      if (patch.accidental !== undefined) {
        // No note selected yet — arm it as a one-shot pen instead of applying
        // immediately; the next note it touches (see handleSelectNote,
        // handleAddNote, handleTogglePitch) consumes and clears it.
        setAccidentalArmed(!selected && patch.accidental !== '');
      }
      if (patch.isRest !== undefined) {
        setRestArmed(!selected && patch.isRest);
      }
      if (!selected) return;
      // Duration and dotted are pen-only: pressing them sets what the NEXT
      // mouse click inserts and must NOT change the currently-selected note
      // (edit a placed note's length with ←/→ instead). Only rest and
      // accidental still apply to the selection.
      if (patch.isRest === undefined && patch.accidental === undefined) return;
      setScore((prev) =>
        updateNoteInScore(prev, selected, (note) => {
          const isRest = patch.isRest ?? note.isRest;
          let pitches = note.pitches;
          if (patch.accidental !== undefined && pitches.length > 0) {
            // A chord narrowed to one specific pitch (selectedPitchIndex set —
            // see handleSelectNote) should only have THAT pitch's accidental
            // changed, not every tone in the chord.
            const narrowedIndex = pitches.length > 1 ? selectedPitchIndex : null;
            pitches = pitches.map((p, i) =>
              narrowedIndex === null || i === narrowedIndex
                ? { ...p, accidental: patch.accidental!, manualAccidental: true }
                : p,
            );
          }
          if (!isRest && pitches.length === 0) {
            pitches = [
              selected.clef === 'treble'
                ? { letter: 'B', accidental: '', octave: 4 }
                : { letter: 'D', accidental: '', octave: 3 },
            ];
          }
          // duration/dotted deliberately left unchanged (pen-only).
          return { ...note, isRest, pitches };
        }),
      );
    },
    [selected, selectedPitchIndex, setScore],
  );

  const handleDeleteSelected = useCallback(() => {
    if (!selected) return;
    deleteNoteAndSelectAdjacent(selected);
  }, [selected, deleteNoteAndSelectAdjacent]);

  const selectedNote =
    selected && score.measures[selected.measureIndex]?.[selected.clef].notes[selected.noteIndex];

  /**
   * Info the connect (tie/slur) button needs to offer a pitch choice: which
   * of the selected note's pitches also appear in the next note (tie
   * candidates — ties always join matching pitches, so no choice is needed
   * when there's exactly one), plus the full pitch list (slurs let the user
   * pick any of them, since a slur doesn't require a pitch match).
   */
  const connectInfo =
    selected && selectedNote && !selectedNote.isRest
      ? (() => {
          const nextLoc = nextNoteLocation(score, selected);
          const nextNote = nextLoc && score.measures[nextLoc.measureIndex][nextLoc.clef].notes[nextLoc.noteIndex];
          const tieCandidates =
            nextNote && !nextNote.isRest
              ? selectedNote.pitches
                  .map((p, i) => (nextNote.pitches.some((np) => pitchToVexKey(np) === pitchToVexKey(p)) ? i : -1))
                  .filter((i) => i >= 0)
              : [];
          return { active: !!selectedNote.connectToNext, pitches: selectedNote.pitches, tieCandidates };
        })()
      : null;

  const handleSetConnection = useCallback(
    (kind: 'tie' | 'slur', pitchIndex: number) => {
      if (!selected) return;
      setScore((prev) =>
        updateNoteInScore(prev, selected, (note) => ({
          ...note,
          connectToNext: true,
          connectKind: kind,
          connectPitchIndex: pitchIndex,
        })),
      );
    },
    [selected, setScore],
  );

  const handleClearConnection = useCallback(() => {
    if (!selected) return;
    setScore((prev) =>
      updateNoteInScore(prev, selected, (note) => ({
        ...note,
        connectToNext: false,
        connectKind: undefined,
        connectPitchIndex: undefined,
      })),
    );
  }, [selected, setScore]);

  /** Always appends at the very end of the score — the end-of-score "+" is a fixed action, not tied to focus. */
  const handleAddMeasure = useCallback(() => {
    setScore((prev) => addMeasure(prev));
  }, [setScore]);

  /** Always removes the last measure — the end-of-score "－" is a fixed action, not tied to focus. */
  const handleDeleteLastMeasure = useCallback(() => {
    if (score.measures.length <= 1) return;
    const target = score.measures.length - 1;
    setScore((prev) => removeMeasure(prev, target));
    setSelected((sel) => (sel && sel.measureIndex === target ? null : sel));
    setSelectedPitchIndex(null);
    setFocusedMeasureIndex((foc) => (foc === target ? null : foc));
  }, [score.measures.length, setScore]);

  /** Inserts a blank measure right after the focused (or last) measure — the floating FAB's "+", for mid-score insertion. */
  const handleInsertMeasureAtFocused = useCallback(() => {
    const idx = focusedMeasureIndex ?? score.measures.length - 1;
    setScore((prev) => insertMeasureAfter(prev, idx, createEmptyMeasure()));
    setFocusedMeasureIndex(idx + 1);
  }, [focusedMeasureIndex, score.measures.length, setScore]);

  /** Removes the focused (or last) measure — the floating FAB's "－", for mid-score deletion. */
  const handleRemoveFocusedMeasure = useCallback(() => {
    if (score.measures.length <= 1) return;
    const target = focusedMeasureIndex ?? score.measures.length - 1;
    setScore((prev) => removeMeasure(prev, target));
    setSelected((sel) => (sel && sel.measureIndex === target ? null : sel));
    setSelectedPitchIndex(null);
    setFocusedMeasureIndex((foc) => (foc === target ? null : foc === null ? null : foc > target ? foc - 1 : foc));
  }, [focusedMeasureIndex, score.measures.length, setScore]);

  /** Copies the focused (or last) measure into an in-memory clipboard. */
  const handleCopyMeasure = useCallback(() => {
    const idx = focusedMeasureIndex ?? score.measures.length - 1;
    const measure = score.measures[idx];
    if (measure) setCopiedMeasure(measure);
  }, [focusedMeasureIndex, score.measures]);

  /** Pastes the clipboard measure as a new measure right after the focused (or last) one. */
  const handlePasteMeasure = useCallback(() => {
    if (!copiedMeasure) return;
    const idx = focusedMeasureIndex ?? score.measures.length - 1;
    setScore((prev) => insertMeasureAfter(prev, idx, copiedMeasure));
    setFocusedMeasureIndex(idx + 1);
  }, [copiedMeasure, focusedMeasureIndex, score.measures.length, setScore]);

  /**
   * Single button for both copy and paste (previously two separate FABs):
   * a plain click pastes if something is already copied, otherwise copies.
   * Copying something new once the clipboard is already full needs a
   * distinct gesture — long-press (touch) or right-click (desktop) always
   * force-copies the focused measure, matching the long-press language
   * already used elsewhere in this app (e.g. duration cycling).
   */
  const measureClipboardLongPressRef = useRef<number | null>(null);
  const measureClipboardLongPressFiredRef = useRef(false);

  const handleMeasureClipboardClick = useCallback(() => {
    if (measureClipboardLongPressFiredRef.current) {
      measureClipboardLongPressFiredRef.current = false;
      return;
    }
    if (copiedMeasure) handlePasteMeasure();
    else handleCopyMeasure();
  }, [copiedMeasure, handlePasteMeasure, handleCopyMeasure]);

  const handleMeasureClipboardPointerDown = useCallback(() => {
    measureClipboardLongPressFiredRef.current = false;
    measureClipboardLongPressRef.current = window.setTimeout(() => {
      measureClipboardLongPressFiredRef.current = true;
      handleCopyMeasure();
    }, 600);
  }, [handleCopyMeasure]);

  const clearMeasureClipboardLongPress = useCallback(() => {
    if (measureClipboardLongPressRef.current !== null) {
      window.clearTimeout(measureClipboardLongPressRef.current);
      measureClipboardLongPressRef.current = null;
    }
  }, []);

  const handleSetTitle = useCallback((title: string) => {
    setScore((prev) => ({ ...prev, title }));
  }, [setScore]);

  const handleSetComposer = useCallback((composer: string) => {
    setScore((prev) => ({ ...prev, composer }));
  }, [setScore]);

  const handleAddChordAt = useCallback((measureIndex: number, text: string, offset: number) => {
    setScore((prev) => addChordToScoreAt(prev, measureIndex, text, offset));
  }, [setScore]);

  const handleEditChordText = useCallback((measureIndex: number, chordId: string, text: string) => {
    setScore((prev) => editChordText(prev, measureIndex, chordId, text));
  }, [setScore]);

  const handleMoveChord = useCallback((measureIndex: number, chordId: string, offset: number) => {
    setScore((prev) => moveChordInScore(prev, measureIndex, chordId, offset));
  }, [setScore]);

  const handleDeleteChord = useCallback((measureIndex: number, chordId: string) => {
    setScore((prev) => removeChordFromScore(prev, measureIndex, chordId));
  }, [setScore]);

  const handleAddLyricAt = useCallback((measureIndex: number, text: string, offset: number) => {
    setScore((prev) => addLyricsToScoreAt(prev, measureIndex, text, offset));
  }, [setScore]);

  const handleEditLyricText = useCallback((measureIndex: number, lyricId: string, text: string) => {
    setScore((prev) => editLyricText(prev, measureIndex, lyricId, text));
  }, [setScore]);

  const handleMoveLyric = useCallback(
    (fromMeasureIndex: number, lyricId: string, offset: number, toMeasureIndex: number) => {
      setScore((prev) => moveLyricInScore(prev, fromMeasureIndex, lyricId, offset, toMeasureIndex));
    },
    [setScore],
  );

  const handleDeleteLyric = useCallback((measureIndex: number, lyricId: string) => {
    setScore((prev) => removeLyricFromScore(prev, measureIndex, lyricId));
  }, [setScore]);

  const handlePlay = useCallback(async () => {
    if (isPlaying) return;
    setIsPlaying(true);
    const handle = await playScore(
      score,
      (measureIndex) => setPlayingMeasure(measureIndex),
      () => {
        setIsPlaying(false);
        setPlayingMeasure(null);
        setPlaybackClock(null);
        playbackRef.current = null;
      },
      playbackStartBeat,
    );
    playbackRef.current = handle;
    setPlaybackClock({ get: handle.getSeconds });
  }, [score, isPlaying, playbackStartBeat]);

  /**
   * Pause: stops the sound but parks the seek bar on the note that was
   * playing (its onset), so pressing play/space resumes from there. Reads the
   * elapsed transport time BEFORE stopping (stop resets it to 0), converts to
   * beats, then snaps back to the most-recent note onset at or before it.
   */
  const handlePause = useCallback(() => {
    const elapsedSeconds = playbackClock ? playbackClock.get() : 0;
    const secondsPerBeat = 60 / score.tempo;
    const currentBeat = elapsedSeconds / secondsPerBeat;
    const measureBeats = measureCapacityBeats(score.timeSignature);
    let onset = 0;
    (['treble', 'bass'] as const).forEach((clef) => {
      score.measures.forEach((measure, mi) => {
        let t = mi * measureBeats;
        measure[clef].notes.forEach((n) => {
          if (t <= currentBeat + 1e-6 && t > onset) onset = t;
          t += noteBeats(n);
        });
      });
    });
    playbackRef.current?.stop();
    playbackRef.current = null;
    setIsPlaying(false);
    setPlayingMeasure(null);
    setPlaybackClock(null);
    setPlaybackStartBeat(onset);
  }, [playbackClock, score]);

  /** Stop: halts playback and rewinds the seek bar all the way to the start. */
  const handleStop = useCallback(() => {
    playbackRef.current?.stop();
    playbackRef.current = null;
    setIsPlaying(false);
    setPlayingMeasure(null);
    setPlaybackClock(null);
    setPlaybackStartBeat(0);
  }, []);

  // Spacebar toggles playback: plays from wherever the seek bar sits, and
  // pressing it again while playing pauses (parking the bar on the current
  // note — see handlePause). Ignored while typing in a field or on a button.
  useEffect(() => {
    const onSpace = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName)) return;
      if (e.code !== 'Space') return;
      // A locked placement preview claims spacebar to commit itself.
      if (previewLockedRef.current) return;
      e.preventDefault();
      if (isPlaying) handlePause();
      else void handlePlay();
    };
    document.addEventListener('keydown', onSpace);
    return () => document.removeEventListener('keydown', onSpace);
  }, [isPlaying, handlePlay, handlePause]);

  const handleExportMusicXml = useCallback(() => {
    const xml = exportMusicXml(score);
    downloadBlob(new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }), `${score.title || 'score'}.musicxml`);
  }, [score]);

  const handleExportMidi = useCallback(() => {
    downloadBlob(exportMidi(score), `${score.title || 'score'}.mid`);
  }, [score]);

  const [saveOpen, setSaveOpen] = useState(false);
  const handleOpenSave = useCallback(() => setSaveOpen(true), []);
  const handleSaveConfirm = useCallback(
    (format: SaveFormat) => {
      setSaveOpen(false);
      if (format === 'json') void saveScoreJson(score, score.title);
      else void saveScorePdf(score, score.title);
    },
    [score],
  );

  const handleLoadJson = useCallback((file: File) => {
    readScoreFile(file)
      .then((loaded) => {
        setScore(loaded);
        setSelected(null);
        setSelectedPitchIndex(null);
        setFocusedMeasureIndex(null);
      })
      .catch(() => window.alert('악보 파일을 읽을 수 없습니다.'));
  }, [setScore]);

  const handleLoadFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) handleLoadJson(file);
    event.target.value = '';
  };

  return (
    <div className="app">
      <div className="sticky-controls">
        <div className="app-header">
          <div className="quick-actions">
            {isPlaying ? (
              <button className="play-button" onClick={handlePause} aria-label="일시정지" title="일시정지 (연주하던 음표에서 멈춤)">
                ⏸
              </button>
            ) : (
              <button className="play-button" onClick={handlePlay} aria-label="재생" title="재생">
                ▶
              </button>
            )}
            <button
              className="play-button stop-button"
              onClick={handleStop}
              disabled={!isPlaying && playbackStartBeat === 0}
              aria-label="정지"
              title="정지 (처음으로 되감기)"
            >
              ⏹
            </button>
            <button className="quick-action-button" onClick={handleOpenSave} title="현재 악보를 파일로 저장합니다">
              💾 저장
            </button>
            <label className="file-input-label quick-action-button" title="저장했던 악보 파일(.json)을 불러옵니다">
              📂 불러오기
              <input type="file" accept="application/json" onChange={handleLoadFile} />
            </label>
            <MoreMenu onExportMusicXml={handleExportMusicXml} onExportMidi={handleExportMidi} />
          </div>
        </div>
        <Toolbar
          score={score}
          onScoreMetaChange={handleScoreMetaChange}
          editTool={editTool}
          onEditToolChange={handleEditToolChange}
          hasSelection={!!selected}
          onDeleteSelected={handleDeleteSelected}
          onDeselectNote={handleDeselectNote}
          connectInfo={connectInfo}
          onSetConnection={handleSetConnection}
          onClearConnection={handleClearConnection}
          selectMode={selectMode}
          onSetSelectMode={setSelectMode}
          onAddChord={handleAddChordTool}
          cKeyBasedAccidentals={cKeyBasedAccidentals}
          onToggleCKeyBasedAccidentals={handleToggleCKeyBasedAccidentals}
        />
      </div>
      <div className="status-line">
        {isPlaying
          ? `재생 중… ${playingMeasure !== null ? playingMeasure + 1 : 1}번 마디`
          : '음표는 클릭으로 입력, 드래그로 이동, 우클릭으로 삭제. 선택한 음표는 방향키로 편집(↑↓ 음높이, ←→ 길이). Shift+드래그로 여러 음표 선택 후 Ctrl+C·V로 복사/붙여넣기, Delete로 삭제. 위 단추는 다음에 입력할 음표를 정합니다.'}
      </div>
      <StaffEditor
        ref={staffEditorRef}
        score={score}
        selected={selected}
        selectedPitchIndex={selectedPitchIndex}
        marquee={marquee}
        onMarqueeSelect={handleMarqueeSelect}
        onPreviewLockChange={(v) => {
          previewLockedRef.current = v;
        }}
        noteSelectMode={selectMode}
        editTool={editTool}
        onSelectNote={handleSelectNote}
        onAddNote={handleAddNote}
        onDeleteNote={deleteNoteAndSelectAdjacent}
        onMoveNote={handleMoveNote}
        onMergeNoteIntoChord={handleMergeNoteIntoChord}
        onTogglePitch={handleTogglePitch}
        onChangeDuration={handleChangeDuration}
        onFocusMeasure={handleFocusMeasure}
        onAddLineBreak={handleAddLineBreak}
        onMoveChord={handleMoveChord}
        onDeleteChord={handleDeleteChord}
        onMoveLyric={handleMoveLyric}
        onDeleteLyric={handleDeleteLyric}
        onDeselectNote={handleDeselectNote}
        onSetTitle={handleSetTitle}
        onSetComposer={handleSetComposer}
        onAddChordAt={handleAddChordAt}
        onEditChordText={handleEditChordText}
        onAddLyricAt={handleAddLyricAt}
        onEditLyricText={handleEditLyricText}
        playbackClock={playbackClock}
        seekBeat={playbackStartBeat}
        onSeekBeat={setPlaybackStartBeat}
      />
      <div className="measure-end-toggle-row">
        <button
          className={`measure-end-toggle ${endFabOpen ? 'active' : ''}`}
          onClick={() => setEndFabOpen((v) => !v)}
          title="악보 끝에 마디 추가/삭제"
          aria-label="악보 끝 마디 추가/삭제"
        >
          마디 ±
        </button>
        {endFabOpen && (
          <>
            <button
              className="measure-end-toggle measure-end-toggle-remove"
              onClick={handleDeleteLastMeasure}
              disabled={score.measures.length <= 1}
              title="마지막 마디 삭제"
              aria-label="마지막 마디 삭제"
            >
              −
            </button>
            <button
              className="measure-end-toggle measure-end-toggle-add"
              onClick={handleAddMeasure}
              title="끝에 마디 추가"
              aria-label="끝에 마디 추가"
            >
              +
            </button>
          </>
        )}
      </div>
      <div className="measure-fabs">
        <button
          className="measure-fab measure-fab-clipboard"
          onClick={handleMeasureClipboardClick}
          onPointerDown={handleMeasureClipboardPointerDown}
          onPointerUp={clearMeasureClipboardLongPress}
          onPointerLeave={clearMeasureClipboardLongPress}
          onContextMenu={(e) => {
            e.preventDefault();
            handleCopyMeasure();
          }}
          title={
            copiedMeasure
              ? '클릭: 복사한 마디 붙여넣기 / 길게 누르거나 우클릭: 새로 복사'
              : `${(focusedMeasureIndex ?? score.measures.length - 1) + 1}번 마디 복사`
          }
          aria-label="마디 복사/붙여넣기"
        >
          {copiedMeasure ? '▤' : '⎘'}
        </button>
        {midFabOpen && (
          <>
            <button
              className="measure-fab measure-fab-mid-remove"
              onClick={handleRemoveFocusedMeasure}
              disabled={score.measures.length <= 1}
              title="선택한 마디 삭제"
              aria-label="선택한 마디 삭제"
            >
              −
            </button>
            <button
              className="measure-fab measure-fab-mid-add"
              onClick={handleInsertMeasureAtFocused}
              title="선택한 마디 뒤에 마디 삽입"
              aria-label="선택한 마디 뒤에 마디 삽입"
            >
              +
            </button>
          </>
        )}
        <button
          className={`measure-fab measure-fab-toggle ${midFabOpen ? 'active' : ''}`}
          onClick={() => setMidFabOpen((v) => !v)}
          title="중간에 마디 추가/삭제"
          aria-label="중간 마디 추가/삭제"
        >
          ±
        </button>
      </div>
      {saveOpen && (
        <SaveDialog onCancel={() => setSaveOpen(false)} onSave={handleSaveConfirm} />
      )}
    </div>
  );
}

export default App;
