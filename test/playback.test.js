import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPlaybackEvents, pitchToMidi, eventMidiNotes, DEFAULT_VELOCITY,
} from '../src/renderer/playback.js';
import { buildMidiFile } from '../src/renderer/midiExport.js';
import { gmProgramFor, GM_PROGRAM_NAMES } from '../src/renderer/gmPrograms.js';

let seq = 0;
const nid = () => `n${++seq}`;
const tone = (key, o = {}) => ({
  key, tieToNext: false, slurTo: null, glissandoTo: null, ...o,
});
const note = (keys, o = {}) => ({
  id: nid(),
  keys,
  isRest: false,
  duration: 'q',
  dotted: false,
  dynamic: '',
  articulation: '',
  tupletId: null,
  tupletCount: null,
  ...o,
});
const measure = (o = {}) => ({
  upper: [], lower: [], pedal: [], marker: '', repeatStart: false, repeatEnd: false, volta: null, ...o,
});
const scoreOf = (measures, o = {}) => ({
  timeSig: '4/4', pickupBeats: 0, keySignature: 'C', instruments: {}, measures, ...o,
});

test('pitchToMidi maps middle C and accidentals', () => {
  assert.equal(pitchToMidi('c/4'), 60);
  assert.equal(pitchToMidi('a/4'), 69);
  assert.equal(pitchToMidi('c#/4'), 61);
  assert.equal(pitchToMidi('db/4'), 61);
  assert.equal(pitchToMidi('cn/4'), 60);
});

test('measures advance by their capacity, honoring the denominator', () => {
  // 6/8 holds three quarter notes, so measure 2 starts at 3 beats, not 6.
  const score = scoreOf(
    [measure({ upper: [note([tone('c/4')])] }), measure({ upper: [note([tone('d/4')])] })],
    { timeSig: '6/8' },
  );
  const events = buildPlaybackEvents(score, 60); // 60bpm -> 1 beat = 1 second
  const starts = events.map((e) => e.time).sort((a, b) => a - b);
  assert.deepEqual(starts, [0, 3]);
});

test('a tie merges two notes into one sustained event', () => {
  const a = note([tone('c/4', { tieToNext: true })]);
  const b = note([tone('c/4')]);
  const score = scoreOf([measure({ upper: [a, b] })]);
  const events = buildPlaybackEvents(score, 60);
  assert.equal(events.length, 1);
  assert.equal(events[0].duration, 2); // two quarter notes at 60bpm
  assert.deepEqual(events[0].ids, [a.id, b.id]);
});

// 強弱記号 used to be purely visual — every note played at a fixed velocity.
test('dynamics set the velocity and stay in force until changed', () => {
  const score = scoreOf([measure({
    upper: [
      note([tone('c/4')], { dynamic: 'pp' }),
      note([tone('d/4')]),                      // still pp
      note([tone('e/4')], { dynamic: 'ff' }),
      note([tone('f/4')]),                      // still ff
    ],
  })]);
  const events = buildPlaybackEvents(score, 60).sort((a, b) => a.time - b.time);
  assert.equal(events[0].velocity, events[1].velocity);
  assert.equal(events[2].velocity, events[3].velocity);
  assert.ok(events[0].velocity < events[2].velocity, 'pp should be quieter than ff');
});

test('a score with no dynamics uses the default velocity', () => {
  const score = scoreOf([measure({ upper: [note([tone('c/4')])] })]);
  const [ev] = buildPlaybackEvents(score, 60);
  assert.equal(ev.velocity, DEFAULT_VELOCITY);
});

test('accent raises velocity without changing timing', () => {
  const plain = scoreOf([measure({ upper: [note([tone('c/4')])] })]);
  const accented = scoreOf([measure({ upper: [note([tone('c/4')], { articulation: 'accent' })] })]);
  const [a] = buildPlaybackEvents(plain, 60);
  const [b] = buildPlaybackEvents(accented, 60);
  assert.ok(b.velocity > a.velocity);
  assert.equal(a.duration, b.duration);
});

test('staccato shortens the note but not the beat that follows it', () => {
  const score = scoreOf([measure({
    upper: [
      note([tone('c/4')], { articulation: 'staccato' }),
      note([tone('d/4')]),
    ],
  })]);
  const events = buildPlaybackEvents(score, 60).sort((a, b) => a.time - b.time);
  assert.ok(events[0].duration < 1, 'staccato note should be shorter than a full beat');
  assert.equal(events[1].time, 1, 'the next note must still start on beat 2');
});

test('a staccato mark does not truncate a tied group', () => {
  const a = note([tone('c/4', { tieToNext: true })], { articulation: 'staccato' });
  const b = note([tone('c/4')]);
  const score = scoreOf([measure({ upper: [a, b] })]);
  const [ev] = buildPlaybackEvents(score, 60);
  assert.equal(ev.duration, 2);
});

