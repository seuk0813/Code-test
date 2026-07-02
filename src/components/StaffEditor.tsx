import { useEffect, useRef } from 'react';
import type { NoteLocation, Score } from '../types/score';
import { renderScore, resolveClick, type RenderResult } from '../lib/vexflowRenderer';
import { lineToPitch } from '../lib/scoreUtils';
import type { Clef } from '../types/score';

interface StaffEditorProps {
  score: Score;
  selected: NoteLocation | null;
  onSelectNote: (location: NoteLocation) => void;
  onAddNote: (measureIndex: number, clef: Clef, letter: string, octave: number) => void;
}

export function StaffEditor({ score, selected, onSelectNote, onAddNote }: StaffEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const renderResultRef = useRef<RenderResult | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    renderResultRef.current = renderScore(containerRef.current, score, selected);
  }, [score, selected]);

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const svg = containerRef.current?.querySelector('svg');
    const renderResult = renderResultRef.current;
    if (!svg || !renderResult) return;

    const rect = svg.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const click = resolveClick(renderResult, x, y);
    if (!click) return;

    if (click.type === 'select') {
      onSelectNote({ measureIndex: click.measureIndex, clef: click.clef, noteIndex: click.noteIndex });
    } else {
      const { letter, octave } = lineToPitch(click.clef, click.line);
      onAddNote(click.measureIndex, click.clef, letter, octave);
    }
  };

  return (
    <div className="staff-scroll">
      <div ref={containerRef} className="staff-container" onClick={handleClick} />
    </div>
  );
}
