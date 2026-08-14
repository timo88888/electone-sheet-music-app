import test from 'node:test';
import assert from 'node:assert/strict';

import {
  beatsPerMeasure, measureCapacity, noteBeats, durationBeats,
  tupletNotesOccupied, detectChordCandidates, keySignatureAccidentalForLetter,
  isValidTimeSig,
} from '../src/renderer/scoreModel.js';

// Durations are measured in quarter notes throughout the app (DURATION_BEATS
// has q = 1), so a time signature's denominator has to be converted rather
// than ignored. Reading only the numerator used to make every signature whose
// denominator isn't 4 hold the wrong amount of music.
test('beatsPerMeasure converts the time signature denominator', () => {
  assert.equal(beatsPerMeasure({ timeSig: '4/4' }), 4);
  assert.equal(beatsPerMeasure({ timeSig: '3/4' }), 3);
  assert.equal(beatsPerMeasure({ timeSig: '2/4' }), 2);
  assert.equal(beatsPerMeasure({ timeSig: '6/8' }), 3);
  assert.equal(beatsPerMeasure({ timeSig: '12/8' }), 6);
  assert.equal(beatsPerMeasure({ timeSig: '3/8' }), 1.5);
  assert.equal(beatsPerMeasure({ timeSig: '2/2' }), 4);
  assert.equal(beatsPerMeasure({ timeSig: '3/2' }), 6);
  assert.equal(beatsPerMeasure({ timeSig: '5/16' }), 1.25);
});

test('beatsPerMeasure falls back to 4/4 for missing or malformed input', () => {
  assert.equal(beatsPerMeasure({}), 4);
  assert.equal(beatsPerMeasure({ timeSig: '' }), 4);
  assert.equal(beatsPerMeasure({ timeSig: 'nonsense' }), 4);
  assert.equal(beatsPerMeasure(undefined), 4);
});

test('every time signature isValidTimeSig accepts yields a positive capacity', () => {
  ['1/1', '4/4', '7/8', '9/16', '13/32', '2/2'].forEach((timeSig) => {
    assert.ok(isValidTimeSig(timeSig), `${timeSig} should be valid`);
    assert.ok(beatsPerMeasure({ timeSig }) > 0, `${timeSig} should have capacity`);
  });
});

test('measureCapacity applies the pickup length to measure 0 only', () => {
  const score = { timeSig: '4/4', pickupBeats: 1 };
  assert.equal(measureCapacity(score, 0), 1);
  assert.equal(measureCapacity(score, 1), 4);
  assert.equal(measureCapacity({ timeSig: '4/4', pickupBeats: 0 }, 0), 4);
});

test('measureCapacity combines pickup with a non-quarter denominator', () => {
  // 6/8 holds 3 quarter notes; a 1-beat pickup is still 1 quarter note.
  const score = { timeSig: '6/8', pickupBeats: 1 };
  assert.equal(measureCapacity(score, 0), 1);
  assert.equal(measureCapacity(score, 1), 3);
});

test('durationBeats handles dots', () => {
  assert.equal(durationBeats('q', false), 1);
  assert.equal(durationBeats('q', true), 1.5);
  assert.equal(durationBeats('h', true), 3);
  assert.equal(durationBeats('8', true), 0.75);
});

test('tupletNotesOccupied uses the conventional grouping', () => {
  assert.equal(tupletNotesOccupied(3), 2); // 3 in the time of 2
  assert.equal(tupletNotesOccupied(5), 4); // 5 in the time of 4
  assert.equal(tupletNotesOccupied(7), 4); // 7 in the time of 4
});

test('noteBeats shortens tuplet members', () => {
  const plain = { duration: '8', dotted: false };
  assert.equal(noteBeats(plain), 0.5);

  const triplet = { duration: '8', dotted: false, tupletId: 'x', tupletCount: 3 };
  // three of these fill one quarter note
  assert.ok(Math.abs(noteBeats(triplet) * 3 - 1) < 1e-9);

  const quintuplet = { duration: '16', dotted: false, tupletId: 'x', tupletCount: 5 };
  assert.ok(Math.abs(noteBeats(quintuplet) * 5 - 1) < 1e-9);
});

test('detectChordCandidates identifies exact triads and sevenths', () => {
  // C E G
  assert.deepEqual(detectChordCandidates(new Set([0, 4, 7])), ['C']);
  // A C E -> Am
  assert.deepEqual(detectChordCandidates(new Set([9, 0, 4])), ['Am']);
  // G B D F -> G7
  assert.deepEqual(detectChordCandidates(new Set([7, 11, 2, 5])), ['G7']);
});

test('detectChordCandidates returns several readings for a symmetric chord', () => {
  // A diminished seventh is the same shape from any of its four roots, so it
  // legitimately has no single answer — callers show these as tentative.
  const candidates = detectChordCandidates(new Set([0, 3, 6, 9]));
  assert.equal(candidates.length, 4);
  candidates.forEach((c) => assert.ok(c.endsWith('dim7')));
});

test('detectChordCandidates gives nothing for too few pitches', () => {
  assert.deepEqual(detectChordCandidates(new Set()), []);
  assert.deepEqual(detectChordCandidates(new Set([0])), []);
});

test('keySignatureAccidentalForLetter reflects the key signature', () => {
  assert.equal(keySignatureAccidentalForLetter('G', 'F'), '#'); // G major raises F
  assert.equal(keySignatureAccidentalForLetter('G', 'C'), '');
  assert.equal(keySignatureAccidentalForLetter('F', 'B'), 'b'); // F major lowers B
  assert.equal(keySignatureAccidentalForLetter('C', 'F'), '');
  // A minor key shares its relative major's accidentals.
  assert.equal(keySignatureAccidentalForLetter('Em', 'F'), '#');
});