test('an accidental keeps sounding for the rest of its measure, then resets', () => {
  const score = scoreOf([
    measure({ upper: [note([tone('f#/4')]), note([tone('f/4')])] }),
    measure({ upper: [note([tone('f/4')])] }),
  ]);
  const events = buildPlaybackEvents(score, 60).sort((a, b) => a.time - b.time);
  assert.equal(pitchToMidi(events[0].keys[0]), 66); // F#4
  assert.equal(pitchToMidi(events[1].keys[0]), 66); // still F# — same measure
  assert.equal(pitchToMidi(events[2].keys[0]), 65); // F natural — barline reset
});

test('the key signature applies to notes written without an accidental', () => {
  const score = scoreOf([measure({ upper: [note([tone('f/4')])] })], { keySignature: 'G' });
  const [ev] = buildPlaybackEvents(score, 60);
  assert.equal(pitchToMidi(ev.keys[0]), 66); // G major raises F to F#
});

// --- グリッサンド --------------------------------------------------------
// Glissandos were drawn on the page but had no effect at all on playback.

test('a glissando slides across the white keys between its two notes', () => {
  const end = note([tone('g/4')]);                       // MIDI 67
  const start = note([tone('c/4', { glissandoTo: { noteId: end.id, pitchKey: 'g/4' } })]); // 60
  const score = scoreOf([measure({ upper: [start, end] })]);
  const events = buildPlaybackEvents(score, 60).sort((a, b) => a.time - b.time);

  const notes = events.map((e) => eventMidiNotes(e)[0]);
  // C4 then the white keys up to (not including) G4, then G4 itself.
  assert.deepEqual(notes, [60, 62, 64, 65, 67]);
});

test('a downward glissando runs the other way', () => {
  const end = note([tone('c/4')]);
  const start = note([tone('g/4', { glissandoTo: { noteId: end.id, pitchKey: 'c/4' } })]);
  const score = scoreOf([measure({ upper: [start, end] })]);
  const notes = buildPlaybackEvents(score, 60)
    .sort((a, b) => a.time - b.time)
    .map((e) => eventMidiNotes(e)[0]);
  assert.deepEqual(notes, [67, 65, 64, 62, 60]);
});

test('a glissando never sounds a black key', () => {
  const end = note([tone('c/5')]);
  const start = note([tone('c/4', { glissandoTo: { noteId: end.id, pitchKey: 'c/5' } })]);
  const score = scoreOf([measure({ upper: [start, end] })]);
  const black = new Set([1, 3, 6, 8, 10]);
  buildPlaybackEvents(score, 60).forEach((ev) => {
    eventMidiNotes(ev).forEach((n) => {
      assert.ok(!black.has(((n % 12) + 12) % 12), `${n} should be a white key`);
    });
  });
});

test('the glissando run fits inside the written note it starts from', () => {
  const end = note([tone('g/4')]);
  const start = note([tone('c/4', { glissandoTo: { noteId: end.id, pitchKey: 'g/4' } })]);
  const score = scoreOf([measure({ upper: [start, end] })]);
  const events = buildPlaybackEvents(score, 60).sort((a, b) => a.time - b.time);
  const run = events.slice(0, 4); // everything before the destination note
  run.forEach((ev) => assert.ok(ev.time + ev.duration <= 1 + 1e-9));
  assert.equal(events[4].time, 1, 'the destination still starts on beat 2');
});

test('the glissando run stays attributed to the note it is written on', () => {
  const end = note([tone('g/4')]);
  const start = note([tone('c/4', { glissandoTo: { noteId: end.id, pitchKey: 'g/4' } })]);
  const score = scoreOf([measure({ upper: [start, end] })]);
  const events = buildPlaybackEvents(score, 60).sort((a, b) => a.time - b.time);
  events.slice(0, 4).forEach((ev) => assert.deepEqual(ev.ids, [start.id]));
});

test('adjacent notes with nothing in between play as a plain note', () => {
  const end = note([tone('d/4')]);
  const start = note([tone('c/4', { glissandoTo: { noteId: end.id, pitchKey: 'd/4' } })]);
  const score = scoreOf([measure({ upper: [start, end] })]);
  const events = buildPlaybackEvents(score, 60);
  assert.equal(events.length, 2);
  assert.equal(events[0].duration, 1);
});

test('a dangling glissando target is ignored', () => {
  const start = note([tone('c/4', { glissandoTo: { noteId: 'gone', pitchKey: 'g/4' } })]);
  const score = scoreOf([measure({ upper: [start] })]);
  const events = buildPlaybackEvents(score, 60);
  assert.equal(events.length, 1);
  assert.equal(events[0].duration, 1);
});

test('the glissando run reaches the MIDI export too', () => {
  const end = note([tone('g/4')]);
  const start = note([tone('c/4', { glissandoTo: { noteId: end.id, pitchKey: 'g/4' } })]);
  const score = scoreOf([measure({ upper: [start, end] })]);
  const bytes = [...new Uint8Array(buildMidiFile(score, 100))];
  // E4 (64) is only reachable as an intermediate step of the slide.
  const hasE4 = bytes.some((_, i) => bytes[i] === 0x90 && bytes[i + 1] === 64);
  assert.ok(hasE4, 'the intermediate white keys should be written to the MIDI file');
});

