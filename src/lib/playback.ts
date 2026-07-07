import * as Tone from 'tone';
import type { Clef, NoteEvent, Score } from '../types/score';
import { measureCapacityBeats, noteBeats, pitchToToneNote, pitchToVexKey } from './scoreUtils';

export interface PlaybackHandle {
  stop: () => void;
  /** Elapsed transport time in seconds, for syncing the visual playhead. */
  getSeconds: () => number;
}

interface ScheduledEvent {
  timeBeats: number;
  durationSeconds: number;
  notes: string[];
  synth: Tone.PolySynth;
}

interface FlatNote {
  note: NoteEvent;
  timeBeats: number;
}

/** Every note in a staff, across all measures, with its absolute beat offset — ties can span barlines. */
function flattenStaffNotes(score: Score, clef: Clef, measureBeats: number): FlatNote[] {
  const flat: FlatNote[] = [];
  score.measures.forEach((measure, measureIndex) => {
    let t = measureIndex * measureBeats;
    measure[clef].notes.forEach((note) => {
      flat.push({ note, timeBeats: t });
      t += noteBeats(note);
    });
  });
  return flat;
}

/** Whether `cur`'s connection into `next` is a tie (same pitch ringing on) rather than a slur (phrasing only). */
function isTieConnection(cur: NoteEvent, next: NoteEvent): boolean {
  if (!cur.connectToNext) return false;
  if (cur.connectKind === 'tie') return true;
  if (cur.connectKind === 'slur') return false;
  // Legacy data saved before connectKind existed: auto-detect like the renderer used to.
  return (
    cur.pitches.length === next.pitches.length &&
    cur.pitches.every((p, pi) => pitchToVexKey(p) === pitchToVexKey(next.pitches[pi]))
  );
}

/**
 * Builds one Tone event per sounding note, merging a tied note into the note
 * it ties from — a tie means the same pitch keeps ringing, so the tied-into
 * note must not re-trigger a new attack, only extend the previous one's
 * duration to cover it. A slur doesn't merge: both notes still re-articulate.
 */
function buildStaffEvents(flat: FlatNote[], synth: Tone.PolySynth, keySignature: string, secondsPerBeat: number): ScheduledEvent[] {
  const events: ScheduledEvent[] = [];
  let i = 0;
  while (i < flat.length) {
    const { note, timeBeats } = flat[i];
    if (note.isRest || note.pitches.length === 0) {
      i += 1;
      continue;
    }
    let totalBeats = noteBeats(note);
    let j = i;
    while (
      flat[j + 1] &&
      !flat[j + 1].note.isRest &&
      flat[j + 1].note.pitches.length > 0 &&
      isTieConnection(flat[j].note, flat[j + 1].note)
    ) {
      totalBeats += noteBeats(flat[j + 1].note);
      j += 1;
    }
    events.push({
      timeBeats,
      durationSeconds: totalBeats * secondsPerBeat * 0.92,
      notes: note.pitches.map((p) => pitchToToneNote(p, keySignature)),
      synth,
    });
    i = j + 1;
  }
  return events;
}

export async function playScore(
  score: Score,
  onMeasure: (measureIndex: number) => void,
  onEnd: () => void,
  /** Beats from the very start to begin playback from (the draggable seek bar). */
  startBeat = 0,
): Promise<PlaybackHandle> {
  await Tone.start();

  const trebleSynth = new Tone.PolySynth(Tone.Synth).toDestination();
  const bassSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
  }).toDestination();

  Tone.getTransport().stop();
  Tone.getTransport().cancel();
  Tone.getTransport().bpm.value = score.tempo;

  const secondsPerBeat = 60 / score.tempo;
  const measureBeats = measureCapacityBeats(score.timeSignature);
  const events: ScheduledEvent[] = [
    ...buildStaffEvents(flattenStaffNotes(score, 'treble', measureBeats), trebleSynth, score.keySignature, secondsPerBeat),
    ...buildStaffEvents(flattenStaffNotes(score, 'bass', measureBeats), bassSynth, score.keySignature, secondsPerBeat),
  ];

  score.measures.forEach((_, measureIndex) => {
    const measureStartBeats = measureIndex * measureBeats;
    Tone.getTransport().schedule((time) => {
      Tone.getDraw().schedule(() => onMeasure(measureIndex), time);
    }, measureStartBeats * secondsPerBeat);
  });

  events.forEach((ev) => {
    Tone.getTransport().schedule((time) => {
      ev.synth.triggerAttackRelease(ev.notes, ev.durationSeconds, time);
    }, ev.timeBeats * secondsPerBeat);
  });

  const totalSeconds = score.measures.length * measureBeats * secondsPerBeat;

  const cleanup = () => {
    trebleSynth.releaseAll();
    bassSynth.releaseAll();
    Tone.getTransport().stop();
    Tone.getTransport().cancel();
    trebleSynth.dispose();
    bassSynth.dispose();
  };

  Tone.getTransport().schedule((time) => {
    Tone.getDraw().schedule(() => {
      onEnd();
      cleanup();
    }, time);
  }, totalSeconds + 0.1);

  // Start the transport at the seek offset: events are all scheduled at their
  // absolute times, so jumping the transport to startBeat both skips earlier
  // notes and keeps transport.seconds reporting the true absolute position
  // (so the visual playhead stays correct without any extra offset math).
  Tone.getTransport().start(undefined, startBeat * secondsPerBeat);

  return {
    stop: () => {
      cleanup();
    },
    getSeconds: () => Tone.getTransport().seconds,
  };
}
