import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import './App.css';
import { StaffEditor } from './components/StaffEditor';
import { Toolbar, type EditTool } from './components/Toolbar';
import type { Clef, DurationValue, NoteLocation, Pitch, Score } from './types/score';
import {
  addChordToScoreAt,
  addLineBreak,
  addLyricsToScoreAt,
  addMeasure,
  addNoteToScore,
  adjacentIndexAfterDelete,
  connectNoteTo,
  createEmptyScore,
  createNote,
  editChordText,
  editLyricText,
  moveChordInScore,
  moveLyricInScore,
  noteConnects,
  removeChordFromScore,
  removeLyricFromScore,
  removeMeasure,
  removeNoteFromScore,
  togglePitchInNote,
  toggleConnectToNext,
  updateNoteInScore,
} from './lib/scoreUtils';
import { exportMusicXml } from './lib/exportMusicXml';
import { exportMidi } from './lib/exportMidi';
import { downloadBlob, loadAutosave, printScorePdf, readScoreFile, saveAutosave, saveScoreJson } from './lib/fileIO';
import { playScore, type PlaybackHandle } from './lib/playback';
import { SaveDialog, type SaveFormat } from './components/SaveDialog';

const DEFAULT_EDIT_TOOL: EditTool = { duration: 'q', dotted: false, isRest: false, accidental: '' };

