import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pitchKeyOf, pruneDanglingLinks, retargetLinksTo, retargetLinksAfterTranspose,
  cloneNotesWithFreshIds,
} from '../src/renderer/noteLinks.js';

const PARTS = ['upper', 'lower', 'pedal'];

let seq = 0;
const nid = () => `n${++seq}`;

const tone = (key, o = {}) => ({
  key, tieToNext: false, slurTo: null, glissandoTo: null, ...o,
});
const note = (keys, o = {}) => ({
  id: nid(), keys, isRest: false, duration: 'q', dotted: false, ...o,
});
const measure = (o = {}) => ({
  upper: [], lower: [], pedal: [], ...o,
});
const scoreOf = (...measures) => ({ measures });

test('pitchKeyOf ignores the accidental and lowercases the letter', () => {
  assert.equal(pitchKeyOf('c/4'), 'c/4');
  assert.equal(pitchKeyOf('C#/4'), 'c/4');
  assert.equal(pitchKeyOf('eb/5'), 'e/5');
  assert.equal(pitchKeyOf('fn/3'), 'f/3');
});

// --- tie ---------------------------------------------------------------

test('a tie survives when the next note carries the same pitch', () => {
  const a = note([tone('c/4', { tieToNext: true })]);
  const b = note([tone('c/4')]);
  const score = scoreOf(measure({ upper: [a, b] }));
  pruneDanglingLinks(score, PARTS);
  assert.equal(a.keys[0].tieToNext, true);
});

test('a tie survives across a barline', () => {
  const a = note([tone('c/4', { tieToNext: true })]);
  const b = note([tone('c/4')]);
  const score = scoreOf(measure({ upper: [a] }), measure({ upper: [b] }));
  pruneDanglingLinks(score, PARTS);
  assert.equal(a.keys[0].tieToNext, true);
});

// The headline bug: a tie whose target was re-pitched used to keep hunting
// forward and attach itself to the next same-pitch note, several measures away.
test('a tie is dropped when the next note no longer has the pitch', () => {
  const a = note([tone('c/4', { tieToNext: true })]);
  const b = note([tone('d/4')]);   // re-pitched by the user
  const c = note([tone('c/4')]);   // must NOT become the tie target
  const score = scoreOf(measure({ upper: [a, b, c] }));
  pruneDanglingLinks(score, PARTS);
  assert.equal(a.keys[0].tieToNext, false);
});

test('a tie does not reach past an intervening rest', () => {
  const a = note([tone('c/4', { tieToNext: true })]);
  const rest = note([tone('c/4')], { isRest: true });
  const c = note([tone('c/4')]);
  const score = scoreOf(measure({ upper: [a, rest, c] }));
  pruneDanglingLinks(score, PARTS);
  assert.equal(a.keys[0].tieToNext, false);
});

test('a tie ignores an unfilled tuplet placeholder rest in between', () => {
  const a = note([tone('c/4', { tieToNext: true })]);
  const placeholder = note([tone('c/4')], { isRest: true, isPlaceholder: true });
  const c = note([tone('c/4')]);
  const score = scoreOf(measure({ upper: [a, placeholder, c] }));
  pruneDanglingLinks(score, PARTS);
  assert.equal(a.keys[0].tieToNext, true);
});

test('a tie on the last note of the score is dropped', () => {
  const a = note([tone('c/4', { tieToNext: true })]);
  const score = scoreOf(measure({ upper: [a] }));
  pruneDanglingLinks(score, PARTS);
  assert.equal(a.keys[0].tieToNext, false);
});

test('chord tones tie independently of each other', () => {
  const a = note([tone('c/4', { tieToNext: true }), tone('e/4', { tieToNext: true })]);
  const b = note([tone('c/4')]);  // only C continues
  const score = scoreOf(measure({ upper: [a, b] }));
  pruneDanglingLinks(score, PARTS);
  assert.equal(a.keys[0].tieToNext, true);   // c/4 lands
  assert.equal(a.keys[1].tieToNext, false);  // e/4 does not
});

test('a tie does not leak between parts', () => {
  const a = note([tone('c/4', { tieToNext: true })]);
  const other = note([tone('c/4')]);
  const score = scoreOf(measure({ upper: [a], lower: [other] }));
  pruneDanglingLinks(score, PARTS);
  assert.equal(a.keys[0].tieToNext, false);
});

// --- slur / glissando --------------------------------------------------

test('a slur survives while its target note and pitch exist', () => {
  const b = note([tone('g/4')]);
  const a = note([tone('c/4', { slurTo: { noteId: b.id, pitchKey: 'g/4' } })]);
  const score = scoreOf(measure({ upper: [a, b] }));
  pruneDanglingLinks(score, PARTS);
  assert.deepEqual(a.keys[0].slurTo, { noteId: b.id, pitchKey: 'g/4' });
});

