import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import './App.css';
import { StaffEditor, type StaffEditorHandle } from './components/StaffEditor';
import { Toolbar, MoreMenu, type EditTool } from './components/Toolbar';
import type { Accidental, ChordQuality, Clef, DurationValue, Measure, NoteLocation, Pitch, Score } from './types/score';
import {
  addChordToScore,
  addChordToScoreAt,
  addLineBreak,
  addLyricsToScoreAt,
  addMeasure,
  addNoteToScore,
  adjacentIndexAfterDelete,
  CHORD_QUALITY_SUFFIX,
  createEmptyScore,
  createNote,
  editChordText,
  editLyricText,
  insertMeasureAfter,
  keySignatureAccidentalFor,
  lineToPitch,
  mergeNoteIntoChord,
  moveChordInScore,
  moveLyricInScore,
  nextNoteLocation,
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
  // explicit accidental the user picks always overrides this, and turning
  // the toggle off never touches accidentals already baked into existing
  // notes — it only stops applying to notes placed/moved from then on.
  const [cKeyBasedAccidentals, setCKeyBasedAccidentals] = useState(true);
  const [focusedMeasureIndex, setFocusedMeasureIndex] = useState<number | null>(null);
  // In-memory clipboard for measure copy/paste (한 마디 통째 복사 → 붙여넣기).
  const [copiedMeasure, setCopiedMeasure] = useState<Measure | null>(null);
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
                  narrowedIndex === null || i === narrowedIndex ? { ...p, accidental: armedAccidental } : p,
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
        setEditTool({
          duration: note.duration,
          dotted: note.dotted,
          isRest: restArmed ? false : note.isRest,
          accidental: accidentalArmed ? '' : pitch?.accidental ?? '',
        });
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
      const pitch: Pitch = { letter: letter as Pitch['letter'], accidental, octave };
      const note = createNote([pitch], durationOverride ?? editTool.duration, editTool.dotted, editTool.isRest, x);
      const result = addNoteToScore(score, measureIndex, clef, note, insertIndex);
      if (result.overflow) {
        window.alert('마디가 가득 찼습니다. "마디 추가" 버튼으로 새 마디를 만들어주세요.');
        return;
      }
      setScore(result.score);
      setSelected({ measureIndex, clef, noteIndex: result.noteIndex });
      setSelectedPitchIndex(null);
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
   * the key signature (respecting "C키 기준 임시표") like a fresh placement.
   * An octave-only move (same letter) keeps its existing accidental as-is. */
  const accidentalAfterMove = useCallback(
    (oldLetter: Pitch['letter'], oldAccidental: Accidental, newLetter: Pitch['letter']): Accidental => {
      if (newLetter === oldLetter) return oldAccidental;
      if (!cKeyBasedAccidentals) return '';
      return keySignatureAccidentalFor(newLetter, score.keySignature);
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
      const accidental = accidentalAfterMove(p.letter, p.accidental, letter as Pitch['letter']);
      const result = splitPitchFromNote(
        score,
        location,
        pitchIndex,
        { ...p, letter: letter as Pitch['letter'], octave, accidental },
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
          const accidental = accidentalAfterMove(pitch.letter, pitch.accidental, letter as Pitch['letter']);
          return { ...pitch, letter: letter as Pitch['letter'], octave, accidental };
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
        const accidental = accidentalAfterMove(pitch.letter, pitch.accidental, letter as Pitch['letter']);
        return { ...pitch, letter: letter as Pitch['letter'], octave, accidental };
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
        return togglePitchInNote(prev, location, letter as Pitch['letter'], accidental, octave);
      });
      // One-shot: this added/toggled chord tone consumes the armed accidental.
      if (editTool.accidental) setEditTool((prev) => ({ ...prev, accidental: '' }));
      setAccidentalArmed(false);
    },
    [editTool.accidental, cKeyBasedAccidentals, accidentalArmed, setScore],
  );

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
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        e.preventDefault();
        deleteNoteAndSelectAdjacent(selected);
        return;
      }
      if (selected && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        handleStepDuration(e.key === 'ArrowUp' ? 1 : -1);
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
  }, [selected, deleteNoteAndSelectAdjacent, handleUndo, handleRedo, handleStepDuration, handleSetFinger]);

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
              narrowedIndex === null || i === narrowedIndex ? { ...p, accidental: patch.accidental! } : p,
            );
          }
          if (!isRest && pitches.length === 0) {
            pitches = [
              selected.clef === 'treble'
                ? { letter: 'B', accidental: '', octave: 4 }
                : { letter: 'D', accidental: '', octave: 3 },
            ];
          }
          return {
            ...note,
            duration: patch.duration ?? note.duration,
            dotted: patch.dotted ?? note.dotted,
            isRest,
            pitches,
          };
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

  const handleAddMeasure = useCallback(() => {
    setScore((prev) => addMeasure(prev));
  }, [setScore]);

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

  /** Always removes the last measure — the FAB's "－" is a fixed end-of-score action, not tied to selection. */
  const handleDeleteLastMeasure = useCallback(() => {
    if (score.measures.length <= 1) return;
    const target = score.measures.length - 1;
    setScore((prev) => removeMeasure(prev, target));
    setSelected((sel) => (sel && sel.measureIndex === target ? null : sel));
    setSelectedPitchIndex(null);
    setFocusedMeasureIndex((foc) => (foc === target ? null : foc));
  }, [score.measures.length, setScore]);

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

  // Spacebar always starts playback from wherever the seek bar was last set
  // (dragging it only moves playbackStartBeat — it never plays by itself).
  useEffect(() => {
    const onSpacePlay = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName)) return;
      if (e.code !== 'Space') return;
      e.preventDefault();
      void handlePlay();
    };
    document.addEventListener('keydown', onSpacePlay);
    return () => document.removeEventListener('keydown', onSpacePlay);
  }, [handlePlay]);

  const handleStop = useCallback(() => {
    playbackRef.current?.stop();
    playbackRef.current = null;
    setIsPlaying(false);
    setPlayingMeasure(null);
    setPlaybackClock(null);
  }, []);

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
              <button className="play-button" onClick={handleStop} aria-label="일시정지" title="일시정지">
                ⏸
              </button>
            ) : (
              <button className="play-button" onClick={handlePlay} aria-label="재생" title="재생">
                ▶
              </button>
            )}
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
          onToggleCKeyBasedAccidentals={() => setCKeyBasedAccidentals((v) => !v)}
        />
      </div>
      <div className="status-line">
        {isPlaying
          ? `재생 중… ${playingMeasure !== null ? playingMeasure + 1 : 1}번 마디`
          : '오선보 위의 제목·작곡가·코드·가사를 클릭해 직접 입력하세요. 음표는 클릭으로 입력, 드래그로 이동, 우클릭으로 삭제할 수 있습니다.'}
      </div>
      <StaffEditor
        ref={staffEditorRef}
        score={score}
        selected={selected}
        selectedPitchIndex={selectedPitchIndex}
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
      <div className="measure-fabs">
        <button
          className="measure-fab measure-fab-copy"
          onClick={handleCopyMeasure}
          title={`${(focusedMeasureIndex ?? score.measures.length - 1) + 1}번 마디 복사`}
          aria-label="마디 복사"
        >
          ⎘
        </button>
        <button
          className="measure-fab measure-fab-paste"
          onClick={handlePasteMeasure}
          disabled={!copiedMeasure}
          title="복사한 마디를 뒤에 붙여넣기"
          aria-label="마디 붙여넣기"
        >
          ▤
        </button>
        <button
          className="measure-fab measure-fab-remove"
          onClick={handleDeleteLastMeasure}
          disabled={score.measures.length <= 1}
          title="마지막 마디 삭제"
          aria-label="마지막 마디 삭제"
        >
          −
        </button>
        <button className="measure-fab" onClick={handleAddMeasure} title="마디 추가" aria-label="마디 추가">
          +
        </button>
      </div>
      {saveOpen && (
        <SaveDialog onCancel={() => setSaveOpen(false)} onSave={handleSaveConfirm} />
      )}
    </div>
  );
}

export default App;