// --- GM program mapping ------------------------------------------------

test('the GM name table is 128 unique entries in program order', () => {
  assert.equal(GM_PROGRAM_NAMES.length, 128);
  assert.equal(new Set(GM_PROGRAM_NAMES).size, 128);
  assert.equal(gmProgramFor('acoustic_grand_piano'), 0);
  assert.equal(gmProgramFor('acoustic_bass'), 32);
  assert.equal(gmProgramFor('violin'), 40);
  assert.equal(gmProgramFor('flute'), 73);
  assert.equal(gmProgramFor('gunshot'), 127);
});

test('an unknown instrument name falls back to piano', () => {
  assert.equal(gmProgramFor('not_a_real_instrument'), 0);
  assert.equal(gmProgramFor(undefined), 0);
});

// --- MIDI file ---------------------------------------------------------

const bytesOf = (buf) => [...new Uint8Array(buf)];
const findSequence = (bytes, seqBytes) => bytes.findIndex(
  (_, i) => seqBytes.every((b, j) => bytes[i + j] === b),
);

test('the exported MIDI file has a valid header and one track', () => {
  const score = scoreOf([measure({ upper: [note([tone('c/4')])] })]);
  const bytes = bytesOf(buildMidiFile(score, 100));
  assert.deepEqual(bytes.slice(0, 4), [0x4d, 0x54, 0x68, 0x64]); // "MThd"
  assert.deepEqual(bytes.slice(8, 12), [0x00, 0x00, 0x00, 0x01]); // format 0, 1 track
  assert.deepEqual(bytes.slice(14, 18), [0x4d, 0x54, 0x72, 0x6b]); // "MTrk"
  assert.deepEqual(bytes.slice(-4), [0x00, 0xff, 0x2f, 0x00]); // end-of-track
});

// These three were missing entirely: an exported file always played as piano
// in 4/4 and C major, whatever the score actually said.
test('the exported MIDI file carries a time signature meta event', () => {
  const score = scoreOf([measure({ upper: [note([tone('c/4')])] })], { timeSig: '6/8' });
  const bytes = bytesOf(buildMidiFile(score, 100));
  const at = findSequence(bytes, [0xff, 0x58, 0x04]);
  assert.ok(at > 0, 'time signature meta event should be present');
  assert.equal(bytes[at + 3], 6);  // numerator
  assert.equal(bytes[at + 4], 3);  // denominator 8 == 2^3
});

test('the exported MIDI file carries a key signature meta event', () => {
  const flat = bytesOf(buildMidiFile(
    scoreOf([measure({ upper: [note([tone('c/4')])] })], { keySignature: 'Eb' }), 100,
  ));
  const at = findSequence(flat, [0xff, 0x59, 0x02]);
  assert.ok(at > 0);
  assert.equal(flat[at + 3], 0xfd); // -3 as a signed byte: three flats
  assert.equal(flat[at + 4], 0);    // major

  const minor = bytesOf(buildMidiFile(
    scoreOf([measure({ upper: [note([tone('c/4')])] })], { keySignature: 'Em' }), 100,
  ));
  const at2 = findSequence(minor, [0xff, 0x59, 0x02]);
  assert.equal(minor[at2 + 3], 1); // one sharp
  assert.equal(minor[at2 + 4], 1); // minor
});

test('the exported MIDI file sets each part\'s instrument', () => {
  const score = scoreOf([measure({ upper: [note([tone('c/4')])] })], {
    instruments: { upper: 'flute', lower: 'violin', pedal: 'acoustic_bass' },
  });
  const bytes = bytesOf(buildMidiFile(score, 100));
  // Program change is 0xC0|channel followed by the program number.
  assert.ok(findSequence(bytes, [0xc0, 73]) > 0, 'upper -> flute on channel 0');
  assert.ok(findSequence(bytes, [0xc1, 40]) > 0, 'lower -> violin on channel 1');
  assert.ok(findSequence(bytes, [0xc2, 32]) > 0, 'pedal -> acoustic bass on channel 2');
});

test('MIDI note velocities follow the score dynamics', () => {
  const quiet = bytesOf(buildMidiFile(
    scoreOf([measure({ upper: [note([tone('c/4')], { dynamic: 'pp' })] })]), 100,
  ));
  const loud = bytesOf(buildMidiFile(
    scoreOf([measure({ upper: [note([tone('c/4')], { dynamic: 'ff' })] })]), 100,
  ));
  // 0x90 = note-on channel 0, 60 = middle C, next byte is the velocity.
  const velAt = (bytes) => bytes[findSequence(bytes, [0x90, 60]) + 2];
  assert.ok(velAt(quiet) < velAt(loud));
});
