import MidiWriter from 'midi-writer-js';
import type { Measure, NoteEvent, Score } from '../types/score';
import { activeParts, pitchToToneNote } from './scoreUtils';

const BASE_DURATION: Record<NoteEvent['duration'], string> = {
  w: '1',
  h: '2',
  q: '4',
  '8': '8',
  '16': '16',
  '32': '32',
};

/** midi-writer-js natively parses a 't' suffix (e.g. "8t") as a duration
 * ratio'd 3-in-the-place-of-2 — exactly the 2/3 triplet ratio NoteEvent.tuplet
 * needs (see scoreUtils' noteBeats/TUPLET_RATIO), so no manual tick math here. */
function midiDuration(note: NoteEvent): string {
  const base = BASE_DURATION[note.duration];
  const dotted = note.dotted ? `d${base}` : base;
  return note.tuplet ? `${dotted}t` : dotted;
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
          pitch: note.pitches.map((p) => pitchToToneNote(p, score.keySignature)),
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
  // One track per sounding part (see activeParts) — the melody staff exports
  // as its own track whenever it is in use, so the tune stays separable from
  // the piano part instead of being folded into the right hand.
  const tracks = activeParts(score).map((part) => buildTrack(score, (m) => m[part].notes));
  const writer = new MidiWriter.Writer(tracks);
  return new Blob([writer.buildFile()], { type: 'audio/midi' });
}