function App() {
  const [score, setScore] = useState<Score>(() => loadAutosave() ?? createEmptyScore());
  const [selected, setSelected] = useState<NoteLocation | null>(null);
  const [editTool, setEditTool] = useState<EditTool>(DEFAULT_EDIT_TOOL);
  const [, setFocusedMeasureIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playingMeasure, setPlayingMeasure] = useState<number | null>(null);
  const [playbackClock, setPlaybackClock] = useState<{ get: () => number } | null>(null);
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
    (
      measureIndex: number,
      clef: Clef,
      letter: string,
      octave: number,
      insertIndex: number,
      durationOverride?: DurationValue,
      x?: number,
    ) => {
      const pitch: Pitch = { letter: letter as Pitch['letter'], accidental: editTool.accidental, octave };
      const note = createNote([pitch], durationOverride ?? editTool.duration, editTool.dotted, editTool.isRest, x);
      const result = addNoteToScore(score, measureIndex, clef, note, insertIndex);
      if (result.overflow) {
        window.alert('마디가 가득 찼습니다. "마디 추가" 버튼으로 새 마디를 만들어주세요.');
        return;
      }
      setScore(result.score);
      setSelected({ measureIndex, clef, noteIndex: result.noteIndex });
    },
    [score, editTool],
  );

  const handleMoveNote = useCallback((location: NoteLocation, letter: string, octave: number, x?: number) => {
    setScore((prev) =>
      updateNoteInScore(prev, location, (note) => ({
        ...note,
        pitches: [{ letter: letter as Pitch['letter'], accidental: note.pitches[0]?.accidental ?? '', octave }],
        x: x ?? note.x,
      })),
    );
  }, []);

  const handleChangeDuration = useCallback((location: NoteLocation, duration: DurationValue) => {
    setScore((prev) => updateNoteInScore(prev, location, (note) => ({ ...note, duration })));
  }, []);

  const handleTogglePitch = useCallback(
    (location: NoteLocation, letter: string, octave: number) => {
      setScore((prev) => togglePitchInNote(prev, location, letter as Pitch['letter'], editTool.accidental, octave));
    },
    [editTool.accidental],
  );

  const handleFocusMeasure = useCallback((measureIndex: number) => {
    setFocusedMeasureIndex(measureIndex);
  }, []);

  const handleDeselectNote = useCallback(() => {
    setSelected(null);
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

  /** Always removes the last measure — the FAB's "－" is a fixed end-of-score action, not tied to selection. */
  const handleDeleteLastMeasure = useCallback(() => {
    if (score.measures.length <= 1) return;
    const target = score.measures.length - 1;
    setScore((prev) => removeMeasure(prev, target));
    setSelected((sel) => (sel && sel.measureIndex === target ? null : sel));
    setFocusedMeasureIndex((foc) => (foc === target ? null : foc));
  }, [score.measures.length]);

  const handleToggleConnect = useCallback(() => {
    if (!selected) return;
    setScore((prev) => toggleConnectToNext(prev, selected));
  }, [selected]);

  const handleConnectNote = useCallback((source: NoteLocation, targetId: string) => {
    setScore((prev) => connectNoteTo(prev, source, targetId));
  }, []);

  const handleSetTitle = useCallback((title: string) => {
    setScore((prev) => ({ ...prev, title }));
  }, []);

  const handleSetComposer = useCallback((composer: string) => {
    setScore((prev) => ({ ...prev, composer }));
  }, []);

  const handleAddChordAt = useCallback((measureIndex: number, text: string, offset: number) => {
    setScore((prev) => addChordToScoreAt(prev, measureIndex, text, offset));
  }, []);

  const handleEditChordText = useCallback((measureIndex: number, chordId: string, text: string) => {
    setScore((prev) => editChordText(prev, measureIndex, chordId, text));
  }, []);

  const handleMoveChord = useCallback((measureIndex: number, chordId: string, offset: number) => {
    setScore((prev) => moveChordInScore(prev, measureIndex, chordId, offset));
  }, []);

  const handleDeleteChord = useCallback((measureIndex: number, chordId: string) => {
    setScore((prev) => removeChordFromScore(prev, measureIndex, chordId));
  }, []);

  const handleAddLyricAt = useCallback((measureIndex: number, text: string, offset: number) => {
    setScore((prev) => addLyricsToScoreAt(prev, measureIndex, text, offset));
  }, []);

  const handleEditLyricText = useCallback((measureIndex: number, lyricId: string, text: string) => {
    setScore((prev) => editLyricText(prev, measureIndex, lyricId, text));
  }, []);

  const handleMoveLyric = useCallback(
    (fromMeasureIndex: number, lyricId: string, offset: number, toMeasureIndex: number) => {
      setScore((prev) => moveLyricInScore(prev, fromMeasureIndex, lyricId, offset, toMeasureIndex));
    },
    [],
  );

  const handleDeleteLyric = useCallback((measureIndex: number, lyricId: string) => {
    setScore((prev) => removeLyricFromScore(prev, measureIndex, lyricId));
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
        setPlaybackClock(null);
        playbackRef.current = null;
      },
    );
    playbackRef.current = handle;
    setPlaybackClock({ get: handle.getSeconds });
  }, [score, isPlaying]);

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
    (filename: string, format: SaveFormat) => {
      setSaveOpen(false);
      if (format === 'json') void saveScoreJson(score, filename);
      else printScorePdf(filename);
    },
    [score],
  );

  const handleLoadJson = useCallback((file: File) => {
    readScoreFile(file)
      .then((loaded) => {
        setScore(loaded);
        setSelected(null);
        setFocusedMeasureIndex(null);
      })
      .catch(() => window.alert('악보 파일을 읽을 수 없습니다.'));
  }, []);

  const selectedNote = selected ? score.measures[selected.measureIndex][selected.clef].notes[selected.noteIndex] : null;

  const handleLoadFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) handleLoadJson(file);
    event.target.value = '';
  };

  return (
    <div className="app">
      <div className="app-header">
        <h1 className="app-title">피아노 악보 편집기</h1>
        <div className="quick-actions">
          {isPlaying ? (
            <button className="play-button" onClick={handleStop} aria-label="정지" title="정지">
              ⏹
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
        </div>
      </div>
      <Toolbar
        score={score}
        onScoreMetaChange={handleScoreMetaChange}
        editTool={editTool}
        onEditToolChange={handleEditToolChange}
        hasSelection={!!selected}
        onDeleteSelected={handleDeleteSelected}
        connectActive={selectedNote ? noteConnects(selectedNote) : false}
        canConnect={!!selected && !selectedNote?.isRest}
        onToggleConnect={handleToggleConnect}
        onExportMusicXml={handleExportMusicXml}
        onExportMidi={handleExportMidi}
      />
      <div className="status-line">
        {isPlaying
          ? `재생 중… ${playingMeasure !== null ? playingMeasure + 1 : 1}번 마디`
          : '오선보 위의 제목·작곡가·코드·가사를 클릭해 직접 입력하세요. 음표는 클릭으로 입력, 드래그로 이동, 우클릭으로 삭제할 수 있습니다.'}
      </div>
      <StaffEditor
        score={score}
        selected={selected}
        editTool={editTool}
        onSelectNote={handleSelectNote}
        onAddNote={handleAddNote}
        onDeleteNote={deleteNoteAndSelectAdjacent}
        onMoveNote={handleMoveNote}
        onTogglePitch={handleTogglePitch}
        onChangeDuration={handleChangeDuration}
        onFocusMeasure={handleFocusMeasure}
        onAddLineBreak={handleAddLineBreak}
        onMoveChord={handleMoveChord}
        onDeleteChord={handleDeleteChord}
        onMoveLyric={handleMoveLyric}
        onDeleteLyric={handleDeleteLyric}
        onDeselectNote={handleDeselectNote}
        onConnectNote={handleConnectNote}
        onSetTitle={handleSetTitle}
        onSetComposer={handleSetComposer}
        onAddChordAt={handleAddChordAt}
        onEditChordText={handleEditChordText}
        onAddLyricAt={handleAddLyricAt}
        onEditLyricText={handleEditLyricText}
        playbackClock={playbackClock}
      />
      <div className="measure-fabs">
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
        <SaveDialog defaultName={score.title} onCancel={() => setSaveOpen(false)} onSave={handleSaveConfirm} />
      )}
    </div>
  );
}

export default App;
