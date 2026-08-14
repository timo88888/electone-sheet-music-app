import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPlayOrder } from '../src/renderer/playOrder.js';

const M = (o = {}) => ({
  marker: '', repeatStart: false, repeatEnd: false, volta: null, ...o,
});
const order = (measures) => buildPlayOrder({ measures });

test('a score with no repeats plays straight through', () => {
  assert.deepEqual(order([M(), M(), M(), M()]), [0, 1, 2, 3]);
});

test('an empty score produces no events', () => {
  assert.deepEqual(order([]), []);
});

test('a repeat section is taken twice', () => {
  //  |: 0 1 2 :| 3
  const measures = [M({ repeatStart: true }), M(), M({ repeatEnd: true }), M()];
  assert.deepEqual(order(measures), [0, 1, 2, 0, 1, 2, 3]);
});

test('a repeat with no explicit start goes back to the beginning', () => {
  assert.deepEqual(order([M(), M({ repeatEnd: true }), M()]), [0, 1, 0, 1, 2]);
});

// n番括弧 — the bug this covers: volta brackets were rendered but completely
// ignored by playback, so both endings played on both passes.
test('1番/2番 endings: the first ending is skipped on the repeat', () => {
  //  |: 0 1 [1. 2 :| [2. 3
  const measures = [
    M({ repeatStart: true }),
    M(),
    M({ volta: { number: 1 }, repeatEnd: true }),
    M({ volta: { number: 2 } }),
  ];
  assert.deepEqual(order(measures), [0, 1, 2, 0, 1, 3]);
});

test('three endings mean the section is taken three times', () => {
  const measures = [
    M({ repeatStart: true }),
    M({ volta: { number: 1 }, repeatEnd: true }),
    M({ volta: { number: 2 }, repeatEnd: true }),
    M({ volta: { number: 3 } }),
  ];
  assert.deepEqual(order(measures), [0, 1, 0, 2, 0, 3]);
});

// A bracket is always exactly one measure wide, so a two-measure first ending
// is written as a bracket on its first measure; only that measure is skipped.
test('a bracket covers exactly one measure', () => {
  const measures = [
    M({ repeatStart: true }),
    M({ volta: { number: 1 } }),
    M({ repeatEnd: true }),
    M({ volta: { number: 2 } }),
  ];
  assert.deepEqual(order(measures), [0, 1, 2, 0, 2, 3]);
});

test('D.C. al Fine returns to the top and stops at Fine', () => {
  const measures = [M(), M(), M({ marker: 'Fine' }), M(), M({ marker: 'D.C.' })];
  assert.deepEqual(order(measures), [0, 1, 2, 3, 4, 0, 1, 2]);
});

test('D.S. returns to the Segno', () => {
  const measures = [M(), M({ marker: 'Segno' }), M(), M({ marker: 'D.S.' })];
  assert.deepEqual(order(measures), [0, 1, 2, 3, 1, 2, 3]);
});

// Coda — previously the marker could be set from the UI but had no effect at
// all on playback.
test('D.S. al Coda jumps from the first Coda mark to the second', () => {
  //  0(Segno) 1(To Coda) 2 3(D.S.) 4(Coda) 5
  const measures = [
    M({ marker: 'Segno' }), M({ marker: 'Coda' }), M(),
    M({ marker: 'D.S.' }), M({ marker: 'Coda' }), M(),
  ];
  assert.deepEqual(order(measures), [0, 1, 2, 3, 0, 1, 4, 5]);
});

test('a lone Coda marker has nothing to jump to and is ignored', () => {
  assert.deepEqual(order([M(), M({ marker: 'Coda' }), M()]), [0, 1, 2]);
});

test('Fine before any jump does not stop playback', () => {
  assert.deepEqual(order([M(), M({ marker: 'Fine' }), M()]), [0, 1, 2]);
});

test('repeats are not re-taken after a D.C. jump', () => {
  const measures = [
    M({ repeatStart: true }), M({ repeatEnd: true }), M({ marker: 'D.C.' }),
  ];
  // 0 1 (repeat) 0 1 2 -> jump to top -> 0 1 2 without repeating again
  assert.deepEqual(order(measures), [0, 1, 0, 1, 2, 0, 1, 2]);
});

test('playback order always terminates even on a pathological score', () => {
  // Every measure both opens and closes a repeat, plus a D.C. at the end.
  const measures = Array.from({ length: 40 }, () => M({ repeatStart: true, repeatEnd: true }));
  measures.push(M({ marker: 'D.C.' }));
  const result = order(measures);
  assert.ok(result.length > 0);
  assert.ok(result.length <= 4000);
});
