// 連桁(beam)をどう区切るか — 拍子ごとのグルーピング規則。
//
// LilyPond の scm/time-signature-settings.scm が拍子ごとに定める
// baseMoment / beatStructure / beamExceptions をそのまま移植したもの。
// (https://lilypond.org/doc/v2.24/Documentation/notation/beams)
//
// 描画そのものからは切り離してある: ここは「どの音符とどの音符を1本の連桁で
// つなぐか」だけを決め、実際に線を引くのは staffRenderer の役目。規則が正しく
// 効いているかを描画なしで確かめられるようにするため(test/beamGroups.test.js)。
import { noteBeats } from './scoreModel.js';

// beats      … baseMoment × beatStructure。例外に当たらない音価の既定の区切り。
// exceptions … 「連桁の種類」(その群でいちばん短い音符の音価)ごとの特別な区切り。
//              キーは音価の分母(8 = 8分音符、16 = 16分音符…)。
//
// 単位はすべて4分音符 = 1。たとえば 4/4 は
//   beats [1,1,1,1]        … 16分音符は1拍ずつ
//   exceptions {8: [2,2]}  … 8分音符は半小節(4つ)ずつ ＝ LilyPond の end 1/8 → (4 4)
// となり、VexFlow の既定(拍子を問わず常に4分音符ぶん＝8分音符2つずつ)とは違う。
export const BEAM_SETTINGS = {
  '2/2': { beats: [2, 2], exceptions: { 32: [1, 1, 1, 1] } },
  '3/2': { beats: [2, 2, 2], exceptions: { 32: [1, 1, 1, 1, 1, 1] } },
  '2/4': { beats: [1, 1], exceptions: {} },
  '3/4': { beats: [1, 1, 1], exceptions: { 8: [3] } },
  '4/4': { beats: [1, 1, 1, 1], exceptions: { 8: [2, 2] } },
  '6/4': { beats: [3, 3], exceptions: { 16: [1, 1, 1, 1, 1, 1] } },
  '3/8': { beats: [0.5, 0.5, 0.5], exceptions: { 8: [1.5] } },
  '4/8': { beats: [1, 1], exceptions: {} },
  '5/8': { beats: [1.5, 1], exceptions: {} },
  '6/8': { beats: [1.5, 1.5], exceptions: {} },
  '8/8': { beats: [1.5, 1.5, 1], exceptions: {} },
  '9/8': { beats: [1.5, 1.5, 1.5], exceptions: {} },
  '12/8': { beats: [1.5, 1.5, 1.5, 1.5], exceptions: {} },
};

// 表に載っていない拍子のための LilyPond の既定の導き方: baseMoment は
// 1/分母、拍構造は分母が8以上で分子が3の倍数なら3つずつ(複合拍子)、
// それ以外は分子ぶんの1つずつ。
export function beamSettingsFor(timeSig) {
  // 4/4 と 2/2 は数字でも記号(C / ¢)でも書けるが、拍子そのものは同じもの。
  const normalized = { C: '4/4', c: '4/4', 'C|': '2/2' }[timeSig] || timeSig;
  const known = BEAM_SETTINGS[normalized];
  if (known) return known;
  const [num, den] = String(normalized || '4/4').split('/').map(Number);
  if (!num || !den) return BEAM_SETTINGS['4/4'];
  const base = 4 / den;
  if (den >= 8 && num % 3 === 0) {
    return { beats: Array(num / 3).fill(base * 3), exceptions: {} };
  }
  return { beats: Array(num).fill(base), exceptions: {} };
}

// 連桁を組めるのは8分音符より短い音符だけ(4分音符以上には旗も連桁もない)。
const BEAMABLE_DURATIONS = new Set(['8', '16', '32']);

export function isBeamableNote(note) {
  return !!note && !note.isRest && BEAMABLE_DURATIONS.has(note.duration);
}

// 小節頭からの位置 offset が、区切り長 groups の何番目の群に入るか。
// groups は小節をまたいで繰り返し使う(LilyPond の beatStructure と同じ扱い)。
function beamGroupIndexAt(offset, groups) {
  let acc = 0;
  let index = 0;
  let guard = 0;
  while (acc + groups[index % groups.length] <= offset + 1e-6) {
    acc += groups[index % groups.length];
    index += 1;
    guard += 1;
    if (guard > 1024) break; // 0長の区切りが紛れ込んでも無限ループしない保険
  }
  return index;
}

// 1小節ぶん(1パート)の音符列を、連桁でつなぐ群に分ける。
// 返すのは notes の添字の配列の配列で、2つ以上つながる群だけが入る。
//
// 群の切れ目になるのは
//   ・休符、および8分音符より長い音符 (LilyPond:「連桁は休符や小節線をまたがない」)
//   ・拍子から決まる区切り位置
//   ・利用者が明示した beamBreak
// の3つ。連符は LilyPond の 1/12 などの例外がちょうど拍構造と一致するので、
// 拍構造をそのまま使う。
export function beamGroupsForMeasure(notes, timeSig) {
  const setting = beamSettingsFor(timeSig);
  // 小節頭からの位置を音符ごとに求める(休符も含めて詰めていく)
  let cursor = 0;
  const starts = notes.map((n) => {
    const start = cursor;
    cursor += noteBeats(n);
    return start;
  });

  // まず「連桁を組める音符が連続している区間」に切り分ける
  const runs = [];
  let run = [];
  const flushRun = () => { if (run.length > 0) runs.push(run); run = []; };
  notes.forEach((n, i) => {
    if (!isBeamableNote(n)) { flushRun(); return; }
    if (n.beamBreak) flushRun();
    run.push(i);
  });
  flushRun();

  const groups = [];
  runs.forEach((indices) => {
    const hasTuplet = indices.some((i) => notes[i].tupletId);
    // 「連桁の種類」= その区間でいちばん短い音符の音価
    const shortest = indices.reduce((acc, i) => Math.max(acc, Number(notes[i].duration)), 0);
    const lengths = (!hasTuplet && setting.exceptions[shortest]) || setting.beats;
    // 区切り位置をまたぐところで区間をさらに割る
    let current = [];
    let currentIndex = null;
    const emit = () => {
      if (current.length >= 2) groups.push(current);
      current = [];
    };
    indices.forEach((i) => {
      const groupIndex = beamGroupIndexAt(starts[i], lengths);
      if (currentIndex !== null && groupIndex !== currentIndex) emit();
      currentIndex = groupIndex;
      current.push(i);
    });
    emit();
  });
  return groups;
}
