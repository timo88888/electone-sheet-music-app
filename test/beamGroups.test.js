import test from 'node:test';
import assert from 'node:assert/strict';

import { beamGroupsForMeasure, beamSettingsFor } from '../src/renderer/beamGroups.js';

// 連桁の区切りかたは LilyPond の scm/time-signature-settings.scm に合わせてある
// (https://lilypond.org/doc/v2.24/Documentation/notation/beams)。
// 拍子ごとの規則が効いていることを、描画なしで確かめる。

const n = (duration, extra = {}) => ({ duration, dotted: false, isRest: false, ...extra });
const rest = (duration) => ({ duration, dotted: false, isRest: true });
const times = (count, make) => Array.from({ length: count }, (_, i) => make(i));

test('4/4 の8分音符は半小節ずつ(LilyPond の end 1/8 → (4 4))', () => {
  const notes = times(8, () => n('8'));
  assert.deepEqual(beamGroupsForMeasure(notes, '4/4'), [[0, 1, 2, 3], [4, 5, 6, 7]]);
});

test('4/4 の16分音符は1拍ずつ(例外がないので beatStructure どおり)', () => {
  const notes = times(16, () => n('16'));
  assert.deepEqual(beamGroupsForMeasure(notes, '4/4'), [
    [0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15],
  ]);
});

test('3/4 の8分音符は小節まるごと1本(end 1/8 → (6))', () => {
  const notes = times(6, () => n('8'));
  assert.deepEqual(beamGroupsForMeasure(notes, '3/4'), [[0, 1, 2, 3, 4, 5]]);
});

test('3/4 の16分音符は1拍ずつ', () => {
  const notes = times(12, () => n('16'));
  assert.deepEqual(beamGroupsForMeasure(notes, '3/4'), [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]]);
});

test('6/8 の8分音符は3つずつ(複合拍子の拍構造)', () => {
  const notes = times(6, () => n('8'));
  assert.deepEqual(beamGroupsForMeasure(notes, '6/8'), [[0, 1, 2], [3, 4, 5]]);
});

test('9/8・12/8 も付点4分音符ごとにまとまる', () => {
  assert.deepEqual(
    beamGroupsForMeasure(times(9, () => n('8')), '9/8'),
    [[0, 1, 2], [3, 4, 5], [6, 7, 8]],
  );
  assert.deepEqual(
    beamGroupsForMeasure(times(12, () => n('8')), '12/8'),
    [[0, 1, 2], [3, 4, 5], [6, 7, 8], [9, 10, 11]],
  );
});

test('2/4 は例外がないので8分音符も1拍ずつ', () => {
  assert.deepEqual(beamGroupsForMeasure(times(4, () => n('8')), '2/4'), [[0, 1], [2, 3]]);
});

test('2/2 の8分音符は2分音符の拍ごと＝半小節ずつ', () => {
  assert.deepEqual(
    beamGroupsForMeasure(times(8, () => n('8')), '2/2'),
    [[0, 1, 2, 3], [4, 5, 6, 7]],
  );
});

test('5/8 は 3+2 に分かれる(不等拍の拍構造)', () => {
  assert.deepEqual(beamGroupsForMeasure(times(5, () => n('8')), '5/8'), [[0, 1, 2], [3, 4]]);
});

// LilyPond:「連桁は休符や小節線をまたがない」
test('休符は連桁を切る', () => {
  const notes = [n('8'), n('8'), n('8'), n('8'), rest('8'), n('8'), n('8'), n('8')];
  assert.deepEqual(beamGroupsForMeasure(notes, '4/4'), [[0, 1, 2, 3], [5, 6, 7]]);
});

// 休符で切れた続きも、拍子から決まる区切りをまたぐことはできない。
// 下の例は8分音符が半小節の境目(2拍目の裏と3拍目)にまたがるので、
// どちらも1つきりの群になり連桁にはならない。
test('休符のあとの続きも半小節の境目はまたがない', () => {
  const notes = [n('8'), n('8'), rest('8'), n('8'), n('8')];
  assert.deepEqual(beamGroupsForMeasure(notes, '4/4'), [[0, 1]]);
});

test('4分音符以上は連桁にならず、そこで群も切れる', () => {
  const notes = [n('8'), n('8'), n('q'), n('8'), n('8')];
  assert.deepEqual(beamGroupsForMeasure(notes, '4/4'), [[0, 1], [3, 4]]);
});

test('ひとりぼっちの8分音符は連桁にならない(旗のまま)', () => {
  const notes = [n('8'), n('q'), n('q'), n('q'), n('q')];
  assert.deepEqual(beamGroupsForMeasure(notes, '4/4'), []);
});

// 拍子から決まる区切りより手前で切りたいときの手動指定。
test('beamBreak を付けた音符から新しい群が始まる', () => {
  const notes = times(8, (i) => n('8', i === 2 ? { beamBreak: true } : {}));
  assert.deepEqual(beamGroupsForMeasure(notes, '4/4'), [[0, 1], [2, 3], [4, 5, 6, 7]]);
});

// 連符の中では音符が短くなるので、位置の計算も連符ぶんを織り込む必要がある。
test('4/4 の3連符は1拍ごとにまとまる', () => {
  const notes = [
    ...times(3, () => n('8', { tupletId: 't1', tupletCount: 3 })),
    ...times(3, () => n('8', { tupletId: 't2', tupletCount: 3 })),
    n('q'), n('q'),
  ];
  assert.deepEqual(beamGroupsForMeasure(notes, '4/4'), [[0, 1, 2], [3, 4, 5]]);
});

// 群の中でいちばん短い音符が「連桁の種類」を決める。8分音符だけなら半小節、
// 16分音符が混ざればその群は1拍ずつになる。
test('16分音符が混ざった群は1拍ずつに切れる', () => {
  const notes = [n('8'), n('8'), n('16'), n('16'), n('8'), n('8'), n('8')];
  assert.deepEqual(beamGroupsForMeasure(notes, '4/4'), [[0, 1], [2, 3, 4], [5, 6]]);
});

test('拍子記号の C / C| は 4/4 / 2/2 と同じに扱う', () => {
  assert.deepEqual(beamSettingsFor('C'), beamSettingsFor('4/4'));
  assert.deepEqual(beamSettingsFor('C|'), beamSettingsFor('2/2'));
});

test('表にない拍子は LilyPond の既定の導き方にならう', () => {
  // 分母8以上で分子が3の倍数なら複合拍子として3つずつ
  assert.deepEqual(beamSettingsFor('15/8').beats, [1.5, 1.5, 1.5, 1.5, 1.5]);
  // それ以外は分子ぶんの1拍ずつ
  assert.deepEqual(beamSettingsFor('7/8').beats, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  assert.deepEqual(beamSettingsFor('5/4').beats, [1, 1, 1, 1, 1]);
  // 壊れた入力は 4/4 扱い
  assert.deepEqual(beamSettingsFor('nonsense'), beamSettingsFor('4/4'));
});
