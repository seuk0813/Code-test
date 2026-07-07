import * as Tone from 'tone';
import type { Score } from '../types/score';
import { measureCapacityBeats, noteBeats, pitchToToneNote } from './scoreUtils';

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
  const events: ScheduledEvent[] = [];

  score.measures.forEach((measure, measureIndex) => {
    const measureStartBeats = measureIndex * measureBeats;

    let trebleTime = measureStartBeats;
    measure.treble.notes.forEach((note) => {
      const beats = noteBeats(note);
      if (!note.isRest && note.pitches.length > 0) {
        events.push({
          timeBeats: trebleTime,
          durationSeconds: beats * secondsPerBeat * 0.92,
          notes: note.pitches.map((p) => pitchToToneNote(p, score.keySignature)),
          synth: trebleSynth,
        });
      }
      trebleTime += beats;
    });

    let bassTime = measureStartBeats;
    measure.bass.notes.forEach((note) => {
      const beats = noteBeats(note);
      if (!note.isRest && note.pitches.length > 0) {
        events.push({
          timeBeats: bassTime,
          durationSeconds: beats * secondsPerBeat * 0.92,
          notes: note.pitches.map((p) => pitchToToneNote(p, score.keySignature)),
          synth: bassSynth,
        });
      }
      bassTime += beats;
    });

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
