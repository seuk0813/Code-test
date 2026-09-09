import MidiWriter from 'midi-writer-js';
import type { Measure, NoteEvent, Score } from '../types/score';
import { activeParts, noteBeats, pitchToToneNote, soundingPitches } from './scoreUtils';

const BASE_DURATION: Record<NoteEvent['duration'], string> = {
  w: '1',
  h: '2',
  q: '4',
  '8': '8',
  '16': '16',
  '32': '32',
};

/** midi-writer-js's own ticks per quarter note (its default PPQN). */
const MIDI_TICKS_PER_BEAT = 128;

/**
 * A note's length in midi-writer-js duration syntax.
 *
 * Anything tupleted is written as an explicit tick count ("T96"), not with the
 * library's 't' suffix: that suffix always fits its notes into the time of
 * TWO, which is right for a triplet and wrong for everything else — "8t4"
 * means 4 eighths in the time of 2, not the 4-in-the-time-of-3 a quadruplet
 * is. noteBeats already knows the real length, so ticks are exact for any
 * ratio.
 */
function midiDuration(note: NoteEvent): string {
  if (note.tuplet) return `T${Math.round(noteBeats(note) * MIDI_TICKS_PER_BEAT)}`;
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
          // Sounding, not written: an 옥타브 표시 shifts the note by an octave
          // (see soundingPitches), and a MIDI file has no way to say "written
          // here, plays there".
          pitch: soundingPitches(note).map((p) => pitchToToneNote(p, score.keySignature)),
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
