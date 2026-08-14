import { buildPlaybackEvents, eventMidiNotes, DEFAULT_VELOCITY } from './playback.js';
import { gmProgramFor } from './gmPrograms.js';
import { PARTS, KEY_SIGNATURES } from './scoreModel.js';

const TICKS_PER_BEAT = 480;
const PART_CHANNEL = {
  upper: 0, lower: 1, pedal: 2,
};

function encodeVarLen(value) {
  const bytes = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

// FF 58 04 nn dd cc bb — dd is the denominator as a power of two, so 4/4 is
// (4, 2) and 6/8 is (6, 3). Without this every DAW opens the file as 4/4 and
// bars the music wrongly, however it was actually written.
function timeSignatureMeta(timeSig) {
  const [numerator, denominator] = String(timeSig || '4/4').split('/').map(Number);
  const nn = numerator > 0 ? numerator : 4;
  const dd = Math.round(Math.log2(denominator > 0 ? denominator : 4));
  // 24 MIDI clocks per metronome click, 8 32nd-notes per quarter — the
  // conventional values; nothing in this app varies them.
  return [...encodeVarLen(0), 0xff, 0x58, 0x04, nn, dd, 24, 8];
}

// FF 59 02 sf mi — sf counts sharps (positive) or flats (negative), mi is 0
// for major and 1 for minor.
function keySignatureMeta(keySignature) {
  const entry = KEY_SIGNATURES.find((k) => k.value === (keySignature || 'C'));
  const count = entry ? entry.accidentals : 0;
  const sf = entry && entry.type === 'flat' ? -count : count;
  const minor = /m$/.test(keySignature || '') ? 1 : 0;
  return [...encodeVarLen(0), 0xff, 0x59, 0x02, sf & 0xff, minor];
}

// Builds a minimal Standard MIDI File (format 0, single track) as an ArrayBuffer.
export function buildMidiFile(score, bpm = 100) {
  const events = buildPlaybackEvents(score, bpm);
  const secondsPerBeat = 60 / bpm;

  const midiEvents = [];
  events.forEach((ev) => {
    const channel = PART_CHANNEL[ev.part] ?? 0;
    const onTick = Math.round((ev.time / secondsPerBeat) * TICKS_PER_BEAT);
    const offTick = Math.round(((ev.time + ev.duration) / secondsPerBeat) * TICKS_PER_BEAT);
    const velocity = Math.max(1, Math.min(127, Math.round(ev.velocity || DEFAULT_VELOCITY)));
    eventMidiNotes(ev).forEach((note) => {
      midiEvents.push({
        tick: onTick, type: 'on', note, channel, velocity,
      });
      midiEvents.push({
        tick: Math.max(offTick, onTick + 1), type: 'off', note, channel, velocity: 0,
      });
    });
  });
  // Note-offs must come before note-ons at the same tick, so a repeated pitch
  // is retriggered rather than cut short by the previous note's release.
  // The comparator has to look at BOTH sides (the old one only tested `a`,
  // which made it inconsistent — compare(a,b) and compare(b,a) could both
  // report the same ordering).
  const typeRank = (type) => (type === 'off' ? 0 : 1);
  midiEvents.sort((a, b) => a.tick - b.tick
    || typeRank(a.type) - typeRank(b.type)
    || a.channel - b.channel
    || a.note - b.note);

  const trackBytes = [];
  const microsPerBeat = Math.round(60000000 / bpm);
  trackBytes.push(
    ...encodeVarLen(0), 0xff, 0x51, 0x03,
    (microsPerBeat >> 16) & 0xff, (microsPerBeat >> 8) & 0xff, microsPerBeat & 0xff,
  );
  trackBytes.push(...timeSignatureMeta(score.timeSig));
  trackBytes.push(...keySignatureMeta(score.keySignature));

  // Program change per channel, so an exported file plays back with the same
  // instruments chosen in the app instead of defaulting to piano everywhere.
  PARTS.forEach((part) => {
    const channel = PART_CHANNEL[part] ?? 0;
    const name = (score.instruments && score.instruments[part]) || 'acoustic_grand_piano';
    trackBytes.push(...encodeVarLen(0), 0xc0 | (channel & 0x0f), gmProgramFor(name));
  });

  let lastTick = 0;
  midiEvents.forEach((e) => {
    const delta = Math.max(0, e.tick - lastTick);
    lastTick = e.tick;
    const status = (e.type === 'on' ? 0x90 : 0x80) | (e.channel & 0x0f);
    trackBytes.push(...encodeVarLen(delta), status, e.note, e.velocity);
  });
  trackBytes.push(...encodeVarLen(0), 0xff, 0x2f, 0x00);

  const headerBytes = [
    0x4d, 0x54, 0x68, 0x64,
    0x00, 0x00, 0x00, 0x06,
    0x00, 0x00,
    0x00, 0x01,
    (TICKS_PER_BEAT >> 8) & 0xff, TICKS_PER_BEAT & 0xff,
  ];
  const trackLen = trackBytes.length;
  const trackHeader = [
    0x4d, 0x54, 0x72, 0x6b,
    (trackLen >> 24) & 0xff, (trackLen >> 16) & 0xff, (trackLen >> 8) & 0xff, trackLen & 0xff,
  ];

  return new Uint8Array([...headerBytes, ...trackHeader, ...trackBytes]).buffer;
}
