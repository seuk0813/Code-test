import MidiWriter from 'midi-writer-js';
import type { Measure, NoteEvent, Score } from '../types/score';
import { pitchToToneNote } from './scoreUtils';

const BASE_DURATION: Record<NoteEvent['duration'], string> = {
  w: '1',
  h: '2',
  q: '4',
  '8': '8',
  '16': '16',
};

function midiDuration(note: NoteEvent): string {
  const base = BASE_DURATION[note.duration];
  return note.dotted ? `d${base}` : base;
}

function buildTrack(score: Score, pickNotes: (measure: Measure) => NoteEvent[]) {
  const track = new MidiWriter.Track();
  track.setTempo(score.tempo);
  track.setTimeSignature(score.timeSignature.numerator, score.timeSignature.denominator);

  let pendingWait: string[] = [];
  score.measures.forEach((measure) => {
    pickNotes(measure).forEach((note) => {
      const duration = midiDuration(note);
      if (note.isRest || note.pitches.length === 0) {
        pendingWait.push(duration);
        return;
      }
      track.addEvent(
        new MidiWriter.NoteEvent({
          pitch: note.pitches.map(pitchToToneNote),
          duration,
          wait: pendingWait,
        }),
      );
      pendingWait = [];
    });
  });

  return track;
}

export function exportMidi(score: Score): Blob {
  const trebleTrack = buildTrack(score, (m) => m.treble.notes);
  const bassTrack = buildTrack(score, (m) => m.bass.notes);
  const writer = new MidiWriter.Writer([trebleTrack, bassTrack]);
  return new Blob([writer.buildFile()], { type: 'audio/midi' });
}
