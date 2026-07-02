import type { ChangeEvent } from 'react';
import type { Accidental, DurationValue, Score } from '../types/score';
import { DURATION_LABELS } from '../lib/scoreUtils';

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

export interface EditTool {
  duration: DurationValue;
  dotted: boolean;
  isRest: boolean;
  accidental: Accidental;
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
