import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import { StaffEditor } from './components/StaffEditor';
import { Toolbar, type ChordTool, type EditTool } from './components/Toolbar';
import type { Clef, NoteLocation, Pitch, Score } from './types/score';
import {
  addChordToScore,
  addLineBreak,
  addMeasure,
  addNoteToScore,
  adjacentIndexAfterDelete,
  createEmptyScore,
  createNote,
  moveChordInScore,
  removeChordFromScore,
  removeNoteFromScore,
  updateNoteInScore,
} from './lib/scoreUtils';
import { exportMusicXml } from './lib/exportMusicXml';
import { exportMidi } from './lib/exportMidi';
import { downloadBlob, downloadScoreJson, loadAutosave, readScoreFile, saveAutosave } from './lib/fileIO';
import { playScore, type PlaybackHandle } from './lib/playback';

const DEFAULT_EDIT_TOOL: EditTool = { duration: 'q', dotted: false, isRest: false, accidental: '' };
const DEFAULT_CHORD_TOOL: ChordTool = { root: 'C', accidental: '', quality: 'maj' };

function App() {
  const [score, setScore] = useState<Score>(() => loadAutosave() ?? createEmptyScore());
  const [selected, setSelected] = useState<NoteLocation | null>(null);
  const [editTool, setEditTool] = useState<EditTool>(DEFAULT_EDIT_TOOL);
  const [chordTool, setChordTool] = useState<ChordTool>(DEFAULT_CHORD_TOOL);
  const [focusedMeasureIndex, setFocusedMeasureIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playingMeasure, setPlayingMeasure] = useState<number | null>(null);
  const playbackRef = useRef<PlaybackHandle | null>(null);

  useEffect(() => {
    saveAutosave(score);
  }, [score]);

  const deleteNoteAndSelectAdjacent = useCallback(
    (location: NoteLocation) => {
      const oldLength = score.measures[location.measureIndex][location.clef].notes.length;
      const adjacent = adjacentIndexAfterDelete(location.noteIndex, oldLength);
      setScore((prev) => removeNoteFromScore(prev, location));
      setSelected(adjacent === null ? null : { measureIndex: location.measureIndex, clef: location.clef, noteIndex: adjacent });
    },
    [score],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        e.preventDefault();
        deleteNoteAndSelectAdjacent(selected);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selected, deleteNoteAndSelectAdjacent]);

  const handleScoreMetaChange = useCallback((patch: Partial<Score>) => {
    setScore((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleSelectNote = useCallback(
    (location: NoteLocation) => {
      setSelected(location);
      const note = score.measures[location.measureIndex][location.clef].notes[location.noteIndex];
      if (note) {
        setEditTool({
          duration: note.duration,
          dotted: note.dotted,
          isRest: note.isRest,
          accidental: note.pitches[0]?.accidental ?? '',
        });
      }
    },
    [score],
  );

  const handleAddNote = useCallback(
    (measureIndex: number, clef: Clef, letter: string, octave: number) => {
      const pitch: Pitch = { letter: letter as Pitch['letter'], accidental: editTool.accidental, octave };
      const note = createNote([pitch], editTool.duration, editTool.dotted, editTool.isRest);
      const result = addNoteToScore(score, measureIndex, clef, note);
      if (result.overflow) {
        window.alert('마디가 가득 찼습니다. "마디 추가" 버튼으로 새 마디를 만들어주세요.');
        return;
      }
      setScore(result.score);
      setSelected({ measureIndex, clef, noteIndex: result.noteIndex });
    },
    [score, editTool],
  );

  const handleMoveNote = useCallback((location: NoteLocation, letter: string, octave: number) => {
    setScore((prev) =>
      updateNoteInScore(prev, location, (note) => ({
        ...note,
        pitches: [{ letter: letter as Pitch['letter'], accidental: note.pitches[0]?.accidental ?? '', octave }],
      })),
    );
  }, []);

  const handleFocusMeasure = useCallback((measureIndex: number) => {
    setFocusedMeasureIndex(measureIndex);
  }, []);

  const handleAddLineBreak = useCallback((afterMeasureIndex: number) => {
    setScore((prev) => addLineBreak(prev, afterMeasureIndex));
  }, []);

  const handleEditToolChange = useCallback(
    (patch: Partial<EditTool>) => {
      setEditTool((prev) => ({ ...prev, ...patch }));
      if (!selected) return;
      setScore((prev) =>
        updateNoteInScore(prev, selected, (note) => {
          const isRest = patch.isRest ?? note.isRest;
          let pitches = note.pitches;
          if (patch.accidental !== undefined && pitches.length > 0) {
            pitches = pitches.map((p) => ({ ...p, accidental: patch.accidental! }));
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
    [selected],
  );

  const handleDeleteSelected = useCallback(() => {
    if (!selected) return;
    deleteNoteAndSelectAdjacent(selected);
  }, [selected, deleteNoteAndSelectAdjacent]);

  const handleAddMeasure = useCallback(() => {
    setScore((prev) => addMeasure(prev));
  }, []);

  const handleChordToolChange = useCallback((patch: Partial<ChordTool>) => {
    setChordTool((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleAddChord = useCallback(() => {
    if (focusedMeasureIndex === null) return;
    const result = addChordToScore(score, focusedMeasureIndex, chordTool.root, chordTool.accidental, chordTool.quality);
    if (result.overflow) {
      window.alert('한 마디에는 코드 기호를 최대 4개까지 추가할 수 있습니다.');
      return;
    }
    setScore(result.score);
  }, [score, focusedMeasureIndex, chordTool]);

  const handleMoveChord = useCallback((measureIndex: number, chordId: string, offset: number) => {
    setScore((prev) => moveChordInScore(prev, measureIndex, chordId, offset));
  }, []);

  const handleDeleteChord = useCallback((measureIndex: number, chordId: string) => {
    setScore((prev) => removeChordFromScore(prev, measureIndex, chordId));
  }, []);

  const handlePlay = useCallback(async () => {
    if (isPlaying) return;
    setIsPlaying(true);
    const handle = await playScore(
      score,
      (measureIndex) => setPlayingMeasure(measureIndex),
      () => {
        setIsPlaying(false);
        setPlayingMeasure(null);
        playbackRef.current = null;
      },
    );
    playbackRef.current = handle;
  }, [score, isPlaying]);

  const handleStop = useCallback(() => {
    playbackRef.current?.stop();
    playbackRef.current = null;
    setIsPlaying(false);
    setPlayingMeasure(null);
  }, []);

  const handleExportMusicXml = useCallback(() => {
    const xml = exportMusicXml(score);
    downloadBlob(new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }), `${score.title || 'score'}.musicxml`);
  }, [score]);

  const handleExportMidi = useCallback(() => {
    downloadBlob(exportMidi(score), `${score.title || 'score'}.mid`);
  }, [score]);

  const handleSaveJson = useCallback(() => {
    downloadScoreJson(score);
  }, [score]);

  const handleLoadJson = useCallback((file: File) => {
    readScoreFile(file)
      .then((loaded) => {
        setScore(loaded);
        setSelected(null);
        setFocusedMeasureIndex(null);
      })
      .catch(() => window.alert('악보 파일을 읽을 수 없습니다.'));
  }, []);

  const focusedMeasureChordCount =
    focusedMeasureIndex !== null && focusedMeasureIndex < score.measures.length
      ? score.measures[focusedMeasureIndex].chords.length
      : 0;

  return (
    <div className="app">
      <h1 className="app-title">피아노 악보 편집기</h1>
      <Toolbar
        score={score}
        onScoreMetaChange={handleScoreMetaChange}
        editTool={editTool}
        onEditToolChange={handleEditToolChange}
        hasSelection={!!selected}
        onDeleteSelected={handleDeleteSelected}
        onAddMeasure={handleAddMeasure}
        isPlaying={isPlaying}
        onPlay={handlePlay}
        onStop={handleStop}
        onExportMusicXml={handleExportMusicXml}
        onExportMidi={handleExportMidi}
        onSaveJson={handleSaveJson}
        onLoadJson={handleLoadJson}
        chordTool={chordTool}
        onChordToolChange={handleChordToolChange}
        focusedMeasureIndex={focusedMeasureIndex}
        focusedMeasureChordCount={focusedMeasureChordCount}
        onAddChord={handleAddChord}
      />
      <div className="status-line">
        {isPlaying
          ? `재생 중… ${playingMeasure !== null ? playingMeasure + 1 : 1}번 마디`
          : '오선보를 클릭해 음표를 입력하세요. 드래그로 이동, 우클릭으로 삭제할 수 있습니다.'}
      </div>
      <StaffEditor
        score={score}
        selected={selected}
        editTool={editTool}
        onSelectNote={handleSelectNote}
        onAddNote={handleAddNote}
        onDeleteNote={deleteNoteAndSelectAdjacent}
        onMoveNote={handleMoveNote}
        onFocusMeasure={handleFocusMeasure}
        onAddLineBreak={handleAddLineBreak}
        onMoveChord={handleMoveChord}
        onDeleteChord={handleDeleteChord}
      />
    </div>
  );
}

export default App;
