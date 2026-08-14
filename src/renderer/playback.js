import { Soundfont } from '../../node_modules/smplr/dist/index.mjs';
import {
  PARTS, measureCapacity, noteBeats, keySignatureAccidentalForLetter,
} from './scoreModel.js';
import { buildPlayOrder } from './playOrder.js';
import { parseKey, buildKey } from './pitchMap.js';

// Used whenever a part has no instrument choice saved yet (older files, or a
// freshly created score before the user picks anything in 出力/ホーム's
// 楽器 selects).
export const DEFAULT_INSTRUMENT = 'acoustic_grand_piano';

const LETTER_SEMITONE = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

const ACCIDENTAL_OFFSET = {
  '': 0, '#': 1, '##': 2, b: -1, bb: -2, n: 0,
};

// Fixed head-start (seconds) before playback audio actually starts, giving
// the AudioContext/oscillators time to spin up. Exported so app.js can
// schedule the on-screen "currently playing" highlight on the same clock.
export const PLAYBACK_LEAD = 0.15;

// 強弱記号 -> MIDI velocity. A dynamic stays in force until the next one, the
// way it does on the page, so this is tracked per part as playback walks the
// score rather than applied only to the note it's written on.
const DYNAMIC_VELOCITY = {
  pp: 40, p: 55, mp: 70, mf: 85, f: 102, ff: 118,
};
export const DEFAULT_VELOCITY = 85;

// アーティキュレーション. Accent/marcato push the attack harder; staccato and
// staccatissimo shorten the note without moving anything after it (the beat
// cursor still advances by the full written value). Everything else — fermata,
// trill, turn, mordent, arpeggio — is notation this simple playback doesn't
// interpret, and is left alone rather than guessed at.
const ARTICULATION_VELOCITY_SCALE = { accent: 1.25, marcato: 1.4 };
const ARTICULATION_DURATION_SCALE = { staccato: 0.5, staccatissimo: 0.35, tenuto: 1 };

function velocityFor(dynamic, articulation, standingVelocity) {
  const base = (dynamic && DYNAMIC_VELOCITY[dynamic]) || standingVelocity;
  const scaled = Math.round(base * (ARTICULATION_VELOCITY_SCALE[articulation] || 1));
  return Math.max(1, Math.min(127, scaled));
}

// --- グリッサンド ---
//
// A glissando is a slide, so it can't play as a single held note. On a keyboard
// it's performed by running a thumb or nail across the white keys, and that's
// what's reproduced here: the written start note is replaced by a run of white
// keys from it up (or down) to the destination, filling exactly the time the
// start note occupies. The destination itself is left alone — it's a real note
// in the score and sounds on its own.

// C D E F G A B as pitch classes.
const WHITE_KEY_PITCH_CLASSES = new Set([0, 2, 4, 5, 7, 9, 11]);

function isWhiteKey(midi) {
  return WHITE_KEY_PITCH_CLASSES.has(((midi % 12) + 12) % 12);
}

// White-key MIDI numbers strictly between two pitches, ordered from the start
// toward the destination.
function whiteKeysBetween(startMidi, endMidi) {
  const step = endMidi > startMidi ? 1 : -1;
  const keys = [];
  for (let m = startMidi + step; m !== endMidi; m += step) {
    if (isWhiteKey(m)) keys.push(m);
  }
  return keys;
}

// The pitch a slur/glissando link points at, as a MIDI number. Standing
// accidentals from that measure aren't tracked here (the link is resolved out
// of order, ahead of the walk that maintains them) — the key signature is
// applied, which is enough to land the slide on the right key.
function linkTargetMidi(noteById, link, keySignature) {
  const target = noteById.get(link.noteId);
  if (!target || target.isRest) return null;
  const tone = (target.keys || []).find((t) => {
    const { letter, octave } = parseKey(t.key);
    return `${letter.toLowerCase()}/${octave}` === link.pitchKey;
  });
  if (!tone) return null;
  const { letter, accidental, octave } = parseKey(tone.key);
  const implied = accidental ? accidental : keySignatureAccidentalForLetter(keySignature, letter);
  return pitchToMidi(buildKey(letter, implied === 'n' ? '' : implied, octave));
}