test('a slur is dropped when its target note is deleted', () => {
  const a = note([tone('c/4', { slurTo: { noteId: 'gone', pitchKey: 'g/4' } })]);
  const score = scoreOf(measure({ upper: [a] }));
  pruneDanglingLinks(score, PARTS);
  assert.equal(a.keys[0].slurTo, null);
});

test('a glissando is dropped when its target pitch is gone', () => {
  const b = note([tone('a/4')]);   // used to be g/4
  const a = note([tone('c/4', { glissandoTo: { noteId: b.id, pitchKey: 'g/4' } })]);
  const score = scoreOf(measure({ upper: [a, b] }));
  pruneDanglingLinks(score, PARTS);
  assert.equal(a.keys[0].glissandoTo, null);
});

test('a slur pointing at a rest is dropped', () => {
  const b = note([tone('g/4')], { isRest: true });
  const a = note([tone('c/4', { slurTo: { noteId: b.id, pitchKey: 'g/4' } })]);
  const score = scoreOf(measure({ upper: [a, b] }));
  pruneDanglingLinks(score, PARTS);
  assert.equal(a.keys[0].slurTo, null);
});

// The other half of the fix: rather than pruning a link when its target moves,
// the pitch change itself carries the link along.
test('retargetLinksTo follows a re-pitched target', () => {
  const b = note([tone('g/4')]);
  const a = note([tone('c/4', { slurTo: { noteId: b.id, pitchKey: 'g/4' } })]);
  const score = scoreOf(measure({ upper: [a, b] }));

  b.keys[0].key = 'a/4';
  retargetLinksTo(score, PARTS, b.id, 'g/4', 'a/4');

  assert.equal(a.keys[0].slurTo.pitchKey, 'a/4');
  pruneDanglingLinks(score, PARTS);
  assert.notEqual(a.keys[0].slurTo, null, 'the slur should survive the prune');
});

test('retargetLinksTo leaves other notes at the same pitch alone', () => {
  const b = note([tone('g/4')]);
  const c = note([tone('g/4')]);
  const a = note([tone('c/4', { slurTo: { noteId: c.id, pitchKey: 'g/4' } })]);
  const score = scoreOf(measure({ upper: [a, b, c] }));

  retargetLinksTo(score, PARTS, b.id, 'g/4', 'a/4'); // b moved, not c
  assert.equal(a.keys[0].slurTo.pitchKey, 'g/4');
});

test('retargetLinksAfterTranspose shifts every link landing in the region', () => {
  const b = note([tone('g/4')]);
  const a = note([tone('c/4', { slurTo: { noteId: b.id, pitchKey: 'g/4' } })]);
  const score = scoreOf(measure({ upper: [a, b] }));

  retargetLinksAfterTranspose(score, PARTS, new Set([b.id]), () => 'b/4');
  assert.equal(a.keys[0].slurTo.pitchKey, 'b/4');
});

// --- copy / paste ------------------------------------------------------

test('cloned notes get fresh ids', () => {
  const a = note([tone('c/4')]);
  const [copy] = cloneNotesWithFreshIds([a], nid);
  assert.notEqual(copy.id, a.id);
  assert.equal(copy.keys[0].key, 'c/4');
});

// Pasting used to leave the copies' slurs pointing at the notes they were
// copied from, drawing a curve across the score from the paste back to the source.
test('a slur inside the copied range is rewritten to point at the copies', () => {
  const b = note([tone('g/4')]);
  const a = note([tone('c/4', { slurTo: { noteId: b.id, pitchKey: 'g/4' } })]);
  const copies = cloneNotesWithFreshIds([a, b], nid);

  assert.equal(copies[0].keys[0].slurTo.noteId, copies[1].id);
  assert.notEqual(copies[0].keys[0].slurTo.noteId, b.id);
});

test('a slur leaving the copied range is dropped from the copy', () => {
  const outside = note([tone('g/4')]);
  const a = note([tone('c/4', { slurTo: { noteId: outside.id, pitchKey: 'g/4' } })]);
  const [copy] = cloneNotesWithFreshIds([a], nid);
  assert.equal(copy.keys[0].slurTo, null);
});

test('cloning does not mutate the source notes', () => {
  const b = note([tone('g/4')]);
  const a = note([tone('c/4', { slurTo: { noteId: b.id, pitchKey: 'g/4' } })]);
  const originalTarget = a.keys[0].slurTo.noteId;
  cloneNotesWithFreshIds([a, b], nid);
  assert.equal(a.keys[0].slurTo.noteId, originalTarget);
});

// --- robustness --------------------------------------------------------

test('pruneDanglingLinks tolerates an empty or malformed score', () => {
  assert.doesNotThrow(() => pruneDanglingLinks({ measures: [] }, PARTS));
  assert.doesNotThrow(() => pruneDanglingLinks({}, PARTS));
  assert.doesNotThrow(() => pruneDanglingLinks(null, PARTS));
  assert.doesNotThrow(() => pruneDanglingLinks(scoreOf(measure()), PARTS));
});
