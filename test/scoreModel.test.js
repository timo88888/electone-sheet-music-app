import test from 'node:test';
import assert from 'node:assert/strict';

import {
  beatsPerMeasure, measureCapacity, noteBeats, durationBeats,
  tupletNotesOccupied, detectChordCandidates, keySignatureAccidentalForLetter,
  isValidTimeSig, chordRootNames, displayChordSymbol,
  detectChordSymbols, chordContextForLowerNote, splitBassNote,
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

// コードの根音は調号に合わせた音名で綴る。ヘ長調の「シ♭」を A# と書くのは
// 同じ高さでも読み手にとって別物なので、調号どおりの綴りにする。
test('detectChordCandidates spells roots to match the key signature', () => {
  const bFlatMajor = new Set([10, 2, 5]); // B♭ D F
  assert.deepEqual(detectChordCandidates(bFlatMajor, 'F'), ['Bb']);
  assert.deepEqual(detectChordCandidates(bFlatMajor, 'Bb'), ['Bb']);
  // ♯系の調では同じ高さを A# と綴る
  assert.deepEqual(detectChordCandidates(bFlatMajor, 'D'), ['A#']);
  // ♯♭なしの調はポピュラー音楽の慣習に合わせて♭寄り
  assert.deepEqual(detectChordCandidates(bFlatMajor, 'C'), ['Bb']);
});

test('detectChordCandidates keeps natural roots unchanged whatever the key', () => {
  const gMajor = new Set([7, 11, 2]);
  assert.deepEqual(detectChordCandidates(gMajor, 'F'), ['G']);
  assert.deepEqual(detectChordCandidates(gMajor, 'D'), ['G']);
});

test('displayChordSymbol re-spells a stored chord for the current key', () => {
  assert.equal(displayChordSymbol('A#m7', 'F'), 'Bbm7');
  assert.equal(displayChordSymbol('Bbm7', 'D'), 'A#m7');
  assert.equal(displayChordSymbol('Cmaj7', 'F'), 'Cmaj7');
  // 読み取れないものはそのまま返す
  assert.equal(displayChordSymbol('', 'F'), '');
  assert.equal(displayChordSymbol('N.C.', 'F'), 'N.C.');
});

test('chordRootNames follows the key signature type', () => {
  assert.equal(chordRootNames('F')[10], 'Bb');
  assert.equal(chordRootNames('G')[10], 'A#');
  assert.equal(chordRootNames('C')[10], 'Bb');
  assert.equal(chordRootNames('C')[6], 'F#');
});

// --- 分数コード(オンコード) ---

const CTX = (lower, pedal = []) => chordContextForLowerNote(
  {
    lower: [{
      keys: lower.map((k) => ({ key: k })), duration: 'w', dotted: false, isRest: false,
    }],
    pedal: pedal.map((k) => ({
      keys: [{ key: k }], duration: 'w', dotted: false, isRest: false,
    })),
  },
  0,
);

test('転回形はベース音つきで読む — ドミソをミで支えれば C on E', () => {
  assert.deepEqual(detectChordSymbols(CTX(['c/4', 'e/4', 'g/4'], ['e/2'])), ['C on E']);
  assert.deepEqual(detectChordSymbols(CTX(['c/4', 'e/4', 'g/4'], ['g/2'])), ['C on G']);
});

test('ベース音が根音と同じならただの和音として書く', () => {
  assert.deepEqual(detectChordSymbols(CTX(['c/4', 'e/4', 'g/4'], ['c/2'])), ['C']);
  // ペダルがなければ下鍵盤のいちばん下の音がベース
  assert.deepEqual(detectChordSymbols(CTX(['c/4', 'e/4', 'g/4'])), ['C']);
});

test('ベース音が和音の構成音でなくても読める — C on D', () => {
  // 全部混ぜるとどの和音にも当てはまらないので、下鍵盤だけで和音を決める
  assert.deepEqual(detectChordSymbols(CTX(['c/4', 'e/4', 'g/4'], ['d/2'])), ['C on D']);
  assert.deepEqual(detectChordSymbols(CTX(['d/4', 'f/4', 'a/4'], ['g/2'])), ['Dm on G']);
});

test('ペダルが和音の三音目を補う従来の形は変わらない', () => {
  // 下鍵盤がミソだけでも、ペダルのドと合わせて C
  assert.deepEqual(detectChordSymbols(CTX(['e/4', 'g/4'], ['c/2'])), ['C']);
});

test('ベース音の綴りも調号に従う', () => {
  assert.deepEqual(detectChordSymbols(CTX(['c/4', 'e/4', 'g/4'], ['d#/2']), 'F'), ['C on Eb']);
  assert.deepEqual(detectChordSymbols(CTX(['c/4', 'e/4', 'g/4'], ['d#/2']), 'D'), ['C on D#']);
});

test('ベース音は音名ではなく実際の高さで決める', () => {
  // ミ(e/3)はド(c/4)より低い。音名の番号(ド=0)だけで比べると取り違える
  assert.deepEqual(detectChordSymbols(CTX(['e/3', 'c/4', 'g/4'])), ['C on E']);
});

test('ペダルが和音に足りる音なら7thなどとして読む', () => {
  // ドミソ + シ♭ は C7 の第3転回形。ベース音を足すだけでなく和音そのものが変わる
  assert.deepEqual(detectChordSymbols(CTX(['c/4', 'e/4', 'g/4'], ['a#/2']), 'F'), ['C7 on Bb']);
});

test('splitBassNote は on とスラッシュの両方を読む', () => {
  assert.deepEqual(splitBassNote('C on E'), { chord: 'C', bass: 'E' });
  assert.deepEqual(splitBassNote('Cm7/G'), { chord: 'Cm7', bass: 'G' });
  assert.deepEqual(splitBassNote('C'), { chord: 'C', bass: '' });
  assert.deepEqual(splitBassNote(''), { chord: '', bass: '' });
});

test('displayChordSymbol は分数コードの両側を調号に合わせて綴り直す', () => {
  assert.equal(displayChordSymbol('A#m7 on C#', 'F'), 'Bbm7 on Db');
  assert.equal(displayChordSymbol('Bbm7 on Db', 'D'), 'A#m7 on C#');
  assert.equal(displayChordSymbol('C/E', 'C'), 'C on E');
});