export function pitchToMidi(key) {
  const { letter, accidental, octave } = parseKey(key);
  return (octave + 1) * 12 + LETTER_SEMITONE[letter] + ACCIDENTAL_OFFSET[accidental];
}

// The MIDI note numbers a playback event sounds. Most events carry written
// pitches in `keys`; the intermediate steps of a glissando are computed as raw
// MIDI numbers instead (there's no written note to spell them from), and come
// through as `midi`. Every consumer — live playback, WAV render, MIDI export —
// goes through here so both kinds sound.
export function eventMidiNotes(ev) {
  if (ev.midi !== undefined) return [ev.midi];
  return (ev.keys || []).map(pitchToMidi);
}

// A note typed without an explicit accidental sounds whatever is currently
// "standing" for that exact line/space: an earlier explicit accidental on the
// same letter+octave *within this measure* (barlines cancel it), or failing
// that, whatever the key signature implies (e.g. F sounds F# in G major).
// `standingAccidentals` is a Map the caller resets once per measure.
function resolvePlaybackKey(key, keySignature, standingAccidentals) {
  const { letter, accidental, octave } = parseKey(key);
  const pid = `${letter}${octave}`;
  if (accidental) {
    standingAccidentals.set(pid, accidental);
    return key;
  }
  if (standingAccidentals.has(pid)) {
    const standing = standingAccidentals.get(pid);
    return buildKey(letter, standing === 'n' ? '' : standing, octave);
  }
  const implied = keySignatureAccidentalForLetter(keySignature, letter);
  return implied ? buildKey(letter, implied, octave) : key;
}

