import type { ChangeEvent } from 'react';
import type { Accidental, ChordQuality, DurationValue, Pitch, Score } from '../types/score';
import { CHORD_QUALITY_LABELS, DURATION_LABELS, MAX_CHORDS_PER_MEASURE } from '../lib/scoreUtils';

const DURATIONS: DurationValue[] = ['w', 'h', 'q', '8', '16'];
const ACCIDENTALS: { value: Accidental; label: string }[] = [
  { value: '', label: '없음' },
  { value: '#', label: '♯' },
  { value: 'b', label: '♭' },
  { value: 'n', label: '♮' },
];
const KEY_SIGNATURES = ['C', 'G', 'D', 'A', 'E', 'F', 'Bb', 'Eb', 'Ab'];
const TIME_SIGNATURES: [number, number][] = [
  [4, 4],
  [3, 4],
  [2, 4],
];
const CHORD_ROOTS: Pitch['letter'][] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const CHORD_QUALITIES: ChordQuality[] = [
  'maj',
  'min',
  '7',
  'maj7',
  'min7',
  'dim',
  'aug',
  'sus2',
  'sus4',
  'm7b5',
  'dim7',
];

export interface EditTool {
  duration: DurationValue;
  dotted: boolean;
  isRest: boolean;
  accidental: Accidental;
}

export interface ChordTool {
  root: Pitch['letter'];
  accidental: Accidental;
  quality: ChordQuality;
}

interface ToolbarProps {
  score: Score;
  onScoreMetaChange: (patch: Partial<Score>) => void;
  editTool: EditTool;
  onEditToolChange: (patch: Partial<EditTool>) => void;
  hasSelection: boolean;
  onDeleteSelected: () => void;
  onAddMeasure: () => void;
  isPlaying: boolean;
  onPlay: () => void;
  onStop: () => void;
  onExportMusicXml: () => void;
  onExportMidi: () => void;
  onSaveJson: () => void;
  onLoadJson: (file: File) => void;
  chordTool: ChordTool;
  onChordToolChange: (patch: Partial<ChordTool>) => void;
  focusedMeasureIndex: number | null;
  focusedMeasureChordCount: number;
  onAddChord: () => void;
}

export function Toolbar({
  score,
  onScoreMetaChange,
  editTool,
  onEditToolChange,
  hasSelection,
  onDeleteSelected,
  onAddMeasure,
  isPlaying,
  onPlay,
  onStop,
  onExportMusicXml,
  onExportMidi,
  onSaveJson,
  onLoadJson,
  chordTool,
  onChordToolChange,
  focusedMeasureIndex,
  focusedMeasureChordCount,
  onAddChord,
}: ToolbarProps) {
  const handleLoadFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onLoadJson(file);
    event.target.value = '';
  };

  return (
    <div className="toolbar">
      <div className="toolbar-row">
        <input
          className="title-input"
          value={score.title}
          onChange={(e) => onScoreMetaChange({ title: e.target.value })}
          placeholder="악보 제목"
        />
        <input
          className="composer-input"
          value={score.composer}
          onChange={(e) => onScoreMetaChange({ composer: e.target.value })}
          placeholder="작곡가"
        />
        <label>
          박자
          <select
            value={`${score.timeSignature.numerator}/${score.timeSignature.denominator}`}
            onChange={(e) => {
              const [numerator, denominator] = e.target.value.split('/').map(Number);
              onScoreMetaChange({ timeSignature: { numerator, denominator } });
            }}
          >
            {TIME_SIGNATURES.map(([n, d]) => (
              <option key={`${n}/${d}`} value={`${n}/${d}`}>
                {n}/{d}
              </option>
            ))}
          </select>
        </label>
        <label>
          조표
          <select
            value={score.keySignature}
            onChange={(e) => onScoreMetaChange({ keySignature: e.target.value })}
          >
            {KEY_SIGNATURES.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label>
          템포
          <input
            type="number"
            min={20}
            max={300}
            value={score.tempo}
            onChange={(e) => onScoreMetaChange({ tempo: Number(e.target.value) })}
          />
          BPM
        </label>
      </div>

      <div className="toolbar-row">
        <span className="group-label">{hasSelection ? '선택한 음표 편집' : '입력 도구'}</span>
        {DURATIONS.map((d) => (
          <button
            key={d}
            className={editTool.duration === d ? 'active' : ''}
            onClick={() => onEditToolChange({ duration: d })}
            title={DURATION_LABELS[d]}
          >
            {DURATION_LABELS[d]}
          </button>
        ))}
        <button
          className={editTool.dotted ? 'active' : ''}
          onClick={() => onEditToolChange({ dotted: !editTool.dotted })}
        >
          점음표
        </button>
        <button
          className={editTool.isRest ? 'active' : ''}
          onClick={() => onEditToolChange({ isRest: !editTool.isRest })}
        >
          쉼표
        </button>
        {ACCIDENTALS.map((a) => (
          <button
            key={a.value || 'none'}
            className={editTool.accidental === a.value ? 'active' : ''}
            onClick={() => onEditToolChange({ accidental: a.value })}
          >
            {a.label}
          </button>
        ))}
        <button onClick={onDeleteSelected} disabled={!hasSelection}>
          선택 삭제
        </button>
        <button onClick={onAddMeasure}>마디 추가</button>
      </div>

      <div className="toolbar-row">
        <span className="group-label">코드 기호</span>
        <label>
          근음
          <select value={chordTool.root} onChange={(e) => onChordToolChange({ root: e.target.value as Pitch['letter'] })}>
            {CHORD_ROOTS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        {ACCIDENTALS.filter((a) => a.value !== 'n').map((a) => (
          <button
            key={a.value || 'none'}
            className={chordTool.accidental === a.value ? 'active' : ''}
            onClick={() => onChordToolChange({ accidental: a.value })}
          >
            {a.label}
          </button>
        ))}
        <label>
          종류
          <select
            value={chordTool.quality}
            onChange={(e) => onChordToolChange({ quality: e.target.value as ChordQuality })}
          >
            {CHORD_QUALITIES.map((q) => (
              <option key={q} value={q}>
                {CHORD_QUALITY_LABELS[q]}
              </option>
            ))}
          </select>
        </label>
        <button onClick={onAddChord} disabled={focusedMeasureIndex === null || focusedMeasureChordCount >= MAX_CHORDS_PER_MEASURE}>
          코드 추가
        </button>
        <span className="group-label">
          {focusedMeasureIndex === null
            ? '악보에서 마디를 클릭해 선택하세요'
            : `${focusedMeasureIndex + 1}번 마디 (${focusedMeasureChordCount}/${MAX_CHORDS_PER_MEASURE}) — 추가 후 드래그로 위치 조정, 우클릭으로 삭제`}
        </span>
      </div>

      <div className="toolbar-row">
        {isPlaying ? (
          <button onClick={onStop}>⏹ 정지</button>
        ) : (
          <button onClick={onPlay}>▶ 재생</button>
        )}
        <button onClick={onExportMusicXml}>MusicXML 내보내기</button>
        <button onClick={onExportMidi}>MIDI 내보내기</button>
        <button onClick={onSaveJson}>JSON 저장</button>
        <label className="file-input-label">
          JSON 불러오기
          <input type="file" accept="application/json" onChange={handleLoadFile} />
        </label>
      </div>
    </div>
  );
}