// Flattens the score into a list of absolute-time note events, expanding
// repeat signs / D.C. / D.S. / Fine via buildPlayOrder and merging tied
// tones into a single sustained event. All three parts share one measure
// timeline. Each chord tone becomes its own event (so tie continuation can
// be tracked per pitch — one tone of a chord can tie forward while another
// doesn't) carrying `ids` (the contributing note id(s)) so callers can
// highlight the notes currently sounding.
export function buildPlaybackEvents(score, bpm = 100) {
  const secondsPerBeat = 60 / bpm;
  const order = buildPlayOrder(score);
  const events = [];

  // Needed to resolve a グリッサンド's destination, which can be any note
  // anywhere in the score rather than the next one along.
  const noteById = new Map();
  score.measures.forEach((measure) => {
    PARTS.forEach((part) => {
      (measure[part] || []).forEach((n) => noteById.set(n.id, n));
    });
  });

  PARTS.forEach((part) => {
    let time = 0;
    let pendingByPitch = new Map(); // "letter+octave" (pre-accidental) -> still-open event
    // The dynamic currently in force for this part. Reset per part, not per
    // measure — a "p" keeps applying until something else is written.
    let standingVelocity = DEFAULT_VELOCITY;
    order.forEach((measureIndex) => {
      const measure = score.measures[measureIndex];
      const capacity = measureCapacity(score, measureIndex);
      let beatCursor = 0;
      const standingAccidentals = new Map(); // reset every measure — barlines cancel accidentals
      measure[part].forEach((n) => {
        const beats = noteBeats(n);
        const noteStart = time + beatCursor * secondsPerBeat;
        const noteDur = beats * secondsPerBeat;
        if (n.isRest) {
          // A genuine rest can't be tied to/from — every pitch still open
          // for this part finalizes here. An unfilled N連符 placeholder is
          // the exception: it doesn't sound yet and doesn't interrupt any
          // tie in flight, so other pitches' pending ties are left untouched.
          if (!n.isPlaceholder) {
            pendingByPitch.forEach((ev) => events.push(ev));
            pendingByPitch = new Map();
          }
        } else {
          if (n.dynamic && DYNAMIC_VELOCITY[n.dynamic]) {
            standingVelocity = DYNAMIC_VELOCITY[n.dynamic];
          }
          const velocity = velocityFor(n.dynamic, n.articulation, standingVelocity);
          // Staccato shortens the sound only — beatCursor below still advances
          // by the full written value, so nothing after it moves.
          const durationScale = ARTICULATION_DURATION_SCALE[n.articulation] || 1;
          const nextPending = new Map();
          n.keys.forEach((tone) => {
            const { letter, octave } = parseKey(tone.key);
            const pid = `${letter}${octave}`;
            const resolved = resolvePlaybackKey(tone.key, score.keySignature, standingAccidentals);
            const prev = pendingByPitch.get(pid);
            if (prev) {
              pendingByPitch.delete(pid);
              prev.duration += noteDur;
              prev.ids.push(n.id);
              if (tone.tieToNext) {
                nextPending.set(pid, prev);
              } else {
                // A tie makes several written notes one sound, so an
                // articulation only shortens a note that stands alone.
                if (prev.ids.length === 1) prev.duration *= durationScale;
                events.push(prev);
              }
            } else {
              // A グリッサンド replaces this tone's single sustained sound with
              // a run of white keys sliding toward its destination, spread
              // across exactly the time the written note occupies. A tie takes
              // precedence: a tone that carries on into the next note isn't
              // sliding anywhere.
              const glissTargets = !tone.tieToNext && tone.glissandoTo
                ? (() => {
                  const endMidi = linkTargetMidi(noteById, tone.glissandoTo, score.keySignature);
                  if (endMidi === null) return null;
                  const steps = whiteKeysBetween(pitchToMidi(resolved), endMidi);
                  return steps.length > 0 ? steps : null;
                })()
                : null;

              if (glissTargets) {
                const slots = glissTargets.length + 1; // the written note, then the run
                const slotDur = noteDur / slots;
                events.push({
                  time: noteStart,
                  duration: slotDur,
                  keys: [resolved],
                  part,
                  ids: [n.id],
                  velocity,
                });
                glissTargets.forEach((midi, step) => {
                  events.push({
                    time: noteStart + slotDur * (step + 1),
                    duration: slotDur,
                    midi,
                    keys: [],
                    part,
                    // Attributed to the written note so the on-screen playback
                    // highlight stays on it for the whole slide.
                    ids: [n.id],
                    velocity,
                  });
                });
              } else {
                const ev = {
                  time: noteStart,
                  duration: tone.tieToNext ? noteDur : noteDur * durationScale,
                  keys: [resolved],
                  part,
                  ids: [n.id],
                  velocity,
                };
                if (tone.tieToNext) nextPending.set(pid, ev); else events.push(ev);
              }
            }
          });
          if (n.partialChordNote) {
            // This note was auto-inserted to land just one tone's タイ (see
            // applyTieToSelectedTone in app.js) when its chord's other tones
            // already tie elsewhere — any other pitch still pending isn't
            // this note's business; let it keep waiting for its own landing
            // spot instead of treating it as broken.
            pendingByPitch.forEach((ev, pid) => nextPending.set(pid, ev));
          } else {
            // Any pitch left over from before that this note's chord didn't
            // repeat had its tie broken (the chord shape changed) — finalize it.
            pendingByPitch.forEach((ev) => events.push(ev));
          }
          pendingByPitch = nextPending;
        }
        beatCursor += beats;
      });
      time += capacity * secondsPerBeat;
    });
    pendingByPitch.forEach((ev) => events.push(ev));
  });

  return events;
}

// Plays and pauses a score using real sampled instruments (smplr) — one
// instrument per part (上鍵盤/下鍵盤/ペダル), each independently selectable
// (see app.js's 楽器 selects, stored as score.instruments).
//
// Notes are scheduled with plain setTimeout rather than the Web Audio clock's
// own native `time` parameter (which smplr also supports) so that pause()
// can reliably cancel every not-yet-started note by just clearing timers —
// relying on the instrument's own stop() to do that isn't documented to
// affect future-scheduled starts, only currently-sounding ones.
export class Player {
  constructor() {
    this.ctx = null;
    this.timers = [];
    this.playing = false;
    this.instruments = { upper: null, lower: null, pedal: null };
    this.instrumentNames = { upper: null, lower: null, pedal: null };
    this.pausedAt = 0; // score-time (seconds) to resume from
    this.playStartScoreTime = 0;
    this.playStartRealMs = 0;
  }

  async ensureInstruments(instrumentNames) {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    await Promise.all(PARTS.map(async (part) => {
      const name = (instrumentNames && instrumentNames[part]) || DEFAULT_INSTRUMENT;
      // Even when the name matches and an instance already exists, its
      // `ready` still needs awaiting here — a second play() while the first
      // is still mid-load must not skip ahead of that load finishing.
      if (this.instrumentNames[part] === name && this.instruments[part]) {
        await this.instruments[part].ready;
        return;
      }
      if (this.instruments[part]) this.instruments[part].dispose();
      const instrument = Soundfont(this.ctx, { instrument: name });
      this.instruments[part] = instrument;
      this.instrumentNames[part] = name;
      await instrument.ready;
    }));
  }

  // `startTime` (seconds into the piece) lets playback begin partway through
  // — see app.js's "選択中の音符から再生" behavior.
  async play(score, bpm, instrumentNames, onDone, startTime = 0) {
    this.clearTimers();
    await this.ensureInstruments(instrumentNames);
    const events = buildPlaybackEvents(score, bpm);
    let maxOffset = 0;
    this.playStartScoreTime = startTime;
    this.playStartRealMs = performance.now();
    events.forEach((ev) => {
      const evEnd = ev.time + ev.duration;
      if (evEnd <= startTime) return; // already finished before the start point
      const offset = Math.max(0, ev.time - startTime);
      // A note already sounding when playback starts mid-piece plays out
      // only its remaining duration, not its full written length.
      const duration = Math.max(0.05, evEnd - Math.max(ev.time, startTime));
      const instrument = this.instruments[ev.part];
      const timer = setTimeout(() => {
        eventMidiNotes(ev).forEach((note) => {
          instrument.start({
            note, duration, velocity: ev.velocity || DEFAULT_VELOCITY,
          });
        });
      }, (offset + PLAYBACK_LEAD) * 1000);
      this.timers.push(timer);
      maxOffset = Math.max(maxOffset, offset + duration);
    });
    this.playing = true;
    this.pausedAt = 0;
    const doneTimer = setTimeout(() => {
      this.playing = false;
      if (onDone) onDone();
    }, (maxOffset + PLAYBACK_LEAD + 0.3) * 1000);
    this.timers.push(doneTimer);
  }

  clearTimers() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  // Stops all sound and remembers the score-time position so a later play()
  // call (with that position as startTime) resumes instead of restarting.
  pause() {
    if (!this.playing) return;
    const elapsedReal = Math.max(0, (performance.now() - this.playStartRealMs) / 1000 - PLAYBACK_LEAD);
    this.pausedAt = this.playStartScoreTime + elapsedReal;
    this.clearTimers();
    PARTS.forEach((part) => { if (this.instruments[part]) this.instruments[part].stop(); });
    this.playing = false;
  }

  stop() {
    this.clearTimers();
    PARTS.forEach((part) => { if (this.instruments[part]) this.instruments[part].stop(); });
    this.playing = false;
    this.pausedAt = 0;
  }
}

// Renders the score offline to a mono 16-bit PCM WAV file (ArrayBuffer),
// using the same per-part instrument choices as live playback.
export async function renderScoreToWavBuffer(score, bpm = 100, instrumentNames = {}) {
  const events = buildPlaybackEvents(score, bpm);
  const totalTime = events.reduce((max, ev) => Math.max(max, ev.time + ev.duration), 0) + 1;
  const sampleRate = 44100;
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offlineCtx = new OfflineCtx(1, Math.ceil(totalTime * sampleRate), sampleRate);
  const instruments = {};
  await Promise.all(PARTS.map(async (part) => {
    const name = instrumentNames[part] || DEFAULT_INSTRUMENT;
    const instrument = Soundfont(offlineCtx, { instrument: name });
    instruments[part] = instrument;
    await instrument.ready;
  }));
  events.forEach((ev) => {
    eventMidiNotes(ev).forEach((note) => {
      instruments[ev.part].start({
        note,
        time: ev.time,
        duration: Math.max(ev.duration, 0.05),
        velocity: ev.velocity || DEFAULT_VELOCITY,
      });
    });
  });
  const rendered = await offlineCtx.startRendering();
  return audioBufferToWav(rendered);
}

function audioBufferToWav(buffer) {
  const numChannels = 1;
  const sampleRate = buffer.sampleRate;
  const samples = buffer.getChannelData(0);
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const bufferArr = new ArrayBuffer(44 + dataSize);
  const view = new DataView(bufferArr);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return bufferArr;
}
