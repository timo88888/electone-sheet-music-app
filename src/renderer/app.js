import {
  PARTS, PART_CLEF, CLEF_OPTIONS, CLEF_LABELS, KEY_SIGNATURES, CHORD_ROOTS, CHORD_QUALITY_OPTIONS,
  TEMPO_NOTE_VALUES, DURATION_LABELS, effectiveQuarterBpm,
  detectChordCandidates, chordPitchClassesForLowerNote,
  REHEARSAL_OPTIONS, REGISTRATION_OPTIONS,
  createEmptyScore, createEmptyMeasure, makeNoteId, noteAnnotationDefaults,
  durationBeats, beatsPerMeasure, measureCapacity, isValidTimeSig,
  tupletNotesOccupied, noteBeats, noteBeatWindow,
} from './scoreModel.js';
import {
  renderScore, LAYOUT, hitBandAbove, hitBandBelow,
} from './staffRenderer.js';
import {
  pitchForIndex, indexForY, transposeKey, parseKey, buildKey,
} from './pitchMap.js';
import {
  Player, renderScoreToWavBuffer, buildPlaybackEvents, PLAYBACK_LEAD, DEFAULT_INSTRUMENT, pitchToMidi,
} from './playback.js';
import { buildMidiFile } from './midiExport.js';
import {
  pitchKeyOf, pruneDanglingLinks, retargetLinksTo, retargetLinksAfterTranspose,
  cloneNotesWithFreshIds as cloneNotesWithFreshIdsPure,
} from './noteLinks.js';
import { getSoundfontNames } from '../../node_modules/smplr/dist/index.mjs';

// Tempo marking note icon, drawn as inline SVG (see renderTitleHeader) —
// same paths as the 音符 ribbon's duration-select icons, reused here so the
// glyph always renders correctly regardless of which fonts happen to be
// installed (the Unicode musical-symbols codepoints this used to use are
// outside most system fonts' coverage).
const TEMPO_NOTE_ICON_SVG = {
  w: '<svg viewBox="0 0 24 24" width="16" height="16"><ellipse cx="12" cy="13" rx="6.5" ry="4.3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  h: '<svg viewBox="0 0 24 24" width="16" height="16"><ellipse cx="9" cy="17" rx="4.6" ry="3.3" fill="none" stroke="currentColor" stroke-width="2"/><line x1="13.4" y1="17" x2="13.4" y2="3" stroke="currentColor" stroke-width="2"/></svg>',
  q: '<svg viewBox="0 0 24 24" width="16" height="16"><ellipse cx="9" cy="17" rx="4.6" ry="3.3" fill="currentColor"/><line x1="13.4" y1="17" x2="13.4" y2="3" stroke="currentColor" stroke-width="2"/></svg>',
  8: '<svg viewBox="0 0 24 24" width="16" height="16"><ellipse cx="9" cy="17" rx="4.6" ry="3.3" fill="currentColor"/><line x1="13.4" y1="17" x2="13.4" y2="3" stroke="currentColor" stroke-width="2"/><path d="M13.4,3 C19,6 19,10 13.6,11.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  16: '<svg viewBox="0 0 24 24" width="16" height="16"><ellipse cx="9" cy="17" rx="4.6" ry="3.3" fill="currentColor"/><line x1="13.4" y1="17" x2="13.4" y2="3" stroke="currentColor" stroke-width="2"/><path d="M13.4,3 C19,5.5 19,8.5 13.6,10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M13.4,7.5 C19,10 19,13 13.6,14.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

// Upgrades a score loaded from an older save file.
// - `note.keys` used to be an array of plain VexFlow key strings with
//   tie/slur stored on the note itself; it's now an array of per-tone
//   objects ({ key, tieToNext, slurTo }) so each pitch in a chord can carry
//   its own tie/slur independently.
// - Slur used to be a same-pitch-only 'start'/'end' marker resolved by
//   position; it's now an explicit { noteId, pitchKey } link on the starting
//   tone, resolved to any pitch. Old slurs can't be losslessly converted (the
//   link target isn't recoverable from 'start'/'end' alone), so they're
//   dropped — ties are unaffected.
// - The タイ/スラー "declare then fill a placeholder rest" input flow (and
//   its isPlaceholder/pendingSlurEnd/partialChordNote bookkeeping) is gone;
//   any leftover placeholder rests from that flow are just plain rests now.
function migrateScore(loaded) {
  (loaded.measures || []).forEach((measure) => {
    if (measure.lineBreak === undefined) measure.lineBreak = false;
    if (!measure.marks) measure.marks = [];
    if (measure.lyric === undefined) measure.lyric = '';
    // 歌詞 used to live on individual notes (one syllable each); now it's one
    // line of text per measure's line. Best-effort: join whatever syllables
    // this measure's notes had, in order, into one string.
    PARTS.forEach((part) => {
      (measure[part] || []).forEach((n) => {
        if (n.lyric) measure.lyric = measure.lyric ? `${measure.lyric} ${n.lyric}` : n.lyric;
        delete n.lyric;
      });
    });
    // 歌詞 then became one shared line per system (not per staff); now each
    // staff (上鍵盤/下鍵盤/ペダル) gets its own line. Best-effort: the old
    // shared value most often belonged to the melody, so it lands on 上鍵盤.
    if (!measure.lyrics) measure.lyrics = { upper: measure.lyric || '', lower: '', pedal: '' };
    delete measure.lyric;
    // n番括弧 used to span a measure *range* ({ number, span }); it's now
    // always exactly one measure, set on a single 対象小節. An old multi-
    // measure bracket keeps its number and simply shrinks to its first
    // measure — the surplus measures had no marking of their own to preserve.
    if (measure.volta === undefined) measure.volta = null;
    if (measure.volta && measure.volta.span !== undefined) delete measure.volta.span;
    // コード used to live on the measure; now it's per-note. Best-effort
    // carry the old per-measure value onto the first 下鍵盤 note (a
    // hand-typed chord existed only because someone entered it, so treat it
    // as locked — same as before — rather than letting auto-detection
    // immediately second-guess it).
    PARTS.forEach((part) => {
      (measure[part] || []).forEach((n) => {
        if (n.chord === undefined) n.chord = '';
        if (n.chordLocked === undefined) n.chordLocked = false;
        if (n.chordTentative === undefined) n.chordTentative = false;
      });
    });
    if (measure.chord && measure.lower && measure.lower[0]) {
      measure.lower[0].chord = measure.chord;
      measure.lower[0].chordLocked = true;
    }
    // A very old file (before リハーサル existed) had one free-text
    // registration per measure — attach it at beat 0.
    if (measure.registration) {
      findOrCreateMark(measure, 0).registration = measure.registration;
    }
    delete measure.chord;
    delete measure.chordLocked;
    delete measure.chordTentative;
    delete measure.registration;
    // A more recent save stored リハーサル/レジストレーション per-note —
    // fold each into the shared per-beat marks list (see findOrCreateMark)
    // and drop the now-unused note fields.
    PARTS.forEach((part) => {
      (measure[part] || []).forEach((n, idx) => {
        if (n.rehearsal || n.registration) {
          const beat = noteBeatWindow(measure, part, idx).start;
          const entry = findOrCreateMark(measure, beat);
          if (n.rehearsal) entry.rehearsal = n.rehearsal;
          if (n.registration) entry.registration = n.registration;
        }
        delete n.rehearsal;
        delete n.registration;
      });
    });
    PARTS.forEach((part) => {
      (measure[part] || []).forEach((n) => {
        if (n.keys && n.keys.length && typeof n.keys[0] === 'string') {
          n.keys = n.keys.map((k) => ({
            key: k, tieToNext: !!n.tieToNext, slurTo: null, glissandoTo: null,
          }));
          delete n.tieToNext;
          delete n.slur;
        } else {
          (n.keys || []).forEach((tone) => {
            if (tone.slurTo === undefined) tone.slurTo = null;
            if (tone.glissandoTo === undefined) tone.glissandoTo = null;
            delete tone.slur;
            delete tone.pendingSlurEnd;
          });
        }
        delete n.partialChordNote;
      });
    });
  });
  if (!loaded.bpm) loaded.bpm = 100;
  if (!loaded.bpmNoteValue) loaded.bpmNoteValue = 'q';
  if (!loaded.timeSigDisplay) loaded.timeSigDisplay = 'numeric';
  if (loaded.showChordSymbols === undefined) loaded.showChordSymbols = true;
  if (!loaded.measureWidthScale) loaded.measureWidthScale = 1;
  if (!loaded.instruments) loaded.instruments = {};
  PARTS.forEach((part) => {
    if (!loaded.instruments[part]) loaded.instruments[part] = DEFAULT_INSTRUMENT;
  });
  if (!loaded.shapes) loaded.shapes = [];
  const defaultFieldStyle = (size) => ({ fontFamily: 'Hiragino Sans, Yu Gothic, serif', fontSize: size });
  if (!loaded.titleStyle) loaded.titleStyle = defaultFieldStyle(22);
  if (!loaded.composerStyle) loaded.composerStyle = defaultFieldStyle(12);
  if (!loaded.lyricistStyle) loaded.lyricistStyle = defaultFieldStyle(12);
  return loaded;
}

let score = createEmptyScore();
let history = [structuredClone(score)];
let historyIndex = 0;
// The history-index position at the last save/open/new — if the current
// position differs, there are unsaved edits (see the close-confirmation
// handler below). Undo/redo back to this exact index counts as "not dirty".
let savedHistoryIndex = 0;

let selectedDuration = 'q';
let selectedDotted = false;
let selectedRest = false;
let selectedAccidental = ''; // '' (unspecified), '#', 'b', or 'n' (explicit natural)

let zoom = 1;
let selected = null; // { measureIndex, part, noteId, keyIndex } — keyIndex picks one tone within a chord
let hitMap = [];
let annotationHitMap = [];
let markHitMap = [];
let timeSigHitMap = [];
// The stave gap the current render actually used (see computeRequiredStaveGap
// in staffRenderer.js) — hit-testing scales its bands to it.
let layoutStaveGap = LAYOUT.staveGap;
let dragging = null;
let rangeDragging = null; // { part, page, startMeasure, endMeasure }
let rangeSelection = null; // { part, measureStart, measureEnd }
let clipboard = null; // { part, measures: [[note,...], ...] }
let pendingClick = null; // { pageIndex, region, startClientX, startClientY, localY }
let selectedLink = null; // null | 'tuplet3' | 'tuplet5' | 'tuplet7' — see insertNote
let pendingSlurStart = null; // { measureIndex, part, noteId, keyIndex } | null — see toggleSlurFromSelectedTone
let pendingGlissandoStart = null; // { measureIndex, part, noteId, keyIndex } | null — see toggleGlissandoFromSelectedTone
let multiSelected = []; // { measureIndex, part, noteId, keyIndex }[] — Ctrl/Cmd+click, see showMultiSelectContextMenu
let selectedMeasureIndex = null;
// Whole-note (chord-as-one-unit) range selection — built by dragging
// horizontally from an existing note (see onPageMouseDown/mousemove). Unlike
// multiSelected (tone-granular, Ctrl/Cmd+click, for タイ/スラー/連符), this is
// note-granular and exists for the 右クリック→コピー/削除/ペースト flow below.
// null, or an ordered array of { measureIndex, part, noteId } once it spans
// 2+ notes — a drag that never leaves its starting note just leaves the
// plain single `selected` in place instead (see the "範囲選択は和音1セット
// から" note in the user's own spec).
let noteRangeSelection = null;
let noteClipboard = null; // note[] (deep clones) — see copyNoteRangeSelection/pasteNotesAt
let highlightTimers = [];
let highlightEls = [];
const DRAG_THRESHOLD = 6;

const player = new Player();

// A short confirmation blip when a note is actually inserted/added (see
// insertNote/addPitchToNote) — audio feedback for what pitch just landed,
// using the same per-part instrument playback already uses. Errors (e.g. no
// audio output, sample fetch failure) are swallowed: a failed blip shouldn't
// block the note from being inserted.
async function playInsertedNoteBlip(part, key) {
  try {
    await player.ensureInstruments(score.instruments);
    player.instruments[part].start({ note: pitchToMidi(key), duration: 0.35, velocity: 90 });
  } catch (err) {
    // no-op — see comment above
  }
}

const scoreContainer = document.getElementById('score-container');
const statusEl = document.getElementById('status');

function setStatus(msg) {
  statusEl.textContent = msg;
  if (msg) setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 2500);
}

// ---------- prompt/confirm modal (Electron doesn't implement window.prompt()) ----------

const promptModalEl = document.getElementById('prompt-modal');
const promptModalTitleEl = document.getElementById('prompt-modal-title');
const promptModalInputEl = document.getElementById('prompt-modal-input');
const promptModalOkBtn = document.getElementById('prompt-modal-ok');
const promptModalCancelBtn = document.getElementById('prompt-modal-cancel');

function showPromptModal(title, defaultValue) {
  return new Promise((resolve) => {
    promptModalTitleEl.textContent = title;
    promptModalInputEl.value = defaultValue || '';
    promptModalEl.hidden = false;
    promptModalInputEl.focus();
    promptModalInputEl.select();

    const cleanup = () => {
      promptModalEl.hidden = true;
      promptModalOkBtn.removeEventListener('click', onOk);
      promptModalCancelBtn.removeEventListener('click', onCancel);
      promptModalInputEl.removeEventListener('keydown', onKeydown);
    };
    const onOk = () => { const v = promptModalInputEl.value; cleanup(); resolve(v); };
    const onCancel = () => { cleanup(); resolve(null); };
    const onKeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); } else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    promptModalOkBtn.addEventListener('click', onOk);
    promptModalCancelBtn.addEventListener('click', onCancel);
    promptModalInputEl.addEventListener('keydown', onKeydown);
  });
}

const confirmModalEl = document.getElementById('confirm-modal');
const confirmModalMessageEl = document.getElementById('confirm-modal-message');
const confirmModalOkBtn = document.getElementById('confirm-modal-ok');
const confirmModalCancelBtn = document.getElementById('confirm-modal-cancel');

function showConfirmModal(message) {
  return new Promise((resolve) => {
    confirmModalMessageEl.textContent = message;
    confirmModalEl.hidden = false;
    const cleanup = () => {
      confirmModalEl.hidden = true;
      confirmModalOkBtn.removeEventListener('click', onOk);
      confirmModalCancelBtn.removeEventListener('click', onCancel);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    confirmModalOkBtn.addEventListener('click', onOk);
    confirmModalCancelBtn.addEventListener('click', onCancel);
  });
}

// ---------- chord select modal (root + quality, instead of free text) ----------

const chordModalEl = document.getElementById('chord-modal');
const chordModalTitleEl = document.getElementById('chord-modal-title');
const chordModalRootEl = document.getElementById('chord-modal-root');
const chordModalQualityEl = document.getElementById('chord-modal-quality');
const chordModalOkBtn = document.getElementById('chord-modal-ok');
const chordModalCancelBtn = document.getElementById('chord-modal-cancel');

const NO_CHORD_ROOT = '';
(function populateChordModalSelects() {
  const noneOpt = document.createElement('option');
  noneOpt.value = NO_CHORD_ROOT;
  noneOpt.textContent = '(コードなし)';
  chordModalRootEl.appendChild(noneOpt);
  CHORD_ROOTS.forEach((root) => {
    const opt = document.createElement('option');
    opt.value = root;
    opt.textContent = root;
    chordModalRootEl.appendChild(opt);
  });
  CHORD_QUALITY_OPTIONS.forEach((q) => {
    const opt = document.createElement('option');
    opt.value = q.value;
    opt.textContent = q.label;
    chordModalQualityEl.appendChild(opt);
  });
}());

// Splits a stored chord string ("F#m7") back into root ("F#") + quality
// ("m7") to preselect the modal when editing an existing chord.
function splitChordSymbol(text) {
  if (!text) return { root: NO_CHORD_ROOT, quality: '' };
  const m = /^([A-Ga-g])([#b]?)(.*)$/.exec(text.trim());
  if (!m) return { root: NO_CHORD_ROOT, quality: '' };
  const root = `${m[1].toUpperCase()}${m[2]}`;
  const quality = m[3].trim();
  const known = CHORD_QUALITY_OPTIONS.some((q) => q.value === quality);
  if (!CHORD_ROOTS.includes(root) || !known) return { root: NO_CHORD_ROOT, quality: '' };
  return { root, quality };
}

function showChordModal(title, currentValue) {
  const { root, quality } = splitChordSymbol(currentValue);
  chordModalTitleEl.textContent = title;
  chordModalRootEl.value = root;
  chordModalQualityEl.value = quality;
  chordModalQualityEl.disabled = root === NO_CHORD_ROOT;
  return new Promise((resolve) => {
    chordModalEl.hidden = false;
    const onRootChange = () => { chordModalQualityEl.disabled = chordModalRootEl.value === NO_CHORD_ROOT; };
    const cleanup = () => {
      chordModalEl.hidden = true;
      chordModalOkBtn.removeEventListener('click', onOk);
      chordModalCancelBtn.removeEventListener('click', onCancel);
      chordModalRootEl.removeEventListener('change', onRootChange);
    };
    const onOk = () => {
      const chosenRoot = chordModalRootEl.value;
      const value = chosenRoot === NO_CHORD_ROOT ? '' : `${chosenRoot}${chordModalQualityEl.value}`;
      cleanup();
      resolve(value);
    };
    const onCancel = () => { cleanup(); resolve(null); };
    chordModalOkBtn.addEventListener('click', onOk);
    chordModalCancelBtn.addEventListener('click', onCancel);
    chordModalRootEl.addEventListener('change', onRootChange);
  });
}

// ---------- 音符間リンク(タイ/スラー/グリッサンド)の整合性 ----------
//
// The rules themselves live in noteLinks.js (pure functions over the score
// model, so they can be unit-tested); these are the thin bindings that supply
// this module's `score` and id generator. See that file for why link
// integrity is centralized rather than handled at each edit site.

// The single way to change a tone's pitch. Everything that moves a note up or
// down goes through here, so links pointing *at* it follow along instead of
// being pruned away as dangling.
function setTonePitch(note, tone, newKey) {
  const oldPitchKey = pitchKeyOf(tone.key);
  tone.key = newKey;
  retargetLinksTo(score, PARTS, note.id, oldPitchKey, pitchKeyOf(newKey));
}

function cloneNotesWithFreshIds(notes) {
  return cloneNotesWithFreshIdsPure(notes, makeNoteId);
}

function pushHistory() {
  pruneDanglingLinks(score, PARTS);
  history = history.slice(0, historyIndex + 1);
  history.push(structuredClone(score));
  historyIndex = history.length - 1;
}

function undo() {
  if (historyIndex <= 0) return;
  historyIndex--;
  score = structuredClone(history[historyIndex]);
  selected = null;
  render();
}

function redo() {
  if (historyIndex >= history.length - 1) return;
  historyIndex++;
  score = structuredClone(history[historyIndex]);
  selected = null;
  render();
}

function markSelection() {
  score.measures.forEach((m) => {
    PARTS.forEach((part) => {
      m[part].forEach((n) => {
        n.selected = !!(selected && n.id === selected.noteId);
        n.selectedKeyIndex = n.selected ? selected.keyIndex : null;
        const multiHits = multiSelected.filter((s) => s.noteId === n.id);
        n.multiSelectedKeyIndices = multiHits.length ? multiHits.map((s) => s.keyIndex) : null;
        n.rangeSelected = !!(noteRangeSelection && noteRangeSelection.some((s) => s.noteId === n.id));
      });
    });
  });
}

// Auto-fills each unlocked 下鍵盤 note's コード from its own pitch content
// plus whatever ペダル note overlaps it — re-run on every render so it
// always reflects the latest notes. A note the user has explicitly set/
// confirmed (chordLocked) is left untouched.
function recomputeAutoChords() {
  score.measures.forEach((measure) => {
    (measure.lower || []).forEach((note, noteIndex) => {
      if (note.isRest || note.isPlaceholder || note.chordLocked) return;
      const candidates = detectChordCandidates(chordPitchClassesForLowerNote(measure, noteIndex));
      if (candidates.length === 0) {
        note.chord = '';
        note.chordTentative = false;
      } else {
        note.chord = candidates[0];
        note.chordTentative = candidates.length > 1;
      }
    });
  });
}

// render() rebuilds every page's SVG from scratch, which is fine for a single
// edit but wasteful during a drag: mousemove can fire many times per frame,
// and only the last one is ever seen. Coalescing to one redraw per animation
// frame keeps dragging responsive on multi-page scores.
let renderQueued = false;
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  markSelection();
  recomputeAutoChords();
  const result = renderScore(scoreContainer, score, LAYOUT);
  // The gap between staves is computed per score (it widens to clear tall
  // ledger lines), and click hit-testing has to use the same value — see
  // hitBandAbove/hitBandBelow.
  layoutStaveGap = result.staveGap;
  hitMap = result.hitMap;
  annotationHitMap = result.annotationHitMap;
  markHitMap = result.markHitMap;
  timeSigHitMap = result.timeSigHitMap;
  attachPageHandlers(result.pages);
  scoreContainer.style.transform = `scale(${zoom})`;
  updateMeasureCount();
  renderRangeHighlight(result.pages);
  renderMeasureNumbers(result.pages);
  renderTitleHeader(result.pages);
  renderShapes(result.pages);
}

function updateMeasureCount() {
  document.getElementById('measure-count').textContent = `小節数: ${score.measures.length}`;
  const targetInput = document.getElementById('measure-target-input');
  const toInput = document.getElementById('transpose-to-input');
  const pasteInput = document.getElementById('paste-target-input');
  targetInput.max = score.measures.length;
  toInput.max = score.measures.length;
  if (!targetInput.value) targetInput.value = 1;
  if (!toInput.value) toInput.value = score.measures.length;
  if (!pasteInput.value) pasteInput.value = 1;
  const fromInput = document.getElementById('transpose-from-input');
  if (!fromInput.value) fromInput.value = 1;
}

function syncControlsFromScore() {
  document.getElementById('title-input').value = score.title;
  document.getElementById('pickup-input').value = score.pickupBeats || 0;
  document.getElementById('timesig-input').value = score.timeSig;
  document.getElementById('keysig-select').value = score.keySignature || 'C';
  bpmInput.value = score.bpm || 100;
  bpmNoteSelect.value = score.bpmNoteValue || 'q';
  document.getElementById('chk-show-chords').checked = score.showChordSymbols !== false;
  updateWidthSliderUI();
  PARTS.forEach((part) => {
    const select = document.getElementById(`clef-${part}`);
    if (select) select.value = score.clefs[part];
    const instrumentSelect = document.getElementById(`instrument-${part}`);
    if (instrumentSelect) instrumentSelect.value = score.instruments[part] || DEFAULT_INSTRUMENT;
  });
}

function getSelectedNote() {
  if (!selected) return null;
  const measure = score.measures[selected.measureIndex];
  if (!measure) return null;
  return measure[selected.part].find((n) => n.id === selected.noteId) || null;
}

// The specific pitch (tone) selected within the note — a plain note has one,
// a chord may have several and only one is "the" selected notehead.
function getSelectedTone() {
  const note = getSelectedNote();
  if (!note) return null;
  return note.keys[selected.keyIndex] || note.keys[0] || null;
}

function clearSelection() {
  pendingSlurStart = null;
  pendingGlissandoStart = null;
  const hadMultiSelection = multiSelected.length > 0;
  multiSelected = [];
  if (!selected && !hadMultiSelection) return;
  selected = null;
  render();
  syncNoteControlsFromSelection();
}

const KEY_LETTER_ORDER = {
  c: 0, d: 1, e: 2, f: 3, g: 4, a: 5, b: 6,
};

function keySortValue(key) {
  const { letter, octave } = parseKey(key);
  return octave * 7 + KEY_LETTER_ORDER[letter.toLowerCase()];
}

// Re-sorts a note's tones by pitch, keeping `selected.keyIndex` pointing at
// the same tone (its index may shift when the sort reorders the array).
function sortNoteKeys(note) {
  if (!selected || note.id !== selected.noteId) {
    note.keys.sort((a, b) => keySortValue(a.key) - keySortValue(b.key));
    return;
  }
  const selectedTone = note.keys[selected.keyIndex];
  note.keys.sort((a, b) => keySortValue(a.key) - keySortValue(b.key));
  if (selectedTone) selected.keyIndex = note.keys.indexOf(selectedTone);
}

// 和音(chord): clicking the same rhythmic slot as an existing note (see
// findSameSlotNote) at a different pitch height adds that pitch to the
// note's `keys` instead of inserting a separate note — the 1st and every
// later tone of a chord are now placed the same way, just by clicking where
// you want the notehead. The new tone starts with no tie/slur — those are
// applied afterward by selecting the specific tone and using the タイ/スラー
// buttons, same as for any other note (see applyTieToSelectedTone /
// toggleSlurFromSelectedTone).
function addPitchToNote(note, region, y) {
  const index = indexForY(y, region.topY, region.step);
  const baseKey = pitchForIndex(region.clef, index);
  const { letter, octave } = parseKey(baseKey);
  const key = buildKey(letter, selectedAccidental, octave);
  const alreadyThere = note.keys.some((tone) => {
    const p = parseKey(tone.key);
    return p.letter.toLowerCase() === letter.toLowerCase() && p.octave === octave;
  });
  if (alreadyThere) { setStatus('すでに同じ高さの音があります'); return; }

  note.keys.push({
    key, tieToNext: false, slurTo: null, glissandoTo: null,
  });
  sortNoteKeys(note);
  const keyIndex = note.keys.findIndex((t) => t.key === key);
  selected = {
    measureIndex: region.measureIndex, part: region.part, noteId: note.id, keyIndex,
  };

  pushHistory();
  render();
  syncNoteControlsFromSelection();
  setStatus('和音に音を追加しました');
  playInsertedNoteBlip(region.part, key);
}

// Reflects the currently-selected note's dynamic/hairpin/articulation state
// into the "記号" ribbon so selecting a note on the score doubles as a way to
// see and remove whatever marks it already carries.
function syncNoteControlsFromSelection() {
  const note = getSelectedNote();
  const crescStartBtn = document.getElementById('btn-cresc-start');
  const crescEndBtn = document.getElementById('btn-cresc-end');
  const descrescStartBtn = document.getElementById('btn-decresc-start');
  const descrescEndBtn = document.getElementById('btn-decresc-end');
  const dynamicSelect = document.getElementById('dynamic-select');
  const articulationSelect = document.getElementById('articulation-select');

  crescStartBtn.classList.toggle('active', !!(note && note.hairpin === 'cresc-start'));
  crescEndBtn.classList.toggle('active', !!(note && note.hairpin === 'cresc-end'));
  descrescStartBtn.classList.toggle('active', !!(note && note.hairpin === 'decresc-start'));
  descrescEndBtn.classList.toggle('active', !!(note && note.hairpin === 'decresc-end'));
  dynamicSelect.value = note ? note.dynamic || '' : '';
  articulationSelect.value = note ? note.articulation || '' : '';
  const mark = note ? getMarkForSelectedNote() : null;
  document.getElementById('rehearsal-select').value = mark ? mark.rehearsal || '' : '';
  document.getElementById('registration-select').value = mark ? mark.registration || '' : '';

  const tone = note && !note.isRest ? getSelectedTone() : null;
  document.querySelectorAll('[data-tone-action="tie"]').forEach((b) => {
    b.classList.toggle('active', !!(tone && tone.tieToNext));
  });
  document.querySelectorAll('[data-tone-action="slur"]').forEach((b) => {
    b.classList.toggle('active', !!(tone && tone.slurTo));
  });
  document.querySelectorAll('[data-tone-action="glissando"]').forEach((b) => {
    b.classList.toggle('active', !!(tone && tone.glissandoTo));
  });
}

// Both x and y must land within this many px of a note's actual rendered
// position to count as "precisely" clicking it (roughly a notehead's size).
// A click that's off by more than this — even if it's in the same general
// column as an existing note — is treated as clicking empty space.
const NOTE_CLICK_TOLERANCE = 9;

// Finds the note precisely under (localX, localY) in one region and, for a
// chord (several pitches stacked on one notehead column), which specific
// tone was clicked. Checks x per-key (n.xs), not just once per note — a
// chord tone a step away from its neighbor gets shifted sideways by VexFlow
// to avoid the noteheads overlapping, so it can sit well outside the note's
// own overall x (n.x) even though it's still part of the same note. Returns
// null if the click isn't precisely on any notehead here; `dist` on a hit
// lets callers arbitrate between two overlapping regions that both have a
// note near the click.
function findClickedNote(region, localX, localY) {
  let best = null;
  region.notes.forEach((n) => {
    (n.ys || []).forEach((ny, keyIndex) => {
      const keyX = n.xs ? n.xs[keyIndex] : n.x;
      if (Math.abs(keyX - localX) > NOTE_CLICK_TOLERANCE) return;
      const dist = Math.abs(ny - localY);
      if (dist <= NOTE_CLICK_TOLERANCE && (!best || dist < best.dist)) {
        best = { ...n, keyIndex, dist };
      }
    });
  });
  return best;
}

// How close (in x, ignoring y entirely) a click has to land to an existing
// note's own notehead(s) to count as "the same rhythmic slot" — clicking
// there adds a pitch to that note (和音) instead of inserting a brand new
// note. Deliberately narrow (see findClickedNote's NOTE_CLICK_TOLERANCE):
// the two checks run in sequence (precise key hit first, then this), so a
// tight radius here just keeps an intentional "insert a separate note a few
// px away" click from being mistaken for "add to this chord".
const CHORD_SLOT_X_TOLERANCE = 7;

// Finds an existing (non-rest) note in `region` whose notehead(s) sit within
// CHORD_SLOT_X_TOLERANCE of localX, regardless of y — used once findClickedNote
// has already ruled out a precise hit on one of its specific keys, to decide
// whether an otherwise-"empty space" click should instead add a new pitch to
// that note's chord (see onPageMouseDown/addPitchToNote).
function findSameSlotNote(region, localX) {
  let best = null;
  region.notes.forEach((rn) => {
    if (!rn.noteRef || rn.noteRef.isRest) return;
    const xs = rn.xs || [rn.x];
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    if (localX < lo - CHORD_SLOT_X_TOLERANCE || localX > hi + CHORD_SLOT_X_TOLERANCE) return;
    const center = (lo + hi) / 2;
    const dist = Math.abs(center - localX);
    if (!best || dist < best.dist) best = { note: rn.noteRef, dist };
  });
  return best ? best.note : null;
}

// Nearest real note (by x) in `region` to a given x — used while dragging to
// find which note the mouse is currently over, tolerant of landing between
// two noteheads rather than requiring a precise hit like findClickedNote.
function findNearestNoteIndex(region, x) {
  let best = -1;
  let bestDist = Infinity;
  region.notes.forEach((rn, i) => {
    if (!rn.noteRef) return;
    const rx = rn.xs ? Math.min(...rn.xs) : rn.x;
    const dist = Math.abs(rx - x);
    if (dist < bestDist) { bestDist = dist; best = i; }
  });
  return best;
}

// Builds the ordered { measureIndex, part, noteId }[] from one (measureIndex,
// noteIndex) position to another, inclusive, in the same part — swapping if
// given back-to-front so a drag in either direction produces the same result.
function computeNoteRange(part, m1, i1, m2, i2) {
  let startM = m1; let startI = i1; let endM = m2; let endI = i2;
  if (startM > endM || (startM === endM && startI > endI)) {
    [startM, endM] = [endM, startM];
    [startI, endI] = [endI, startI];
  }
  const result = [];
  for (let mi = startM; mi <= endM; mi += 1) {
    const notes = score.measures[mi][part];
    const from = mi === startM ? startI : 0;
    const to = mi === endM ? endI : notes.length - 1;
    for (let ni = from; ni <= to && ni < notes.length; ni += 1) {
      result.push({ measureIndex: mi, part, noteId: notes[ni].id });
    }
  }
  return result;
}

function attachPageHandlers(pages) {
  pages.forEach((pageDiv, pageIndex) => {
    pageDiv.addEventListener('mousedown', (e) => onPageMouseDown(e, pageDiv, pageIndex));
    pageDiv.addEventListener('contextmenu', (e) => onPageContextMenu(e, pageDiv, pageIndex));
    pageDiv.addEventListener('dblclick', (e) => onPageDoubleClick(e, pageDiv, pageIndex));
  });
}

// Double-clicking one tone of a chord selects every tone of that note as one
// group (multiSelected) — a shortcut for "treat this chord as a single unit"
// without having to Ctrl+click each tone individually. A single-tone note has
// nothing extra to select, so a double-click on one just behaves like the
// existing plain click (handled by the two mousedown events dblclick fires
// alongside) — no additional selection to make here.
function onPageDoubleClick(e, pageDiv, pageIndex) {
  const { x, y } = toLocalCoords(pageDiv, e.clientX, e.clientY);
  const region = findRegionAt(pageIndex, x, y);
  if (!region) return;
  const hit = findClickedNote(region, x, y);
  if (!hit || hit.noteRef.isRest || hit.noteRef.keys.length < 2) return;
  multiSelected = hit.noteRef.keys.map((tone, keyIndex) => ({
    measureIndex: region.measureIndex, part: region.part, noteId: hit.noteRef.id, keyIndex,
  }));
  selected = null;
  render();
  syncNoteControlsFromSelection();
}

function toLocalCoords(pageDiv, clientX, clientY) {
  const rect = pageDiv.getBoundingClientRect();
  const scaleFactor = rect.width / LAYOUT.pageWidth;
  return {
    x: (clientX - rect.left) / scaleFactor,
    y: (clientY - rect.top) / scaleFactor,
  };
}

// x0 - 30 (not just a few px) because a chord tone a step away from its
// neighbor can be displaced sideways by VexFlow well to the left of the
// stave's own note-start x (see findClickedNote's n.xs) — most noticeably in
// a line's first measure, where getNoteStartX() sits right after the
// clef/key/time signature.
function candidateRegionsAt(pageIndex, x, y) {
  return hitMap.filter(
    (r) => r.page === pageIndex && x >= r.x0 - 30 && x <= r.x1
      && y >= r.topY - hitBandAbove(layoutStaveGap)
      && y <= r.topY + hitBandBelow(layoutStaveGap),
  );
}

// Staves' hit-zones overlap a bit in the gap between them (e.g. a low note on
// 上鍵盤 and a high note on 下鍵盤 can both be "near" the click) — with
// nothing more precise to go on, split that gap evenly by picking whichever
// staff's center line is nearest.
function nearestRegion(candidates, y) {
  if (!candidates.length) return undefined;
  return candidates.reduce((a, b) => (Math.abs(b.topY - y) < Math.abs(a.topY - y) ? b : a));
}

function findRegionAt(pageIndex, x, y) {
  return nearestRegion(candidateRegionsAt(pageIndex, x, y), y);
}

// Resolves a mousedown to the staff region it should act on, and the exact
// note under the click if there is one. A note precisely under the click
// wins the overlap ambiguity between two staves regardless of which staff
// it's on; otherwise (nothing precisely under the click — including when no
// notes are placed at all yet) the region falls back to nearestRegion.
function resolveClickTarget(pageIndex, x, y) {
  const candidates = candidateRegionsAt(pageIndex, x, y);
  if (!candidates.length) return { region: undefined, existing: null };
  let region;
  let existing = null;
  candidates.forEach((r) => {
    const hit = findClickedNote(r, x, y);
    if (hit && (!existing || hit.dist < existing.dist)) {
      existing = hit;
      region = r;
    }
  });
  if (existing) return { region, existing };
  return { region: nearestRegion(candidates, y), existing: null };
}

// y must also be checked (same tolerance as findRegionAt) — without it, a
// drag on line 2+ can match a same-x measure back on line 1 (hitMap keeps
// every line's regions in one flat array), pulling the whole line above into
// the range selection.
function findRegionForPart(pageIndex, part, x, y) {
  return hitMap.find(
    (r) => r.page === pageIndex && r.part === part && x >= r.x0 - 5 && x <= r.x1
      && y >= r.topY - hitBandAbove(layoutStaveGap)
      && y <= r.topY + hitBandBelow(layoutStaveGap),
  );
}

// Hit-tests the per-note コード/リハーサル/レジストレーション boxes (see
// drawPerNoteMarks in staffRenderer.js) — distinct from annotationHitMap,
// which is only the measure-number label's own region.
function findMarkRegionAt(pageIndex, x, y) {
  return markHitMap.find(
    (r) => r.page === pageIndex && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1,
  );
}

// Hit-tests the time signature glyph at measure 1 (see staffRenderer's
// timeSigHitMap) — checked before the general note-insertion click handling
// in onPageMouseDown so clicking the glyph toggles its notation instead of
// inserting a note underneath it.
function findTimeSigRegionAt(pageIndex, x, y) {
  return timeSigHitMap.find(
    (r) => r.page === pageIndex && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1,
  );
}

// 4/4 and 2/2 are the only signatures with a traditional symbol form (see
// staffRenderer's timeSigGlyph) — clicking the glyph for any other signature
// has nothing to toggle to, so it's a no-op rather than a confusing flip.
function toggleTimeSigDisplay() {
  if (score.timeSig !== '4/4' && score.timeSig !== '2/2') {
    setStatus('この拍子には記号表記がありません');
    return;
  }
  score.timeSigDisplay = score.timeSigDisplay === 'symbol' ? 'numeric' : 'symbol';
  pushHistory();
  render();
}

// ---------- range-selection (measure-granularity) ----------

function renderRangeHighlight(pages) {
  pages.forEach((pageDiv) => {
    pageDiv.querySelectorAll('.range-highlight').forEach((el) => el.remove());
  });
  if (!rangeSelection) return;
  const { part, measureStart, measureEnd } = rangeSelection;
  hitMap
    .filter((r) => r.part === part && r.measureIndex >= measureStart && r.measureIndex <= measureEnd)
    .forEach((r) => {
      const pageDiv = pages[r.page];
      if (!pageDiv) return;
      const div = document.createElement('div');
      div.className = 'range-highlight';
      div.style.left = `${r.x0 - 4}px`;
      div.style.top = `${r.topY - 40}px`;
      div.style.width = `${r.x1 - r.x0 + 4}px`;
      div.style.height = '120px';
      pageDiv.appendChild(div);
    });
}

function updateRangeLabel() {
  const label = document.getElementById('range-selection-label');
  if (!rangeSelection) {
    label.textContent = '未選択';
    return;
  }
  const { part, measureStart, measureEnd } = rangeSelection;
  const partLabel = { upper: '上鍵盤', lower: '下鍵盤', pedal: 'ペダル' }[part];
  label.textContent = `${partLabel} ${measureStart + 1}〜${measureEnd + 1}小節`;
}

function clearRangeSelection() {
  noteRangeSelection = null;
  if (!rangeSelection) return;
  rangeSelection = null;
  updateRangeLabel();
  renderRangeHighlight(Array.from(scoreContainer.querySelectorAll('.score-page')));
}

function clearMeasureSelection() {
  if (selectedMeasureIndex === null) return;
  selectedMeasureIndex = null;
  scoreContainer.querySelectorAll('.measure-number-label.active').forEach((el) => el.classList.remove('active'));
}

// ---------- measure-number labels (editing aid only, hidden on print) ----------

function renderMeasureNumbers(pages) {
  pages.forEach((pageDiv) => {
    pageDiv.querySelectorAll('.measure-number-label').forEach((el) => el.remove());
  });
  annotationHitMap.forEach((r) => {
    const pageDiv = pages[r.page];
    if (!pageDiv) return;
    const label = document.createElement('div');
    label.className = 'measure-number-label';
    if (selectedMeasureIndex === r.measureIndex) label.classList.add('active');
    label.textContent = String(r.measureIndex + 1);
    label.style.left = `${r.x0}px`;
    label.style.top = `${r.numberY0}px`;
    label.style.width = `${r.x1 - r.x0}px`;
    label.style.height = `${r.numberY1 - r.numberY0}px`;
    label.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      clearRangeSelection();
      selectedMeasureIndex = r.measureIndex;
      renderMeasureNumbers(pages);
    });
    label.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearRangeSelection();
      selectedMeasureIndex = r.measureIndex;
      renderMeasureNumbers(pages);
      showMeasureContextMenu(e.clientX, e.clientY, r.measureIndex);
    });
    pageDiv.appendChild(label);
  });
}

// ---------- title / composer / lyricist header (page 1 only) ----------

function renderTitleHeader(pages) {
  const pageDiv = pages[0];
  if (!pageDiv) return;
  pageDiv.querySelectorAll('.score-header-field, .score-header-row').forEach((el) => el.remove());

  const { topMargin, titleHeaderHeight, pageWidth } = LAYOUT;

  const makeField = (value, placeholder, className, onCommit) => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = `score-header-field ${className}`;
    input.value = value || '';
    input.placeholder = placeholder;
    input.addEventListener('change', () => {
      onCommit(input.value);
      pushHistory();
    });
    return input;
  };

  const titleField = makeField(score.title, '曲のタイトル', 'score-title-field', (v) => {
    score.title = v || '無題の楽譜';
    document.getElementById('title-input').value = score.title;
  });
  titleField.style.left = '0px';
  titleField.style.top = `${topMargin}px`;
  titleField.style.width = `${pageWidth}px`;
  pageDiv.appendChild(titleField);

  // Tempo marking ("♩ = 100") — editable via the quickbar's note-value
  // select + BPM number, this is just the printed display. Sits just above
  // measure 1's own top-left corner (conventional placement), not up by the
  // title.
  const tempoMarking = document.createElement('div');
  tempoMarking.className = 'score-tempo-marking';
  const tempoGlyph = document.createElement('span');
  tempoGlyph.className = 'score-tempo-glyph';
  // Drawn as inline SVG (same paths as the 音符 ribbon's duration icons)
  // rather than the Unicode musical-symbols glyphs (𝅝 U+1D15D etc.) those
  // used to rely on — several of those codepoints live outside what most
  // system fonts actually cover (only ♩/♪ are in the common BMP block),
  // so w/h/16 rendered as tofu/mojibake on machines without a music font.
  tempoGlyph.innerHTML = TEMPO_NOTE_ICON_SVG[score.bpmNoteValue] || TEMPO_NOTE_ICON_SVG.q;
  tempoMarking.appendChild(tempoGlyph);
  tempoMarking.appendChild(document.createTextNode(` = ${score.bpm}`));
  tempoMarking.style.left = `${LAYOUT.pageMargin}px`;
  tempoMarking.style.top = `${topMargin + titleHeaderHeight - 20}px`;
  pageDiv.appendChild(tempoMarking);

  // Conventional placement: right-aligned, stacked under the title.
  const pageMargin = LAYOUT.pageMargin;
  const makeHeaderRow = (labelText, value, placeholder, className, top, onCommit) => {
    const row = document.createElement('div');
    row.className = 'score-header-row';
    row.style.top = `${top}px`;
    row.style.right = `${pageMargin}px`;

    const label = document.createElement('span');
    label.className = 'score-header-label';
    label.textContent = labelText;

    const input = makeField(value, placeholder, className, onCommit);

    row.appendChild(label);
    row.appendChild(input);
    pageDiv.appendChild(row);
  };

  makeHeaderRow('作詞:', score.lyricist, '作詞者名', 'score-lyricist-field', topMargin + Math.round(titleHeaderHeight * 0.48), (v) => { score.lyricist = v; });
  makeHeaderRow('作曲:', score.composer, '作曲者名', 'score-composer-field', topMargin + Math.round(titleHeaderHeight * 0.72), (v) => { score.composer = v; });

  // タイトル/作詞/作曲 are styled (font family/size) the same way a shape's
  // text is, via the 図形の書式 tab — see selectField/applyFieldStyles.
  applyFieldStyles(pageDiv);
  [
    ['.score-title-field', 'title'],
    ['.score-lyricist-field', 'lyricist'],
    ['.score-composer-field', 'composer'],
  ].forEach(([selector, key]) => {
    const el = pageDiv.querySelector(selector);
    if (el) el.addEventListener('focus', () => selectField(key));
  });
}

// ---------- 楽挿入: 図形・テキストボックス ----------
//
// A shape/textbox floats freely on top of one specific page (see
// score.shapes), independent of the score's own note layout — placed via the
// 楽挿入 tab, edited via the 図形の書式 tab (font/fill/stroke) which also
// doubles as the font editor for the title/composer/lyricist fields above
// (see selectField). Only one thing is ever "selected" for the format tab at
// a time: a shape (selectedShapeId) or a header field (selectedFieldKey).

let pendingShapeType = null;
let selectedShapeId = null;
let selectedFieldKey = null; // 'title' | 'composer' | 'lyricist'

const shapeFormatTabBtn = document.getElementById('shapeformat-tab-btn');
const shapeFillGroup = document.getElementById('shape-format-fill-group');
const shapeFormatHint = document.getElementById('shape-format-hint');

function getSelectedShape() {
  return selectedShapeId ? score.shapes.find((s) => s.id === selectedShapeId) : null;
}

function fieldStyleFor(key) {
  return { title: score.titleStyle, composer: score.composerStyle, lyricist: score.lyricistStyle }[key];
}

function applyFieldStyles(pageDiv) {
  const map = {
    '.score-title-field': score.titleStyle,
    '.score-composer-field': score.composerStyle,
    '.score-lyricist-field': score.lyricistStyle,
  };
  Object.entries(map).forEach(([selector, style]) => {
    const el = pageDiv.querySelector(selector);
    if (el && style) {
      el.style.fontFamily = style.fontFamily;
      el.style.fontSize = `${style.fontSize}px`;
    }
  });
}

function selectField(key) {
  selectedFieldKey = key;
  selectedShapeId = null;
  shapeFormatTabBtn.hidden = false;
  syncShapeFormatControls();
}

function selectShape(id) {
  selectedShapeId = id;
  selectedFieldKey = null;
  shapeFormatTabBtn.hidden = false;
  syncShapeFormatControls();
  render();
}

function deselectShapeAndField() {
  if (!selectedShapeId && !selectedFieldKey) return;
  selectedShapeId = null;
  selectedFieldKey = null;
  shapeFormatTabBtn.hidden = true;
  render();
}

function syncShapeFormatControls() {
  const shape = getSelectedShape();
  const fontFamilySelect = document.getElementById('shape-font-family');
  const fontSizeInput = document.getElementById('shape-font-size');
  const fillInput = document.getElementById('shape-fill-color');
  const strokeInput = document.getElementById('shape-stroke-color');
  const strokeWidthInput = document.getElementById('shape-stroke-width');
  if (shape) {
    shapeFormatHint.textContent = `図形を選択中(${shape.type})`;
    fontFamilySelect.value = shape.fontFamily;
    fontSizeInput.value = shape.fontSize;
    shapeFillGroup.hidden = false;
    fillInput.value = shape.fill;
    strokeInput.value = shape.stroke;
    strokeWidthInput.value = shape.strokeWidth;
  } else if (selectedFieldKey) {
    const style = fieldStyleFor(selectedFieldKey);
    shapeFormatHint.textContent = `${{ title: 'タイトル', composer: '作曲者名', lyricist: '作詞者名' }[selectedFieldKey]}を選択中`;
    fontFamilySelect.value = style.fontFamily;
    fontSizeInput.value = style.fontSize;
    shapeFillGroup.hidden = true;
  } else {
    shapeFormatHint.textContent = '図形またはタイトル/作詞/作曲欄をクリックして選択してください';
  }
}

document.getElementById('shape-font-family').addEventListener('change', (e) => {
  const shape = getSelectedShape();
  if (shape) { shape.fontFamily = e.target.value; pushHistory(); render(); return; }
  if (selectedFieldKey) { fieldStyleFor(selectedFieldKey).fontFamily = e.target.value; pushHistory(); render(); }
});
document.getElementById('shape-font-size').addEventListener('change', (e) => {
  const size = Number(e.target.value) || 14;
  const shape = getSelectedShape();
  if (shape) { shape.fontSize = size; pushHistory(); render(); return; }
  if (selectedFieldKey) { fieldStyleFor(selectedFieldKey).fontSize = size; pushHistory(); render(); }
});
document.getElementById('shape-fill-color').addEventListener('input', (e) => {
  const shape = getSelectedShape();
  if (shape) { shape.fill = e.target.value; render(); }
});
document.getElementById('shape-fill-color').addEventListener('change', () => pushHistory());
document.getElementById('shape-stroke-color').addEventListener('input', (e) => {
  const shape = getSelectedShape();
  if (shape) { shape.stroke = e.target.value; render(); }
});
document.getElementById('shape-stroke-color').addEventListener('change', () => pushHistory());
document.getElementById('shape-stroke-width').addEventListener('change', (e) => {
  const shape = getSelectedShape();
  if (shape) { shape.strokeWidth = Math.max(0, Number(e.target.value) || 0); pushHistory(); render(); }
});
document.getElementById('btn-shape-delete').addEventListener('click', () => {
  if (!selectedShapeId) return;
  score.shapes = score.shapes.filter((s) => s.id !== selectedShapeId);
  deselectShapeAndField();
  pushHistory();
  render();
});

document.querySelectorAll('[data-shape-type]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const arming = pendingShapeType !== btn.dataset.shapeType;
    pendingShapeType = arming ? btn.dataset.shapeType : null;
    document.querySelectorAll('[data-shape-type]').forEach((b) => {
      b.classList.toggle('active', arming && b === btn);
    });
  });
});

function defaultShapeSize(type) {
  if (type === 'textbox') return { width: 160, height: 40 };
  if (type === 'line' || type === 'arrow') return { width: 120, height: 0 };
  return { width: 100, height: 100 };
}

// Click-and-drag on a page while a 楽挿入 button is armed places a new shape
// sized to the drag rectangle (or a sensible default size on a plain click).
// 線/矢印 additionally track `flip` (see renderShapes) since a diagonal can
// go either way within its own bounding box.
function startShapePlacement(e, pageDiv, pageIndex) {
  const type = pendingShapeType;
  const { x: startLocalX, y: startLocalY } = toLocalCoords(pageDiv, e.clientX, e.clientY);
  let curLocalX = startLocalX;
  let curLocalY = startLocalY;
  let dragged = false;

  const onMove = (ev) => {
    const local = toLocalCoords(pageDiv, ev.clientX, ev.clientY);
    if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > DRAG_THRESHOLD) dragged = true;
    curLocalX = local.x;
    curLocalY = local.y;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    const size = defaultShapeSize(type);
    let shapeX = startLocalX;
    let shapeY = startLocalY;
    let { width, height } = size;
    let flip = false;
    if (dragged) {
      const dx = curLocalX - startLocalX;
      const dy = curLocalY - startLocalY;
      shapeX = Math.min(startLocalX, curLocalX);
      shapeY = Math.min(startLocalY, curLocalY);
      if (type === 'line' || type === 'arrow') {
        width = Math.max(10, Math.abs(dx));
        height = Math.max(2, Math.abs(dy));
        flip = (dx < 0) !== (dy < 0);
      } else {
        width = Math.max(20, Math.abs(dx));
        height = Math.max(20, Math.abs(dy));
      }
    }
    const shape = {
      id: makeNoteId(),
      page: pageIndex,
      type,
      x: shapeX,
      y: shapeY,
      width,
      height,
      flip,
      text: '',
      fontFamily: 'Hiragino Sans, Yu Gothic, sans-serif',
      fontSize: 14,
      fill: '#ffffff',
      stroke: '#333333',
      strokeWidth: 2,
    };
    score.shapes.push(shape);
    pendingShapeType = null;
    document.querySelectorAll('[data-shape-type]').forEach((b) => b.classList.remove('active'));
    pushHistory();
    selectShape(shape.id);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function startShapeMove(shape, e) {
  const startClientX = e.clientX;
  const startClientY = e.clientY;
  const origX = shape.x;
  const origY = shape.y;
  const onMove = (ev) => {
    shape.x = origX + (ev.clientX - startClientX);
    shape.y = origY + (ev.clientY - startClientY);
    render();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    pushHistory();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function startShapeResize(shape, corner, e) {
  const startClientX = e.clientX;
  const startClientY = e.clientY;
  const orig = {
    x: shape.x, y: shape.y, width: shape.width, height: shape.height,
  };
  const onMove = (ev) => {
    const dx = ev.clientX - startClientX;
    const dy = ev.clientY - startClientY;
    if (corner.includes('e')) shape.width = Math.max(10, orig.width + dx);
    if (corner.includes('s')) shape.height = Math.max(10, orig.height + dy);
    if (corner.includes('w')) { shape.width = Math.max(10, orig.width - dx); shape.x = orig.x + orig.width - shape.width; }
    if (corner.includes('n')) { shape.height = Math.max(10, orig.height - dy); shape.y = orig.y + orig.height - shape.height; }
    render();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    pushHistory();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function renderShapes(pages) {
  pages.forEach((pageDiv) => {
    pageDiv.querySelectorAll('.shape-el').forEach((el) => el.remove());
  });
  score.shapes.forEach((shape) => {
    const pageDiv = pages[shape.page];
    if (!pageDiv) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'shape-el';
    if (shape.id === selectedShapeId) wrapper.classList.add('selected');
    wrapper.style.left = `${shape.x}px`;
    wrapper.style.top = `${shape.y}px`;
    wrapper.style.width = `${shape.width}px`;
    wrapper.style.height = `${shape.height}px`;

    if (shape.type === 'rect' || shape.type === 'textbox') {
      wrapper.style.background = shape.fill;
      wrapper.style.border = `${shape.strokeWidth}px solid ${shape.stroke}`;
    } else if (shape.type === 'ellipse') {
      wrapper.style.background = shape.fill;
      wrapper.style.border = `${shape.strokeWidth}px solid ${shape.stroke}`;
      wrapper.style.borderRadius = '50%';
    } else if (shape.type === 'line' || shape.type === 'arrow') {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('width', shape.width);
      svg.setAttribute('height', Math.max(shape.height, 1));
      svg.style.position = 'absolute';
      svg.style.left = '0';
      svg.style.top = '0';
      svg.style.overflow = 'visible';
      svg.style.pointerEvents = 'none';
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', shape.flip ? shape.width : 0);
      line.setAttribute('y1', 0);
      line.setAttribute('x2', shape.flip ? 0 : shape.width);
      line.setAttribute('y2', shape.height);
      line.setAttribute('stroke', shape.stroke);
      line.setAttribute('stroke-width', shape.strokeWidth);
      if (shape.type === 'arrow') {
        const markerId = `arrowhead-${shape.id}`;
        const marker = document.createElementNS(SVG_NS, 'marker');
        marker.setAttribute('id', markerId);
        marker.setAttribute('markerWidth', '10');
        marker.setAttribute('markerHeight', '10');
        marker.setAttribute('refX', '8');
        marker.setAttribute('refY', '5');
        marker.setAttribute('orient', 'auto');
        const arrowPath = document.createElementNS(SVG_NS, 'path');
        arrowPath.setAttribute('d', 'M0,0 L10,5 L0,10 Z');
        arrowPath.setAttribute('fill', shape.stroke);
        marker.appendChild(arrowPath);
        const defs = document.createElementNS(SVG_NS, 'defs');
        defs.appendChild(marker);
        svg.appendChild(defs);
        line.setAttribute('marker-end', `url(#${markerId})`);
      }
      svg.appendChild(line);
      wrapper.appendChild(svg);
    }

    // Every shape carries an editable textbox by default (per spec) — even
    // 線/矢印, where it just floats over the bounding box.
    const textEl = document.createElement('div');
    textEl.className = 'shape-text';
    textEl.contentEditable = 'true';
    textEl.textContent = shape.text || '';
    textEl.style.fontFamily = shape.fontFamily;
    textEl.style.fontSize = `${shape.fontSize}px`;
    textEl.addEventListener('blur', () => {
      if (shape.text !== textEl.textContent) { shape.text = textEl.textContent; pushHistory(); }
    });
    wrapper.appendChild(textEl);

    if (shape.id === selectedShapeId) {
      ['nw', 'ne', 'sw', 'se'].forEach((corner) => {
        const handle = document.createElement('div');
        handle.className = `shape-handle shape-handle-${corner}`;
        handle.addEventListener('mousedown', (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          startShapeResize(shape, corner, ev);
        });
        wrapper.appendChild(handle);
      });
    }

    // A single click on an unselected shape selects it (and arms a move-drag
    // — harmless if the mouse never actually moves before release). Once
    // it's already selected, clicking directly on its own text instead lets
    // the click through to native contentEditable caret placement — without
    // this, the text layer sitting on top would swallow the click before
    // selectShape ever ran (see the old per-textEl stopPropagation this
    // replaced), which is why plain textboxes in particular were nearly
    // impossible to select: their text overlay covers the entire shape.
    wrapper.addEventListener('mousedown', (ev) => {
      if (pendingShapeType) return;
      const clickedText = ev.target.closest('.shape-text');
      const alreadySelected = shape.id === selectedShapeId;
      ev.stopPropagation();
      if (clickedText && alreadySelected) return;
      ev.preventDefault();
      selectShape(shape.id);
      startShapeMove(shape, ev);
    });

    pageDiv.appendChild(wrapper);
  });
}

// ---------- 形式タブ: 譜面全体の幅（ドラッグで調整） ----------

const WIDTH_SCALE_MIN = 0.6;
const WIDTH_SCALE_MAX = 1.6;

function widthScaleToThumbRatio(scale) {
  return (scale - WIDTH_SCALE_MIN) / (WIDTH_SCALE_MAX - WIDTH_SCALE_MIN);
}

function updateWidthSliderUI() {
  const track = document.getElementById('width-slider-track');
  const thumb = document.getElementById('width-slider-thumb');
  const valueLabel = document.getElementById('width-slider-value');
  if (!track || !thumb || !valueLabel) return;
  const ratio = Math.max(0, Math.min(1, widthScaleToThumbRatio(score.measureWidthScale || 1)));
  thumb.style.left = `${ratio * 100}%`;
  valueLabel.textContent = `${Math.round((score.measureWidthScale || 1) * 100)}%`;
}

function setWidthScaleFromClientX(clientX) {
  const track = document.getElementById('width-slider-track');
  const rect = track.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  score.measureWidthScale = WIDTH_SCALE_MIN + ratio * (WIDTH_SCALE_MAX - WIDTH_SCALE_MIN);
  updateWidthSliderUI();
  render();
}

(function setUpWidthSlider() {
  const track = document.getElementById('width-slider-track');
  const thumb = document.getElementById('width-slider-thumb');
  if (!track || !thumb) return;
  let sliderDragging = false;
  const onMove = (e) => { if (sliderDragging) setWidthScaleFromClientX(e.clientX); };
  const onUp = () => {
    if (!sliderDragging) return;
    sliderDragging = false;
    pushHistory();
  };
  thumb.addEventListener('mousedown', (e) => { e.preventDefault(); sliderDragging = true; });
  track.addEventListener('mousedown', (e) => {
    if (e.target === thumb) return;
    sliderDragging = true;
    setWidthScaleFromClientX(e.clientX);
  });
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
})();

// ---------- generic right-click context menu ----------

const contextMenuEl = document.getElementById('context-menu');

// A submenu (item.submenu — see showNoteRangeContextMenu's 強弱記号/
// アーティキュレーション/etc. categories) is a second floating panel opened
// on hover, positioned beside whichever row triggered it. Only one is ever
// open at a time (this app nests one level deep: category → value, never
// category → category), so a single reference is enough to track and close
// it. Leaving the parent row AND leaving the panel itself both schedule the
// same close call — hovering the *other* one first cancels it, so moving the
// mouse diagonally from row to panel doesn't flicker it shut.
let openSubmenuEl = null;
let openSubmenuParentRow = null;
let submenuCloseTimer = null;

function closeOpenSubmenu() {
  clearTimeout(submenuCloseTimer);
  if (openSubmenuEl) { openSubmenuEl.remove(); openSubmenuEl = null; }
  openSubmenuParentRow = null;
}

function scheduleSubmenuClose() {
  clearTimeout(submenuCloseTimer);
  submenuCloseTimer = setTimeout(closeOpenSubmenu, 200);
}

function openSubmenuFor(parentRow, subitems) {
  if (openSubmenuParentRow === parentRow) { clearTimeout(submenuCloseTimer); return; }
  closeOpenSubmenu();
  const panel = document.createElement('div');
  panel.className = 'context-menu';
  subitems.forEach((sub) => {
    if (sub.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      panel.appendChild(sep);
      return;
    }
    const subRow = document.createElement('div');
    subRow.className = 'context-menu-item';
    if (sub.active) subRow.classList.add('active');
    subRow.textContent = sub.label;
    subRow.addEventListener('click', () => {
      hideContextMenu();
      sub.onClick();
    });
    panel.appendChild(subRow);
  });
  panel.addEventListener('mouseenter', () => clearTimeout(submenuCloseTimer));
  panel.addEventListener('mouseleave', scheduleSubmenuClose);
  document.body.appendChild(panel);
  const parentRect = parentRow.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const left = parentRect.right + panelRect.width > window.innerWidth
    ? Math.max(0, parentRect.left - panelRect.width)
    : parentRect.right;
  const top = Math.min(parentRect.top, window.innerHeight - panelRect.height - 4);
  panel.style.left = `${left}px`;
  panel.style.top = `${Math.max(0, top)}px`;
  openSubmenuEl = panel;
  openSubmenuParentRow = parentRow;
}

function hideContextMenu() {
  contextMenuEl.hidden = true;
  contextMenuEl.innerHTML = '';
  closeOpenSubmenu();
}

function showContextMenu(clientX, clientY, items) {
  contextMenuEl.innerHTML = '';
  closeOpenSubmenu();
  items.forEach((item) => {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      contextMenuEl.appendChild(sep);
    } else if (item.header) {
      const h = document.createElement('div');
      h.className = 'context-menu-header';
      h.textContent = item.header;
      contextMenuEl.appendChild(h);
    } else {
      const row = document.createElement('div');
      row.className = 'context-menu-item';
      if (item.active) row.classList.add('active');
      row.textContent = item.label;
      if (item.submenu) {
        row.classList.add('has-submenu');
        row.addEventListener('mouseenter', () => openSubmenuFor(row, item.submenu));
        row.addEventListener('mouseleave', scheduleSubmenuClose);
      } else {
        row.addEventListener('click', () => {
          hideContextMenu();
          item.onClick();
        });
      }
      contextMenuEl.appendChild(row);
    }
  });
  contextMenuEl.hidden = false;
  const rect = contextMenuEl.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 4;
  const maxY = window.innerHeight - rect.height - 4;
  contextMenuEl.style.left = `${Math.max(0, Math.min(clientX, maxX))}px`;
  contextMenuEl.style.top = `${Math.max(0, Math.min(clientY, maxY))}px`;
}

document.addEventListener('mousedown', (e) => {
  // A submenu panel (see openSubmenuFor) lives outside contextMenuEl itself
  // (a separate floating element), so clicking one of its rows must not
  // count as "clicked outside" — that would hideContextMenu() (removing the
  // row) on mousedown, before the click event meant to fire its onClick ever
  // gets to run.
  if (openSubmenuEl && openSubmenuEl.contains(e.target)) return;
  if (!contextMenuEl.hidden && !contextMenuEl.contains(e.target)) hideContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideContextMenu();
    if (pendingSlurStart) {
      pendingSlurStart = null;
      setStatus('スラーを取り消しました');
    }
    if (pendingGlissandoStart) {
      pendingGlissandoStart = null;
      setStatus('グリッサンドを取り消しました');
    }
  }
});

function onPageMouseDown(e, pageDiv, pageIndex) {
  if (e.button !== 0) return;

  // An armed 楽挿入 button takes over the whole page (drag-to-place a new
  // shape) regardless of what's underneath — checked first, before even the
  // time signature toggle below.
  if (pendingShapeType) {
    startShapePlacement(e, pageDiv, pageIndex);
    return;
  }

  // A click that reaches here (a shape's own mousedown handler stops
  // propagation before this point) is a normal score interaction, so any
  // selected shape/header-field's format-tab session ends.
  deselectShapeAndField();

  const { x, y } = toLocalCoords(pageDiv, e.clientX, e.clientY);

  // Checked before everything else (including note insertion below) so a
  // click on the time signature glyph toggles its notation instead of
  // inserting a note underneath it — see timeSigGlyph in staffRenderer.js.
  if (findTimeSigRegionAt(pageIndex, x, y)) {
    clearRangeSelection();
    clearMeasureSelection();
    clearSelection();
    toggleTimeSigDisplay();
    return;
  }

  const markRegion = findMarkRegionAt(pageIndex, x, y);
  if (markRegion) {
    clearRangeSelection();
    clearMeasureSelection();
    clearSelection();
    if (markRegion.kind === 'chord') {
      const measure = score.measures[markRegion.measureIndex];
      const note = measure.lower.find((n) => n.id === markRegion.noteId);
      if (note && note.chordTentative) {
        // showChordCandidatePicker opens #context-menu, which the document-level
        // mousedown listener below would otherwise immediately close again —
        // that listener only exists to dismiss a menu opened by an *earlier*
        // gesture (right-click), so it must not see this same click bubble up.
        e.stopPropagation();
        showChordCandidatePicker(markRegion.measureIndex, markRegion.noteId, e.clientX, e.clientY);
      } else {
        editChord(markRegion.measureIndex, markRegion.noteId);
      }
    } else {
      // リハーサル/レジストレーション box — just selects the note it belongs
      // to, same as clicking the note itself, so the 記号 tab's selects
      // populate with its current value ready to change or clear.
      selectNoteFor(markRegion.measureIndex, markRegion.part, markRegion.noteId);
    }
    return;
  }

  const { region, existing } = resolveClickTarget(pageIndex, x, y);
  if (!region) {
    clearRangeSelection();
    clearMeasureSelection();
    clearSelection();
    return;
  }

  // Ctrl/Cmd+click toggles a note (or one tone of a chord) in/out of the
  // multi-selection, Office-style, instead of the normal single-select —
  // see showMultiSelectContextMenu for what a right-click on it can do.
  if ((e.ctrlKey || e.metaKey) && existing && !e.shiftKey) {
    const hitIndex = multiSelected.findIndex(
      (s) => s.noteId === existing.noteRef.id && s.keyIndex === existing.keyIndex,
    );
    if (hitIndex >= 0) {
      multiSelected.splice(hitIndex, 1);
    } else {
      multiSelected.push({
        measureIndex: region.measureIndex, part: region.part, noteId: existing.noteRef.id, keyIndex: existing.keyIndex,
      });
    }
    render();
    return;
  }
  if (multiSelected.length) multiSelected = [];

  // A スラー is armed and waiting for its end note (see
  // toggleSlurFromSelectedTone) — this click picks it, wherever it is,
  // instead of the normal click behavior.
  if (pendingSlurStart && existing && !e.shiftKey) {
    const startMeasure = score.measures[pendingSlurStart.measureIndex];
    const startNote = startMeasure && startMeasure[pendingSlurStart.part]
      .find((n) => n.id === pendingSlurStart.noteId);
    const startTone = startNote && startNote.keys[pendingSlurStart.keyIndex];
    const isSameTone = pendingSlurStart.noteId === existing.noteRef.id
      && pendingSlurStart.keyIndex === existing.keyIndex;
    const validTarget = startTone && !isSameTone && !existing.noteRef.isRest;
    pendingSlurStart = null;
    if (validTarget) {
      startTone.slurTo = {
        noteId: existing.noteRef.id,
        pitchKey: pitchKeyOf(existing.noteRef.keys[existing.keyIndex].key),
      };
      pushHistory();
      setStatus('スラーをつけました');
    } else {
      setStatus('スラーを取り消しました');
    }
    clearRangeSelection();
    clearMeasureSelection();
    selected = {
      measureIndex: region.measureIndex, part: region.part, noteId: existing.noteRef.id, keyIndex: existing.keyIndex,
    };
    render();
    syncNoteControlsFromSelection();
    return;
  }

  // 同様に、グリッサンドが終わりの音符を待っている場合 (see
  // toggleGlissandoFromSelectedTone).
  if (pendingGlissandoStart && existing && !e.shiftKey) {
    const startMeasure = score.measures[pendingGlissandoStart.measureIndex];
    const startNote = startMeasure && startMeasure[pendingGlissandoStart.part]
      .find((n) => n.id === pendingGlissandoStart.noteId);
    const startTone = startNote && startNote.keys[pendingGlissandoStart.keyIndex];
    const isSameTone = pendingGlissandoStart.noteId === existing.noteRef.id
      && pendingGlissandoStart.keyIndex === existing.keyIndex;
    const validTarget = startTone && !isSameTone && !existing.noteRef.isRest;
    pendingGlissandoStart = null;
    if (validTarget) {
      startTone.glissandoTo = {
        noteId: existing.noteRef.id,
        pitchKey: pitchKeyOf(existing.noteRef.keys[existing.keyIndex].key),
      };
      pushHistory();
      setStatus('グリッサンドをつけました');
    } else {
      setStatus('グリッサンドを取り消しました');
    }
    clearRangeSelection();
    clearMeasureSelection();
    selected = {
      measureIndex: region.measureIndex, part: region.part, noteId: existing.noteRef.id, keyIndex: existing.keyIndex,
    };
    render();
    syncNoteControlsFromSelection();
    return;
  }

  if (existing) {
    clearRangeSelection();
    clearMeasureSelection();
    selected = {
      measureIndex: region.measureIndex, part: region.part, noteId: existing.noteRef.id, keyIndex: existing.keyIndex,
    };
    // Clicking a rest lets you fill it in: drag (or just release) to pick a
    // pitch, and mouseup turns it into a real note. See insertNote's N連符
    // handling, which is what creates these placeholder rests now.
    // `moved` stays false (no pitch change applied yet) until the mouse
    // actually travels past DRAG_THRESHOLD — otherwise the slightest jitter
    // during a plain click-to-select would nudge the pitch by a step.
    // `axis` picks vertical-drag-changes-pitch (existing) vs horizontal-
    // drag-range-selects-notes (new) once the drag is big enough to tell —
    // see the mousemove handler below.
    dragging = {
      region, note: existing.noteRef, keyIndex: existing.keyIndex, wasRest: existing.noteRef.isRest,
      startClientX: e.clientX, startClientY: e.clientY, moved: false, axis: null,
      startMeasureIndex: region.measureIndex,
      startNoteIndex: region.notes.findIndex((rn) => rn.noteRef && rn.noteRef.id === existing.noteRef.id),
    };
    render();
    syncNoteControlsFromSelection();
    return;
  }

  if (selected) {
    selected = null;
    render();
  }

  // Empty staff area: could be a plain click (insert a note) or the start of
  // a click-and-drag range selection — the decision is deferred until we see
  // whether the mouse moves past DRAG_THRESHOLD before it's released.
  pendingClick = {
    pageIndex, region, startClientX: e.clientX, startClientY: e.clientY, localX: x, localY: y,
  };
}

function onPageContextMenu(e, pageDiv, pageIndex) {
  e.preventDefault();
  if (multiSelected.length > 0) {
    showMultiSelectContextMenu(e.clientX, e.clientY);
    return;
  }
  const { x, y } = toLocalCoords(pageDiv, e.clientX, e.clientY);
  const region = findRegionAt(pageIndex, x, y);
  if (!region) return;
  // The note-range menu only takes over when the right-click actually lands
  // on a note that's part of the active selection (single `selected`, or the
  // 2+ note drag range) — landing on blank space always falls through to the
  // measure-range menu below, which is how ペースト (see noteClipboard) stays
  // reachable even right after copying, while the selection is still active.
  const hit = findClickedNote(region, x, y);
  const hitIsInRange = hit && noteRangeSelection && noteRangeSelection.length >= 2
    && noteRangeSelection.some((s) => s.noteId === hit.noteRef.id);
  const hitIsSelected = hit && selected && hit.noteRef.id === selected.noteId;
  if (hitIsInRange || hitIsSelected) {
    showNoteRangeContextMenu(e.clientX, e.clientY);
    return;
  }
  clearMeasureSelection();
  const withinExisting = rangeSelection && rangeSelection.part === region.part
    && region.measureIndex >= rangeSelection.measureStart && region.measureIndex <= rangeSelection.measureEnd;
  if (!withinExisting) {
    rangeSelection = {
      part: region.part, measureStart: region.measureIndex, measureEnd: region.measureIndex,
    };
    updateRangeLabel();
    renderRangeHighlight(Array.from(scoreContainer.querySelectorAll('.score-page')));
  }
  showRangeContextMenu(e.clientX, e.clientY, region, x);
}

document.addEventListener('mousemove', (e) => {
  if (pendingClick) {
    const dx = e.clientX - pendingClick.startClientX;
    const dy = e.clientY - pendingClick.startClientY;
    if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      const { pageIndex, region } = pendingClick;
      rangeDragging = {
        part: region.part, page: pageIndex, startMeasure: region.measureIndex, endMeasure: region.measureIndex,
      };
      rangeSelection = {
        part: region.part, measureStart: region.measureIndex, measureEnd: region.measureIndex,
      };
      pendingClick = null;
      updateRangeLabel();
      renderRangeHighlight(Array.from(scoreContainer.querySelectorAll('.score-page')));
    }
  }

  if (rangeDragging) {
    const pageDiv = scoreContainer.querySelectorAll('.score-page')[rangeDragging.page];
    if (!pageDiv) return;
    const { x, y } = toLocalCoords(pageDiv, e.clientX, e.clientY);
    const region = findRegionForPart(rangeDragging.page, rangeDragging.part, x, y);
    if (region) {
      rangeDragging.endMeasure = region.measureIndex;
      rangeSelection = {
        part: rangeDragging.part,
        measureStart: Math.min(rangeDragging.startMeasure, rangeDragging.endMeasure),
        measureEnd: Math.max(rangeDragging.startMeasure, rangeDragging.endMeasure),
      };
      updateRangeLabel();
      renderRangeHighlight(Array.from(scoreContainer.querySelectorAll('.score-page')));
    }
    return;
  }
  // Dragging moves only the one tone that was actually clicked (see
  // dragging.keyIndex) — the chord's other pitches, if any, are untouched.
  // Once the drag is big enough to tell, whichever axis dominates locks in
  // for the rest of the gesture: mostly-vertical keeps nudging this tone's
  // pitch (existing behavior); mostly-horizontal instead grows a whole-note
  // range selection (see computeNoteRange) — chords count as one unit either
  // way, since selection/pitch-drag both key off the note object, not a tone.
  if (!dragging) return;
  if (!dragging.moved) {
    const dx = e.clientX - dragging.startClientX;
    const dy = e.clientY - dragging.startClientY;
    if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
    dragging.moved = true;
    dragging.axis = Math.abs(dx) > Math.abs(dy) ? 'range' : 'pitch';
  }
  const pageDiv = dragging.region.page !== undefined
    ? scoreContainer.querySelectorAll('.score-page')[dragging.region.page]
    : null;
  if (!pageDiv) return;
  const { x, y } = toLocalCoords(pageDiv, e.clientX, e.clientY);
  if (dragging.axis === 'range') {
    const region = findRegionForPart(dragging.region.page, dragging.region.part, x, y) || dragging.region;
    const endIndex = findNearestNoteIndex(region, x);
    if (endIndex === -1) return;
    const range = computeNoteRange(
      dragging.region.part, dragging.startMeasureIndex, dragging.startNoteIndex, region.measureIndex, endIndex,
    );
    noteRangeSelection = range.length >= 2 ? range : null;
    renderSoon();
    return;
  }
  const index = indexForY(y, dragging.region.topY, dragging.region.step);
  const baseKey = pitchForIndex(dragging.region.clef, index);
  const { letter, octave } = parseKey(baseKey);
  const tone = dragging.note.keys[dragging.keyIndex];
  const existingAccidental = parseKey(tone.key).accidental;
  const key = buildKey(letter, existingAccidental, octave);
  if (tone.key !== key) {
    setTonePitch(dragging.note, tone, key);
    renderSoon();
  }
});

document.addEventListener('mouseup', () => {
  if (rangeDragging) {
    rangeDragging = null;
  } else if (pendingClick) {
    const { region, localX, localY } = pendingClick;
    pendingClick = null;
    clearRangeSelection();
    clearMeasureSelection();
    // One click places the note — no confirming second click. (There used to
    // be a blinking caret that a first click planted and a second click
    // confirmed; it made every note take two clicks for no real benefit.)
    // insertNote/addPitchToNote leave the new note selected, so it shows up
    // highlighted and the previous note's highlight goes away on its own.
    const slotNote = !selectedRest ? findSameSlotNote(region, localX) : null;
    if (slotNote) {
      addPitchToNote(slotNote, region, localY);
    } else {
      insertNote(region, localX, localY);
    }
    showFloatingToolbox();
    syncNoteControlsFromSelection();
  }
  if (dragging) {
    if (dragging.axis === 'range') {
      // Range selection itself isn't score content — nothing to undo-record,
      // and noteRangeSelection is already exactly what the last mousemove set.
      dragging = null;
    } else {
      let changed = false;
      // A placeholder rest left behind by the N連符 flow exists precisely to
      // be filled in, so a plain click converts it. An ordinary rest is real
      // content: converting that on a bare click meant a rest could never
      // just be *selected* (to change its duration, or delete it) without
      // first turning into a note, so it takes an actual pitch drag.
      const fillsRest = dragging.wasRest && dragging.note.isRest
        && (dragging.note.isPlaceholder || dragging.moved);
      if (fillsRest) {
        dragging.note.isRest = false;
        delete dragging.note.isPlaceholder;
        setStatus('休符を音符にしました');
        changed = true;
      }
      // A plain click-to-select (mouse never crossed DRAG_THRESHOLD) shouldn't
      // push a no-op undo step just because a note happened to be under it.
      if (dragging.moved) {
        if (dragging.note.keys.length > 1) sortNoteKeys(dragging.note);
        changed = true;
      }
      if (changed) {
        render();
        pushHistory();
      }
      dragging = null;
    }
  }
});

// Clicking the blank margin around the pages (not on any page itself) also
// clears the range selection.
document.querySelector('.score-scroll').addEventListener('mousedown', (e) => {
  if (e.target.closest('.score-page')) return;
  clearRangeSelection();
  clearMeasureSelection();
  clearSelection();
  deselectShapeAndField();
});

// Parses a 'tuplet3' / 'tuplet5' / 'tuplet7' link value into its note count.
function tupletCountForLink(link) {
  const match = /^tuplet(\d+)$/.exec(link || '');
  return match ? Number(match[1]) : null;
}

// Where, among measure[region.part]'s existing notes, a click at localX
// falls — used so clicking *between* two notes inserts there instead of
// always appending at the end. region.notes is in the same left-to-right
// order as measure[region.part] (see buildStaveNotes), so the first note
// whose rendered x is past the click marks the insertion point; nothing past
// the click means "append at the end", the original behavior.
function findInsertIndex(region, localX) {
  for (let i = 0; i < region.notes.length; i += 1) {
    const rn = region.notes[i];
    const rx = rn.xs ? Math.min(...rn.xs) : rn.x;
    if (rx > localX) return i;
  }
  return region.notes.length;
}

// Keeps measure[part]'s total duration from ever exceeding the measure's
// capacity: any notes past the point where it would overflow are moved to
// the front of the next measure's same part (creating one at the end of the
// score if needed), then the same check repeats there — so an insertion far
// from the end can ripple forward through several measures.
//
// This is Finale's "keep moving the extra notes until all measures contain
// the correct number of beats" option (see the There Are Too Many Beats In
// This Measure dialog), and it is now used ONLY as the explicit Rebar step
// after a time-signature change — never as a silent consequence of an edit.
// Ordinary insertions are capacity-checked and refused instead (see
// fitsInMeasure below).
//
// Returns how many notes ended up in a different measure than they started in.
function cascadeOverflow(startMeasureIndex, part) {
  let idx = startMeasureIndex;
  let moved = 0;
  while (idx < score.measures.length) {
    const notes = score.measures[idx][part];
    const capacity = measureCapacity(score, idx);
    let used = 0;
    let splitAt = -1;
    for (let i = 0; i < notes.length; i += 1) {
      const beats = noteBeats(notes[i]);
      if (used + beats > capacity + 1e-6) { splitAt = i; break; }
      used += beats;
    }
    if (splitAt === -1) return moved;
    const overflow = notes.splice(splitAt);
    moved += overflow.length;
    if (idx + 1 >= score.measures.length) score.measures.push(createEmptyMeasure());
    score.measures[idx + 1][part] = overflow.concat(score.measures[idx + 1][part]);
    idx += 1;
  }
  return moved;
}

// ---------- 小節単位の容量管理 ----------
//
// A measure is a container with a fixed capacity, not a soft wrapping point.
// Editing operations that would exceed it are refused with a message rather
// than pushing the surplus into the following measure — the old behavior
// meant one mistyped duration could shift the rest of the piece.
// (cascadeOverflow above survives only for the Rebar command, which re-flows
// the whole score on purpose after a time-signature change.)

// Beats already used by `part` in this measure.
function beatsUsedIn(measureIndex, part) {
  const measure = score.measures[measureIndex];
  if (!measure) return 0;
  return (measure[part] || []).reduce((sum, n) => sum + noteBeats(n), 0);
}

// How much room is left in one measure's part, in quarter-note beats.
function remainingCapacity(measureIndex, part) {
  return measureCapacity(score, measureIndex) - beatsUsedIn(measureIndex, part);
}

// True when `beats` more would still fit. The epsilon absorbs the rounding
// that fractional tuplet values (a triplet eighth is 1/3) accumulate.
function fitsInMeasure(measureIndex, part, beats) {
  return beats <= remainingCapacity(measureIndex, part) + 1e-6;
}

function reportMeasureFull(measureIndex) {
  setStatus(`${measureIndex + 1}小節目にはこれ以上音符を入れられません`);
}

// Rest durations usable for padding, longest first, so filling a remainder
// picks the fewest symbols (3 beats -> half + quarter, not three quarters).
const PAD_REST_DURATIONS = [
  { duration: 'w', beats: 4 },
  { duration: 'h', dotted: true, beats: 3 },
  { duration: 'h', beats: 2 },
  { duration: 'q', dotted: true, beats: 1.5 },
  { duration: 'q', beats: 1 },
  { duration: '8', dotted: true, beats: 0.75 },
  { duration: '8', beats: 0.5 },
  { duration: '16', beats: 0.25 },
];

function makeRest(duration, dotted) {
  return {
    id: makeNoteId(),
    // A rest's stored pitch is only a placeholder: the renderer draws every
    // rest at its clef's own anchor position (see buildStaveNotes), and this
    // value is what the note would take if the rest is later dragged into one.
    keys: [{
      key: 'b/4', tieToNext: false, slurTo: null, glissandoTo: null,
    }],
    duration,
    dotted: !!dotted,
    isRest: true,
    selected: false,
    dynamic: '',
    hairpin: null,
    articulation: '',
    tupletId: null,
    tupletCount: null,
    ...noteAnnotationDefaults(),
  };
}

// Completes a part-filled measure with rests so it adds up to a full bar.
//
// Called when the user starts writing into the *next* measure: leaving one
// behind at, say, one beat out of four isn't something you'd ever want in a
// finished score, and having to place the trailing rests by hand every time
// is busywork. Only the measure immediately before the one being written to
// is padded, and only if it already has at least one note — a completely
// empty measure already reads (and plays) as a bar's rest, so filling it in
// would just add clutter.
function padPreviousMeasureWithRests(measureIndex, part) {
  const prevIndex = measureIndex - 1;
  if (prevIndex < 0) return 0;
  const prev = score.measures[prevIndex];
  if (!prev || (prev[part] || []).length === 0) return 0;
  let remaining = remainingCapacity(prevIndex, part);
  if (remaining <= 1e-6) return 0;

  const rests = [];
  PAD_REST_DURATIONS.forEach((option) => {
    while (remaining >= option.beats - 1e-6) {
      rests.push(makeRest(option.duration, option.dotted));
      remaining -= option.beats;
    }
  });
  if (rests.length === 0) return 0;
  prev[part].push(...rests);
  return rests.length;
}

// Re-flows every part of the whole score against the current measure
// capacities. Used after the time signature or pickup length changes, since
// measures filled under the old signature can hold more (or less) than the
// new one allows — Finale's Utilities ▸ Rebar, which it also runs
// automatically when the meter changes.
function rebarWholeScore() {
  let moved = 0;
  PARTS.forEach((part) => { moved += cascadeOverflow(0, part); });
  return moved;
}

// True when some measure currently holds more than its capacity allows —
// checked before offering to rebar, so an unchanged score doesn't prompt.
function hasOverfullMeasure() {
  return score.measures.some((measure, measureIndex) => {
    const capacity = measureCapacity(score, measureIndex);
    return PARTS.some(
      (part) => (measure[part] || []).reduce((sum, n) => sum + noteBeats(n), 0) > capacity + 1e-6,
    );
  });
}

// Inserting a note while N連符 is toggled in the ribbon (see setSelectedLink)
// doesn't just add that one note — it adds the note plus N-1 placeholder
// rests right after it, already carrying the shared tupletId. The
// placeholders show up as ordinary rests; clicking one (see the
// mousedown/mouseup handlers above) fills it in with a real pitch,
// completing the tuplet grouping. タイ/スラー are applied afterward to
// already-placed notes instead (see applyTieToSelectedTone /
// toggleSlurFromSelectedTone) — they no longer affect insertion.
function insertNote(region, x, y) {
  const measure = score.measures[region.measureIndex];
  const insertIndex = findInsertIndex(region, x);
  const tupletCount = tupletCountForLink(selectedLink);
  const index = indexForY(y, region.topY, region.step);
  const baseKey = pitchForIndex(region.clef, index);
  const { letter, octave } = parseKey(baseKey);
  const key = buildKey(letter, selectedAccidental, octave);

  const makeNote = (overrides = {}) => ({
    id: makeNoteId(),
    keys: [{
      key, tieToNext: false, slurTo: null, glissandoTo: null,
    }],
    duration: selectedDuration,
    dotted: selectedDotted,
    isRest: selectedRest,
    selected: false,
    dynamic: '',
    hairpin: null,
    articulation: '',
    tupletId: null,
    tupletCount: null,
    ...noteAnnotationDefaults(),
    ...overrides,
  });

  const notesToInsert = [makeNote()];
  if (tupletCount) {
    const tupletId = makeNoteId();
    notesToInsert[0].tupletId = tupletId;
    notesToInsert[0].tupletCount = tupletCount;
    for (let i = 0; i < tupletCount - 1; i += 1) {
      notesToInsert.push(makeNote({ isRest: true, isPlaceholder: true, tupletId, tupletCount }));
    }
  }

  // The measure is a fixed-size container: if what's being placed doesn't fit,
  // nothing is placed and the user is told. (This used to push the surplus
  // into the following measure and cascade from there, so one wrong duration
  // could shift the whole rest of the piece.)
  const addedBeats = notesToInsert.reduce((sum, n) => sum + noteBeats(n), 0);
  if (!fitsInMeasure(region.measureIndex, region.part, addedBeats)) {
    reportMeasureFull(region.measureIndex);
    return;
  }
  if (tupletCount) setSelectedLink(null);

  // Moving on to a new measure finishes the previous one off with rests, so a
  // half-written bar doesn't stay short.
  const padded = padPreviousMeasureWithRests(region.measureIndex, region.part);

  measure[region.part].splice(insertIndex, 0, ...notesToInsert);

  // The note just placed becomes the selection, so it shows highlighted and
  // whatever was selected before is released — placing notes one after another
  // moves the highlight along with you.
  selected = {
    measureIndex: region.measureIndex, part: region.part, noteId: notesToInsert[0].id, keyIndex: 0,
  };

  pushHistory();
  render();
  syncNoteControlsFromSelection();
  if (padded > 0) setStatus(`${region.measureIndex}小節目の残りを休符で埋めました`);
  if (!selectedRest) playInsertedNoteBlip(region.part, key);
}

// Selects a specific note directly (not via a click on the note itself) —
// used when clicking a リハーサル/レジストレーション box so the 記号 tab's
// selects populate with that note's current value.
function selectNoteFor(measureIndex, part, noteId) {
  selected = { measureIndex, part, noteId, keyIndex: 0 };
  render();
  syncNoteControlsFromSelection();
}

// ---------- リハーサル/レジストレーション: shared per-beat marks ----------
//
// These aren't per-note fields — 上鍵盤/下鍵盤/ペダル (and every tone of a
// chord) sounding at the same instant share ONE mark, keyed by beat offset
// within the measure (see createEmptyMeasure's `marks`). That's what makes
// setting it from any of those simultaneous notes edit the same entry
// (last write wins) instead of stacking a duplicate, overlapping box for
// each note that happens to start at that moment.

function noteBeatStart(measureIndex, part, noteId) {
  const measure = score.measures[measureIndex];
  const idx = (measure[part] || []).findIndex((n) => n.id === noteId);
  if (idx === -1) return null;
  return noteBeatWindow(measure, part, idx).start;
}

function findMarkAtBeat(measure, beat) {
  return (measure.marks || []).find((m) => Math.abs(m.beat - beat) < 1e-6) || null;
}

function findOrCreateMark(measure, beat) {
  if (!measure.marks) measure.marks = [];
  let entry = findMarkAtBeat(measure, beat);
  if (!entry) {
    entry = { beat, rehearsal: '', registration: '' };
    measure.marks.push(entry);
  }
  return entry;
}

function getMarkForSelectedNote() {
  if (!selected) return null;
  const beat = noteBeatStart(selected.measureIndex, selected.part, selected.noteId);
  if (beat === null) return null;
  return findMarkAtBeat(score.measures[selected.measureIndex], beat);
}

function setMarkForSelectedNote(field, value) {
  if (!selected) { setStatus('音符を選択してください'); return; }
  const beat = noteBeatStart(selected.measureIndex, selected.part, selected.noteId);
  if (beat === null) return;
  const measure = score.measures[selected.measureIndex];
  const entry = findOrCreateMark(measure, beat);
  entry[field] = value;
  if (!entry.rehearsal && !entry.registration) {
    measure.marks = measure.marks.filter((m) => m !== entry);
  }
  pushHistory();
  render();
  syncNoteControlsFromSelection();
}

function editChord(measureIndex, noteId) {
  const measure = score.measures[measureIndex];
  const note = measure.lower.find((n) => n.id === noteId);
  if (!note) return;
  showChordModal(`${measureIndex + 1}小節目のコード`, note.chord || '').then((value) => {
    if (value === null) return;
    note.chord = value;
    // An explicit edit always wins over auto-detection from here on — see
    // recomputeAutoChords, which skips any note with chordLocked set.
    note.chordLocked = true;
    note.chordTentative = false;
    pushHistory();
    render();
  });
}

// When a 下鍵盤 note's content matches more than one recognized chord (e.g. a
// diminished 7th, which is spellable from any of its four notes), the
// annotation shows one guess in orange (see staffRenderer.js) — clicking it
// offers the real candidates instead of the full root/quality picker.
function showChordCandidatePicker(measureIndex, noteId, clientX, clientY) {
  const measure = score.measures[measureIndex];
  const noteIndex = measure.lower.findIndex((n) => n.id === noteId);
  if (noteIndex === -1) return;
  const candidates = detectChordCandidates(chordPitchClassesForLowerNote(measure, noteIndex));
  const items = candidates.map((c) => ({
    label: c,
    onClick: () => {
      const note = measure.lower[noteIndex];
      note.chord = c;
      note.chordLocked = true;
      note.chordTentative = false;
      pushHistory();
      render();
    },
  }));
  items.push({ label: 'テキストで編集...', onClick: () => editChord(measureIndex, noteId) });
  showContextMenu(clientX, clientY, items);
}

// A note being deleted might be the target of another tone's スラー or
// グリッサンド elsewhere in the score (both are explicit links, not
// position-based) — clear any that point at it so they don't linger as
// dangling references.
function clearSlursTargeting(noteId) {
  score.measures.forEach((m) => {
    PARTS.forEach((part) => {
      m[part].forEach((n) => {
        n.keys.forEach((t) => {
          if (t.slurTo && t.slurTo.noteId === noteId) t.slurTo = null;
          if (t.glissandoTo && t.glissandoTo.noteId === noteId) t.glissandoTo = null;
        });
      });
    });
  });
}

function deleteSelected() {
  if (!selected) return;
  const measure = score.measures[selected.measureIndex];
  const note = measure[selected.part].find((n) => n.id === selected.noteId);
  if (note && !note.isRest && note.keys.length > 1) {
    note.keys.splice(selected.keyIndex, 1);
    sortNoteKeys(note);
  } else {
    measure[selected.part] = measure[selected.part].filter((n) => n.id !== selected.noteId);
    clearSlursTargeting(selected.noteId);
  }
  selected = null;
  pushHistory();
  render();
  syncNoteControlsFromSelection();
}

// Inserts noteClipboard's contents right before the currently `selected`
// note — the keyboard Ctrl+V equivalent of pasteNotesAtPosition, which needs
// a mouse position that a keyboard shortcut doesn't have.
function pasteNotesAtSelection() {
  if (!noteClipboard || !noteClipboard.length) { setStatus('コピーした音符がありません'); return; }
  if (!selected) { setStatus('貼り付け先の音符を選択してください'); return; }
  const measure = score.measures[selected.measureIndex];
  const notes = measure[selected.part];
  const insertIndex = notes.findIndex((n) => n.id === selected.noteId);
  const clones = cloneNotesWithFreshIds(noteClipboard);
  const addedBeats = clones.reduce((sum, n) => sum + noteBeats(n), 0);
  if (!fitsInMeasure(selected.measureIndex, selected.part, addedBeats)) {
    reportMeasureFull(selected.measureIndex);
    return;
  }
  notes.splice(insertIndex === -1 ? notes.length : insertIndex, 0, ...clones);
  pushHistory();
  render();
  setStatus(`${clones.length}個の音符をペーストしました`);
}

// ---------- standard copy/cut/paste/delete shortcuts ----------
//
// Each acts on whichever selection is currently active, in the same priority
// order as the right-click menus themselves: a 2+ note drag-range first (see
// getActiveNoteSelectionRefs), then a single selected note, then the
// measure-granular rangeSelection (see the ---------- range-selection
// (measure-granularity) ---------- section above).

function copyActiveSelection() {
  if (getActiveNoteSelectionRefs().length) { copySelectedNotes(); return; }
  if (rangeSelection) { doRangeCopy(); return; }
  setStatus('コピーする音符または範囲を選択してください');
}

function cutActiveSelection() {
  if (getActiveNoteSelectionRefs().length) { copySelectedNotes(); deleteSelectedNoteRange(); return; }
  if (rangeSelection) { doRangeCopy(); doRangeDelete(); return; }
  setStatus('切り取る音符または範囲を選択してください');
}

function pasteActiveSelection() {
  if (selected && noteClipboard && noteClipboard.length) { pasteNotesAtSelection(); return; }
  if (rangeSelection && clipboard) { doRangePaste(rangeSelection.measureStart); return; }
  setStatus('貼り付け先を選択してください');
}

function deleteActiveSelection() {
  if (noteRangeSelection && noteRangeSelection.length >= 2) { deleteSelectedNoteRange(); return; }
  if (selected) { deleteSelected(); return; }
  if (rangeSelection) { doRangeDelete(); }
}

document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  const inFormControl = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  const hasSelection = selected || (noteRangeSelection && noteRangeSelection.length >= 2) || rangeSelection;
  if (!inFormControl && (e.key === 'Delete' || e.key === 'Backspace') && hasSelection) {
    e.preventDefault();
    deleteActiveSelection();
  } else if (e.ctrlKey && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
    e.preventDefault();
    redo();
  } else if (!inFormControl && e.ctrlKey && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    copyActiveSelection();
  } else if (!inFormControl && e.ctrlKey && e.key.toLowerCase() === 'x') {
    e.preventDefault();
    cutActiveSelection();
  } else if (!inFormControl && e.ctrlKey && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    pasteActiveSelection();
  } else if (!inFormControl && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && selected) {
    // ↑/↓ nudges the selected tone by one diatonic staff step (line/space) —
    // guarded to regular (non-form-control) focus so it doesn't hijack a
    // number input's own native up/down spinner (e.g. 対象小節) or move a
    // text cursor.
    const note = getSelectedNote();
    const tone = getSelectedTone();
    if (!note || note.isRest || !tone) return;
    e.preventDefault();
    setTonePitch(note, tone, transposeKey(tone.key, e.key === 'ArrowUp' ? 1 : -1));
    sortNoteKeys(note);
    pushHistory();
    render();
    syncNoteControlsFromSelection();
  }
});

// ---------- ribbon tabs ----------

document.querySelectorAll('.ribbon-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.ribbon-tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.ribbon-panel').forEach((p) => {
      p.classList.toggle('active', p.dataset.panel === tab.dataset.tab);
    });
  });
});

// ---------- note/rest/dot/accidental/link selection (shared across ribbon + floating toolbox) ----------
//
// These pickers do double duty: with nothing selected on the score they set
// up what the *next inserted* note will be (the existing behavior); with a
// note currently selected, choosing one instead edits that note in place —
// see applyDurationToSelectedNote / applyDottedToSelectedNote /
// applyAccidentalToSelectedNote.

// A tupleted note's own beat value (needed to capacity-check an edit without
// disturbing its tupletId grouping).
function tupletRatioOf(note) {
  if (!note.tupletId) return 1;
  const count = note.tupletCount || 3;
  return tupletNotesOccupied(count) / count;
}

function beatsFitExcludingNote(measureIndex, part, noteId, beats) {
  const measure = score.measures[measureIndex];
  const otherBeats = measure[part].reduce((sum, n) => (n.id === noteId ? sum : sum + noteBeats(n)), 0);
  const capacity = measureCapacity(score, measureIndex);
  return otherBeats + beats <= capacity + 1e-6;
}

function applyDurationToSelectedNote(value, isRest) {
  const note = getSelectedNote();
  if (!note) return;
  const beats = durationBeats(value, note.dotted, tupletRatioOf(note));
  if (!beatsFitExcludingNote(selected.measureIndex, selected.part, note.id, beats)) {
    setStatus('この小節にはこれ以上入りません');
    return;
  }
  note.duration = value;
  note.isRest = isRest;
  pushHistory();
  render();
  syncNoteControlsFromSelection();
}

function applyDottedToSelectedNote(value) {
  const note = getSelectedNote();
  if (!note) return;
  const beats = durationBeats(note.duration, value, tupletRatioOf(note));
  if (!beatsFitExcludingNote(selected.measureIndex, selected.part, note.id, beats)) {
    setStatus('この小節にはこれ以上入りません');
    return;
  }
  note.dotted = value;
  pushHistory();
  render();
  syncNoteControlsFromSelection();
}

// Applies the accidental to whichever tone within the (possibly chord) note
// is currently selected — the picker still updates what the *next*
// inserted/added pitch uses when nothing is selected.
function applyAccidentalToSelectedNote(value) {
  const note = getSelectedNote();
  if (!note || note.isRest) return;
  const tone = getSelectedTone();
  if (!tone) return;
  const { letter, octave } = parseKey(tone.key);
  tone.key = buildKey(letter, value, octave);
  sortNoteKeys(note);
  pushHistory();
  render();
  syncNoteControlsFromSelection();
}

function setSelectedDuration(value, isRest) {
  selectedDuration = value;
  selectedRest = isRest;
  document.querySelectorAll('[data-duration]').forEach((b) => {
    b.classList.toggle('active', !isRest && b.dataset.duration === value);
  });
  document.querySelectorAll('[data-rest]').forEach((b) => {
    b.classList.toggle('active', isRest && b.dataset.rest === value);
  });
  if (selected) applyDurationToSelectedNote(value, isRest);
}
document.querySelectorAll('[data-duration]').forEach((btn) => {
  btn.addEventListener('click', () => setSelectedDuration(btn.dataset.duration, false));
});
document.querySelectorAll('[data-rest]').forEach((btn) => {
  btn.addEventListener('click', () => setSelectedDuration(btn.dataset.rest, true));
});
setSelectedDuration(selectedDuration, selectedRest);

function setDotted(value) {
  selectedDotted = value;
  document.querySelectorAll('[data-toggle="dot"]').forEach((b) => b.classList.toggle('active', value));
  if (selected) applyDottedToSelectedNote(value);
}
document.querySelectorAll('[data-toggle="dot"]').forEach((btn) => {
  btn.addEventListener('click', () => setDotted(!selectedDotted));
});

// Selecting タイ/スラー/N連符 here works like the duration/accidental
// pickers: it decides what the *next* inserted note brings along with it
// (see insertNote). One-shot — it turns itself back off once used.
function setSelectedLink(value) {
  selectedLink = value;
  document.querySelectorAll('[data-link]').forEach((b) => {
    b.classList.toggle('active', b.dataset.link === value);
  });
}
document.querySelectorAll('[data-link]').forEach((btn) => {
  btn.addEventListener('click', () => {
    setSelectedLink(selectedLink === btn.dataset.link ? null : btn.dataset.link);
  });
});

// ---------- タイ/スラー (applied to an already-selected note/tone, not armed before insertion) ----------
//
// Standard notation software (MuseScore, Dorico, …) treats タイ/スラー as a
// connection between two notes that already exist, rather than something you
// declare before typing a note — see the redesign discussion. タイ connects
// a tone to the next real note of the same pitch (creating that note
// automatically if none exists yet, mirroring MuseScore's note-input tie);
// スラー connects two tones the user picks explicitly, since a slur (unlike
// a tie) can span notes of different pitches.

// pitchKeyOf (the same-staff-position identity a slur/glissando target is
// stored as) now lives in noteLinks.js alongside the rules that consume it.

function applyTieToSelectedTone() {
  const note = getSelectedNote();
  if (!note || note.isRest) { setStatus('音符を選択してください'); return; }
  const tone = getSelectedTone();
  if (!tone) return;

  if (tone.tieToNext) {
    tone.tieToNext = false;
    pushHistory();
    render();
    syncNoteControlsFromSelection();
    setStatus('タイを解除しました');
    return;
  }

  const measure = score.measures[selected.measureIndex];
  const siblings = measure[selected.part];
  const noteIdx = siblings.findIndex((x) => x.id === note.id);
  const pk = pitchKeyOf(tone.key);

  // If this is the last note of its measure, "next" is the first note of the
  // *following* measure — a tie routinely crosses a barline, so this can't
  // stop at the measure's own array.
  let next = siblings[noteIdx + 1];
  if (!next && selected.measureIndex + 1 < score.measures.length) {
    next = score.measures[selected.measureIndex + 1][selected.part][0];
  }
  const matchInNext = next && !next.isRest && next.keys.some((t) => pitchKeyOf(t.key) === pk);

  if (!matchInNext) {
    if (next && !next.isRest) {
      // There IS a next note, it just doesn't carry this pitch yet. A tie
      // means "this pitch keeps sounding through the next note", so the pitch
      // joins that note — which is both musically right and the only way to
      // tie a second tone of a chord without breaking the notation.
      //
      // This used to insert a *separate* single-pitch note at the same beat
      // instead (flagged partialChordNote), leaving two notes competing for
      // one rhythmic position: VexFlow can only place one of them, so the
      // other tie looked like it had never rendered, and the duplicate went
      // on to confuse spacing and playback. Worse, migrateScore stripped the
      // flag on load, so a saved-and-reopened score behaved differently from
      // the same score before saving.
      next.keys.push({
        key: tone.key, tieToNext: false, slurTo: null, glissandoTo: null,
      });
      sortNoteKeys(next);
    } else {
      // Nothing follows (or only a rest does), so the note to tie into has to
      // be created — same pitch, current ribbon duration. Like any other
      // insertion this respects the measure's capacity: if there's no room,
      // the tie is refused rather than pushing the surplus onwards.
      const newBeats = durationBeats(selectedDuration, selectedDotted, 1);
      if (!fitsInMeasure(selected.measureIndex, selected.part, newBeats)) {
        reportMeasureFull(selected.measureIndex);
        return;
      }
      const newNote = {
        id: makeNoteId(),
        keys: [{
          key: tone.key, tieToNext: false, slurTo: null, glissandoTo: null,
        }],
        duration: selectedDuration,
        dotted: selectedDotted,
        isRest: false,
        selected: false,
        dynamic: '',
        hairpin: null,
        articulation: '',
        tupletId: null,
        tupletCount: null,
        ...noteAnnotationDefaults(),
      };
      siblings.splice(noteIdx + 1, 0, newNote);
    }
  }
  tone.tieToNext = true;
  pushHistory();
  render();
  syncNoteControlsFromSelection();
  setStatus(matchInNext ? 'タイをつけました' : '次の音符を追加してタイをつけました');
}

function toggleSlurFromSelectedTone() {
  const note = getSelectedNote();
  if (!note || note.isRest) { setStatus('音符を選択してください'); return; }
  const tone = getSelectedTone();
  if (!tone) return;

  if (tone.slurTo) {
    tone.slurTo = null;
    pendingSlurStart = null;
    pushHistory();
    render();
    syncNoteControlsFromSelection();
    setStatus('スラーを解除しました');
    return;
  }

  pendingSlurStart = { ...selected };
  setStatus('スラーの終わりにしたい音符をクリックしてください(Escで取消)');
}

// Same two-click arm/confirm shape as toggleSlurFromSelectedTone, but for a
// グリッサンド (滑奏) — a straight line between two noteheads (see
// drawGlissandoLines in staffRenderer.js) rather than a curve, since a
// glissando doesn't imply legato phrasing the way a slur does.
function toggleGlissandoFromSelectedTone() {
  const note = getSelectedNote();
  if (!note || note.isRest) { setStatus('音符を選択してください'); return; }
  const tone = getSelectedTone();
  if (!tone) return;

  if (tone.glissandoTo) {
    tone.glissandoTo = null;
    pendingGlissandoStart = null;
    pushHistory();
    render();
    syncNoteControlsFromSelection();
    setStatus('グリッサンドを解除しました');
    return;
  }

  pendingGlissandoStart = { ...selected };
  setStatus('グリッサンドの終わりにしたい音符をクリックしてください(Escで取消)');
}

document.querySelectorAll('[data-tone-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.toneAction === 'tie') applyTieToSelectedTone();
    else if (btn.dataset.toneAction === 'slur') toggleSlurFromSelectedTone();
    else if (btn.dataset.toneAction === 'glissando') toggleGlissandoFromSelectedTone();
  });
});

// '' = no accidental picked, '#'/'b' = sharp/flat, 'n' = explicit natural —
// kept distinct from '' so a natural can actually cancel a standing sharp/
// flat (from earlier in the measure, or from the key signature) both on the
// page and in playback. See scoreModel.keySignatureAccidentalForLetter and
// playback.resolvePlaybackKeys.
function setSelectedAccidental(value) {
  selectedAccidental = value;
  document.querySelectorAll('[data-acc]').forEach((b) => {
    b.classList.toggle('active', b.dataset.acc === value);
  });
  if (selected) applyAccidentalToSelectedNote(value);
}
document.querySelectorAll('[data-acc]').forEach((btn) => {
  btn.addEventListener('click', () => {
    setSelectedAccidental(selectedAccidental === btn.dataset.acc ? '' : btn.dataset.acc);
  });
});
setSelectedAccidental('');

// ---------- floating toolbox ----------

const floatingToolbox = document.getElementById('floating-toolbox');
function showFloatingToolbox() {
  floatingToolbox.hidden = false;
}
document.getElementById('floating-toolbox-close').addEventListener('click', () => {
  floatingToolbox.hidden = true;
});

(function setupFloatingDrag() {
  const handle = document.getElementById('floating-toolbox-handle');
  let dragOffset = null;
  handle.addEventListener('mousedown', (e) => {
    const rect = floatingToolbox.getBoundingClientRect();
    dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragOffset) return;
    floatingToolbox.style.left = `${e.clientX - dragOffset.x}px`;
    floatingToolbox.style.top = `${e.clientY - dragOffset.y}px`;
  });
  document.addEventListener('mouseup', () => { dragOffset = null; });
}());

document.getElementById('btn-delete').addEventListener('click', deleteSelected);
document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-redo').addEventListener('click', redo);

// Inserts right after whichever measure is selected (see the
// measure-number label's own click handler) — falls back to appending at
// the end when nothing is selected, same as the old always-append behavior.
document.getElementById('btn-add-measure').addEventListener('click', () => {
  const insertAt = selectedMeasureIndex !== null ? selectedMeasureIndex + 1 : score.measures.length;
  score.measures.splice(insertAt, 0, createEmptyMeasure());
  pushHistory();
  render();
});

// Removes the selected measure outright (splice, shifting every later
// measure back) rather than just clearing its notes — falls back to the
// last measure when nothing is selected.
document.getElementById('btn-remove-measure').addEventListener('click', () => {
  if (score.measures.length <= 1) {
    setStatus('これ以上削除できません');
    return;
  }
  const targetIndex = selectedMeasureIndex !== null ? selectedMeasureIndex : score.measures.length - 1;
  const target = score.measures[targetIndex];
  const isEmpty = PARTS.every((p) => target[p].length === 0);
  const doRemove = () => {
    score.measures.splice(targetIndex, 1);
    clearMeasureSelection();
    clearRangeSelection();
    clearSelection();
    pushHistory();
    render();
  };
  if (isEmpty) { doRemove(); return; }
  showConfirmModal('この小節には音符があります。削除しますか?').then((ok) => { if (ok) doRemove(); });
});

const zoomPercentEl = document.getElementById('zoom-percent');
function setZoom(newZoom) {
  zoom = Math.max(0.5, Math.min(2, newZoom));
  // Zoom is purely a CSS transform on the container: the score's own layout
  // doesn't change, and hit-testing reads its scale factor back off the
  // rendered page's bounding box (see toLocalCoords), so nothing needs
  // redrawing. Calling render() here rebuilt every page's SVG from scratch —
  // ten times a second while a zoom button was held down.
  scoreContainer.style.transform = `scale(${zoom})`;
  zoomPercentEl.textContent = `${Math.round(zoom * 100)}%`;
}

// Press-and-hold repeats the step (after a short initial delay) until
// release — a single quick click still applies exactly one step, since the
// first step happens immediately on mousedown rather than waiting for the
// repeat timer.
function setUpZoomButton(btn, step) {
  let delayTimer = null;
  let repeatTimer = null;
  const stop = () => {
    clearTimeout(delayTimer);
    clearInterval(repeatTimer);
    delayTimer = null;
    repeatTimer = null;
  };
  btn.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    setZoom(zoom + step);
    delayTimer = setTimeout(() => {
      repeatTimer = setInterval(() => setZoom(zoom + step), 100);
    }, 400);
  });
  btn.addEventListener('mouseleave', stop);
  document.addEventListener('mouseup', stop);
}
setUpZoomButton(document.getElementById('btn-zoom-in'), 0.1);
setUpZoomButton(document.getElementById('btn-zoom-out'), -0.1);

// ---------- 表示形式: 縦スクロール / 見開き(横スクロール) ----------
// A display preference, not document content — not saved into the score file.

const viewVerticalBtn = document.getElementById('btn-view-vertical');
const viewSpreadBtn = document.getElementById('btn-view-spread');
function setViewMode(mode) {
  scoreContainer.classList.toggle('spread-view', mode === 'spread');
  viewVerticalBtn.classList.toggle('active', mode === 'vertical');
  viewSpreadBtn.classList.toggle('active', mode === 'spread');
}
viewVerticalBtn.addEventListener('click', () => setViewMode('vertical'));
viewSpreadBtn.addEventListener('click', () => setViewMode('spread'));

document.getElementById('chk-show-chords').addEventListener('change', (e) => {
  score.showChordSymbols = e.target.checked;
  pushHistory();
  render();
});

const bpmInput = document.getElementById('bpm-input');
const bpmNoteSelect = document.getElementById('bpm-note-select');
TEMPO_NOTE_VALUES.forEach((value) => {
  const opt = document.createElement('option');
  opt.value = value;
  // A <select><option> can't hold the SVG icon the on-page tempo marking
  // uses (see TEMPO_NOTE_ICON_SVG) — the Japanese label alone is unambiguous
  // and avoids the tofu/mojibake risk the old Unicode musical-symbols glyph
  // had here for note values outside the common BMP block (w/h/16).
  opt.textContent = DURATION_LABELS[value];
  bpmNoteSelect.appendChild(opt);
});
bpmInput.value = score.bpm;
bpmNoteSelect.value = score.bpmNoteValue;
bpmInput.addEventListener('change', () => {
  score.bpm = Math.max(20, Math.min(300, Number(bpmInput.value) || 100));
  bpmInput.value = score.bpm;
  pushHistory();
  render();
});
bpmNoteSelect.addEventListener('change', () => {
  score.bpmNoteValue = bpmNoteSelect.value;
  pushHistory();
  render();
});

// ---------- playback position highlight ----------

function clearPlaybackHighlights() {
  highlightTimers.forEach(clearTimeout);
  highlightTimers = [];
  highlightEls.forEach((el) => el.remove());
  highlightEls = [];
}

// Pausing (unlike a full stop) leaves whatever highlight box is currently
// showing right where it is — only the *pending* timers (future notes'
// show/hide) are cancelled, so nothing changes further until playback
// resumes and reschedules from the paused position.
function freezePlaybackHighlights() {
  highlightTimers.forEach(clearTimeout);
  highlightTimers = [];
}

function findNoteHitById(noteId) {
  for (let i = 0; i < hitMap.length; i += 1) {
    const region = hitMap[i];
    const found = region.notes.find((n) => n.noteRef.id === noteId);
    if (found) return { region, note: found };
  }
  return null;
}

// Schedules a highlight overlay (same technique as the range-selection boxes)
// over every note sounding at each playback event's start, removed again at
// its end — run on the same clock (PLAYBACK_LEAD) as the actual audio so the
// two stay in sync.
function schedulePlaybackHighlights(startTime = 0) {
  const events = buildPlaybackEvents(score, effectiveQuarterBpm(score));
  events.forEach((ev) => {
    if (!ev.ids || ev.ids.length === 0) return;
    const evEnd = ev.time + ev.duration;
    if (evEnd <= startTime) return; // already finished before the start point
    const offset = Math.max(0, ev.time - startTime);
    const remaining = evEnd - Math.max(ev.time, startTime);
    const shownEls = [];
    const onTimer = setTimeout(() => {
      // Positions are looked up when the highlight is actually drawn, not when
      // it was scheduled. Editing the score mid-playback rebuilds hitMap and
      // recreates every page element, so coordinates captured up front would
      // put the box somewhere the note no longer is.
      const targets = ev.ids.map((id) => findNoteHitById(id)).filter(Boolean);
      if (targets.length === 0) return;
      const pages = Array.from(scoreContainer.querySelectorAll('.score-page'));
      targets.forEach(({ region, note }) => {
        const pageDiv = pages[region.page];
        if (!pageDiv) return;
        const div = document.createElement('div');
        div.className = 'playing-highlight';
        div.style.left = `${note.x - 11}px`;
        div.style.top = `${region.topY - 40}px`;
        div.style.width = '22px';
        div.style.height = '120px';
        pageDiv.appendChild(div);
        shownEls.push(div);
        highlightEls.push(div);
      });
      // Follow playback down the page — without this, the highlight keeps
      // moving correctly but scrolls out of view on anything longer than
      // what fits on screen, which just looks like it stopped working.
      if (shownEls[0]) {
        const box = shownEls[0].getBoundingClientRect();
        const viewport = document.querySelector('.score-scroll').getBoundingClientRect();
        const inView = box.top >= viewport.top && box.bottom <= viewport.bottom;
        if (!inView) shownEls[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, (offset + PLAYBACK_LEAD) * 1000);
    const offTimer = setTimeout(() => {
      shownEls.forEach((el) => el.remove());
      highlightEls = highlightEls.filter((el) => !shownEls.includes(el));
    }, (offset + remaining + PLAYBACK_LEAD) * 1000);
    highlightTimers.push(onTimer, offTimer);
  });
}

// Where playback should begin: resume position if paused, else the
// currently-selected note's earliest occurrence (見た目上は「選択中の音符から
// 再生」), else the very start.
function computePlaybackStartTime() {
  if (player.pausedAt > 0) return player.pausedAt;
  if (!selected) return 0;
  const events = buildPlaybackEvents(score, effectiveQuarterBpm(score));
  const matching = events.filter((ev) => ev.ids && ev.ids.includes(selected.noteId));
  if (!matching.length) return 0;
  return Math.min(...matching.map((ev) => ev.time));
}

const playBtn = document.getElementById('btn-play');
const pauseBtn = document.getElementById('btn-pause');

const PLAY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><polygon points="5,3 21,12 5,21" fill="currentColor"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="4" y="4" width="16" height="16" fill="currentColor"/></svg>';

// btn-play doubles as play/stop (▶ while idle or paused, ■ while actually
// sounding — clicking it mid-playback stops outright, back to position 0).
// btn-pause is the separate 一時停止 control (see below) — pausing swaps
// btn-play's icon back to ▶ but in a distinct color so it visibly reads as
// "resume from here", not "start over" (見た目上もクリック先が違うと分かる
// ように — 色を変えているのはこのため).
function setPlayButtonState(state) {
  playBtn.classList.remove('active', 'paused');
  if (state === 'playing') {
    playBtn.innerHTML = STOP_ICON;
    playBtn.title = '停止';
    playBtn.classList.add('active');
  } else if (state === 'paused') {
    playBtn.innerHTML = PLAY_ICON;
    playBtn.title = '再生(一時停止した位置から再開)';
    playBtn.classList.add('paused');
  } else {
    playBtn.innerHTML = PLAY_ICON;
    playBtn.title = '再生/停止(音符を選択中ならそこから再生)';
  }
  pauseBtn.disabled = state !== 'playing';
}
setPlayButtonState('idle');

playBtn.addEventListener('click', async () => {
  if (player.playing) {
    player.stop();
    clearPlaybackHighlights();
    setPlayButtonState('idle');
    return;
  }
  const startTime = computePlaybackStartTime();
  setPlayButtonState('playing');
  playBtn.disabled = true;
  clearPlaybackHighlights();
  schedulePlaybackHighlights(startTime);
  try {
    await player.play(score, effectiveQuarterBpm(score), score.instruments, () => {
      setPlayButtonState('idle');
      clearPlaybackHighlights();
    }, startTime);
  } finally {
    playBtn.disabled = false;
  }
});

pauseBtn.addEventListener('click', () => {
  if (!player.playing) return;
  player.pause();
  // The paused-at note's playing-highlight stays on screen (see
  // schedulePlaybackHighlights/clearPlaybackHighlights) rather than clearing
  // like a full stop does — freezeplaybackHighlights below cancels only the
  // *pending* highlight timers so nothing still queues in after the pause,
  // without removing whatever highlight box is already showing.
  freezePlaybackHighlights();
  setPlayButtonState('paused');
});

// ---------- 印刷 / PDF書き出し ----------
//
// The editing chrome (quickbar, ribbon, floating toolbox, measure numbers,
// caret, highlight boxes) is hidden by @media print in style.css, but a few
// editing-only marks are drawn *into the score itself* rather than as
// separate elements — most visibly, the selected notehead is painted blue by
// VexFlow (see buildStaveNotes' setKeyStyle). CSS can't reach inside that, so
// the selection has to actually be cleared and the score redrawn before
// printing, or the selected note prints blue.
// The print stylesheet keys off `html.printing` rather than `@media print`,
// because 印刷 (window.print()) and PDF書き出し (the main process calling
// printToPDF on this page) don't both put the renderer into print media.
// Toggling a class covers both, and makes the print layout inspectable on
// screen too.
function enterPrintLayout() {
  document.documentElement.classList.add('printing');
}

function leavePrintLayout() {
  document.documentElement.classList.remove('printing');
}

function clearAllSelectionsForPrint() {
  const hadAnything = selected || multiSelected.length || noteRangeSelection
    || rangeSelection || selectedMeasureIndex !== null;
  if (!hadAnything) return;
  selected = null;
  multiSelected = [];
  noteRangeSelection = null;
  rangeSelection = null;
  selectedMeasureIndex = null;
  pendingSlurStart = null;
  pendingGlissandoStart = null;
  deselectShapeAndField();
  updateRangeLabel();
  render();
  syncNoteControlsFromSelection();
}

// Fires for any OS/browser-initiated print (and for window.print() below), so
// even a print started outside the ribbon gets the right layout.
window.addEventListener('beforeprint', () => {
  clearAllSelectionsForPrint();
  enterPrintLayout();
});
window.addEventListener('afterprint', leavePrintLayout);

document.getElementById('btn-print').addEventListener('click', () => {
  clearAllSelectionsForPrint();
  enterPrintLayout();
  window.print();
  // afterprint restores the screen layout on its own, but not every platform
  // fires it reliably — clear it here too so the app can't get stuck in print
  // layout with no ribbon.
  leavePrintLayout();
});

document.getElementById('btn-export-pdf').addEventListener('click', async () => {
  if (!window.electronAPI) { setStatus('PDF書き出しはアプリ版でのみ利用できます'); return; }
  // printToPDF drives the page from the main process and never fires
  // beforeprint, so the print layout has to be applied explicitly here.
  clearAllSelectionsForPrint();
  enterPrintLayout();
  // Let the browser paint the print layout before the main process snapshots
  // the page — printToPDF reads the live document, not a queued frame.
  await new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); });
  setStatus('PDFを書き出しています…');
  try {
    const result = await window.electronAPI.exportPdf(`${score.title || 'score'}.pdf`);
    setStatus(result.canceled ? '' : `PDFを書き出しました: ${result.filePath}`);
  } catch (err) {
    setStatus('PDFの書き出しに失敗しました');
  } finally {
    leavePrintLayout();
  }
});

function download(filename, blobParts, type) {
  const blob = new Blob(blobParts, { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// markSelection() stamps the current selection onto the note objects
// themselves (that's how the renderer knows what to highlight), so a plain
// JSON.stringify(score) writes editing state into the saved file — bloating
// it and making a reopened score come back with a stale highlight. Strip
// those transient fields out of the copy that gets written.
const TRANSIENT_NOTE_FIELDS = ['selected', 'selectedKeyIndex', 'multiSelectedKeyIndices', 'rangeSelected'];

function scoreForSave() {
  const copy = structuredClone(score);
  (copy.measures || []).forEach((measure) => {
    PARTS.forEach((part) => {
      (measure[part] || []).forEach((n) => {
        TRANSIENT_NOTE_FIELDS.forEach((field) => { delete n[field]; });
      });
    });
  });
  return copy;
}

function saveScoreFile() {
  download(`${score.title || 'score'}.json`, [JSON.stringify(scoreForSave(), null, 2)], 'application/json');
  savedHistoryIndex = historyIndex;
}

// True when the score has edits that haven't been written to a file — the same
// undo-position check the close-confirmation dialog uses.
function hasUnsavedChanges() {
  return historyIndex !== savedHistoryIndex;
}

// Opening a file or starting from a template replaces the whole score. Closing
// the window already asks before discarding unsaved edits; these two didn't,
// and silently threw the current score away.
async function confirmDiscardUnsaved(what) {
  if (!hasUnsavedChanges()) return true;
  return showConfirmModal(`保存していない変更があります。破棄して${what}しますか?`);
}

document.getElementById('btn-save').addEventListener('click', saveScoreFile);

const openInput = document.getElementById('open-input');
document.getElementById('btn-open').addEventListener('click', () => openInput.click());
openInput.addEventListener('change', async () => {
  const file = openInput.files[0];
  // Cleared up front (not after reading) so picking the same file again still
  // fires a change event, and so an early return can't leave it selected.
  openInput.value = '';
  if (!file) return;
  if (!(await confirmDiscardUnsaved('開く'))) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const loaded = JSON.parse(reader.result);
      score = migrateScore(loaded);
      if (!score.pickupBeats) score.pickupBeats = 0;
      if (!score.clefs) score.clefs = { upper: 'treble', lower: 'bass', pedal: 'bass' };
      if (score.composer === undefined) score.composer = '';
      if (score.lyricist === undefined) score.lyricist = '';
      if (!score.keySignature) score.keySignature = 'C';
      history = [structuredClone(score)];
      historyIndex = 0;
      savedHistoryIndex = 0;
      selected = null;
      rangeSelection = null;
      selectedMeasureIndex = null;
      syncControlsFromScore();
      render();
      setStatus('読み込みました');
    } catch (err) {
      setStatus('読み込みに失敗しました');
    }
  };
  reader.readAsText(file);
});

document.getElementById('btn-export-midi').addEventListener('click', () => {
  const buffer = buildMidiFile(score, effectiveQuarterBpm(score));
  download(`${score.title || 'score'}.mid`, [buffer], 'audio/midi');
});

document.getElementById('btn-export-wav').addEventListener('click', async () => {
  setStatus('音声を書き出し中...');
  const buffer = await renderScoreToWavBuffer(score, effectiveQuarterBpm(score), score.instruments);
  download(`${score.title || 'score'}.wav`, [buffer], 'audio/wav');
  setStatus('書き出しました');
});

const titleInput = document.getElementById('title-input');
titleInput.value = score.title;
titleInput.addEventListener('change', () => {
  score.title = titleInput.value || '無題の楽譜';
  pushHistory();
  // The title also appears on page 1 of the score itself (see
  // renderTitleHeader), which only redraws from render() — without this the
  // printed title stayed at its old value until some unrelated edit happened
  // to trigger a redraw.
  render();
});

// --- 拍子記号 ---

const timeSigInput = document.getElementById('timesig-input');
timeSigInput.value = score.timeSig;
document.getElementById('btn-apply-timesig').addEventListener('click', async () => {
  const value = timeSigInput.value.trim();
  if (!isValidTimeSig(value)) {
    setStatus('拍子記号の形式が正しくありません(例: 4/4)');
    return;
  }
  const previous = score.timeSig;
  score.timeSig = value;
  const full = beatsPerMeasure(score);
  if (score.pickupBeats > full) {
    score.pickupBeats = full;
    pickupInput.value = full;
  }
  // Measures filled under the old signature can hold more than the new one
  // allows (4/4 -> 3/4 leaves every measure a beat over). Previously nothing
  // re-checked them: the notes stayed put, spilled past their barlines on the
  // page, and overlapped the next measure during playback. Offer the rebar
  // instead of silently doing either thing.
  if (hasOverfullMeasure()) {
    const ok = await showConfirmModal(
      `拍子を ${previous} から ${value} に変更したため、拍数が入りきらない小節があります。音符を小節をまたいで詰め直しますか?(キャンセルすると、はみ出したまま残します)`,
    );
    if (ok) {
      const moved = rebarWholeScore();
      setStatus(`拍子を変更し、${moved}個の音符を詰め直しました`);
    } else {
      setStatus('拍子を変更しました(音符はそのままです)');
    }
  }
  pushHistory();
  render();
});

// --- 弱起(ピックアップ小節) ---

const pickupInput = document.getElementById('pickup-input');
pickupInput.value = score.pickupBeats || 0;
pickupInput.addEventListener('change', async () => {
  const full = beatsPerMeasure(score);
  const value = Math.max(0, Math.min(full, Number(pickupInput.value) || 0));
  pickupInput.value = value;
  score.pickupBeats = value;
  // Shortening the pickup can leave measure 1 over its new capacity — same
  // situation as a time signature change, handled the same way.
  if (hasOverfullMeasure()) {
    const ok = await showConfirmModal(
      '弱起の拍数を変更したため、拍数が入りきらない小節があります。音符を小節をまたいで詰め直しますか?(キャンセルすると、はみ出したまま残します)',
    );
    if (ok) {
      const moved = rebarWholeScore();
      setStatus(`${moved}個の音符を詰め直しました`);
    }
  }
  pushHistory();
  render();
});

// --- 調号 ---

const keySigSelect = document.getElementById('keysig-select');
KEY_SIGNATURES.forEach((k) => {
  const opt = document.createElement('option');
  opt.value = k.value;
  opt.textContent = k.label;
  keySigSelect.appendChild(opt);
});
keySigSelect.value = score.keySignature || 'C';
keySigSelect.addEventListener('change', () => {
  score.keySignature = keySigSelect.value;
  pushHistory();
  render();
});

// --- 音部記号(パートごとに選択可能) ---

PARTS.forEach((part) => {
  const select = document.getElementById(`clef-${part}`);
  CLEF_OPTIONS.forEach((clefId) => {
    const opt = document.createElement('option');
    opt.value = clefId;
    opt.textContent = CLEF_LABELS[clefId];
    select.appendChild(opt);
  });
  select.value = score.clefs[part];
  select.addEventListener('change', () => {
    score.clefs[part] = select.value;
    pushHistory();
    render();
  });
});

// --- 楽器(パートごとに選択可能、再生・WAV書き出しで使う) ---

// General MIDI's 128 instrument names, as smplr's getSoundfontNames() returns
// them (English, snake_case) → the Japanese labels shown in the select. The
// select's own value stays the original GM name (what Player/playback.js
// actually loads); only the visible text is translated.
const INSTRUMENT_LABELS_JA = {
  acoustic_grand_piano: 'アコースティックグランドピアノ',
  bright_acoustic_piano: 'ブライトアコースティックピアノ',
  electric_grand_piano: 'エレクトリックグランドピアノ',
  honkytonk_piano: 'ホンキートンクピアノ',
  electric_piano_1: 'エレクトリックピアノ1',
  electric_piano_2: 'エレクトリックピアノ2',
  harpsichord: 'ハープシコード',
  clavinet: 'クラビネット',
  celesta: 'チェレスタ',
  glockenspiel: 'グロッケンシュピール',
  music_box: 'オルゴール',
  vibraphone: 'ヴィブラフォン',
  marimba: 'マリンバ',
  xylophone: 'シロフォン',
  tubular_bells: 'チューブラーベル',
  dulcimer: 'ダルシマー',
  drawbar_organ: 'ドローバーオルガン',
  percussive_organ: 'パーカッシブオルガン',
  rock_organ: 'ロックオルガン',
  church_organ: 'チャーチオルガン',
  reed_organ: 'リードオルガン',
  accordion: 'アコーディオン',
  harmonica: 'ハーモニカ',
  tango_accordion: 'タンゴアコーディオン(バンドネオン)',
  acoustic_guitar_nylon: 'クラシックギター(ナイロン弦)',
  acoustic_guitar_steel: 'アコースティックギター(スチール弦)',
  electric_guitar_jazz: 'ジャズギター',
  electric_guitar_clean: 'クリーンエレキギター',
  electric_guitar_muted: 'ミュートエレキギター',
  overdriven_guitar: 'オーバードライブギター',
  distortion_guitar: 'ディストーションギター',
  guitar_harmonics: 'ギターハーモニクス',
  acoustic_bass: 'アコースティックベース',
  electric_bass_finger: 'エレキベース(指弾き)',
  electric_bass_pick: 'エレキベース(ピック弾き)',
  fretless_bass: 'フレットレスベース',
  slap_bass_1: 'スラップベース1',
  slap_bass_2: 'スラップベース2',
  synth_bass_1: 'シンセベース1',
  synth_bass_2: 'シンセベース2',
  violin: 'ヴァイオリン',
  viola: 'ヴィオラ',
  cello: 'チェロ',
  contrabass: 'コントラバス',
  tremolo_strings: 'トレモロストリングス',
  pizzicato_strings: 'ピチカートストリングス',
  orchestral_harp: 'オーケストラルハープ',
  timpani: 'ティンパニ',
  string_ensemble_1: 'ストリングアンサンブル1',
  string_ensemble_2: 'ストリングアンサンブル2',
  synth_strings_1: 'シンセストリングス1',
  synth_strings_2: 'シンセストリングス2',
  choir_aahs: '混声合唱(アー)',
  voice_oohs: '混声合唱(ウー)',
  synth_choir: 'シンセコーラス',
  orchestra_hit: 'オーケストラヒット',
  trumpet: 'トランペット',
  trombone: 'トロンボーン',
  tuba: 'チューバ',
  muted_trumpet: 'ミュートトランペット',
  french_horn: 'フレンチホルン',
  brass_section: 'ブラスセクション',
  synth_brass_1: 'シンセブラス1',
  synth_brass_2: 'シンセブラス2',
  soprano_sax: 'ソプラノサックス',
  alto_sax: 'アルトサックス',
  tenor_sax: 'テナーサックス',
  baritone_sax: 'バリトンサックス',
  oboe: 'オーボエ',
  english_horn: 'イングリッシュホルン',
  bassoon: 'ファゴット',
  clarinet: 'クラリネット',
  piccolo: 'ピッコロ',
  flute: 'フルート',
  recorder: 'リコーダー',
  pan_flute: 'パンフルート',
  blown_bottle: 'ボトルブロー',
  shakuhachi: '尺八',
  whistle: 'ホイッスル',
  ocarina: 'オカリナ',
  lead_1_square: 'リード1(矩形波)',
  lead_2_sawtooth: 'リード2(ノコギリ波)',
  lead_3_calliope: 'リード3(カリオペ)',
  lead_4_chiff: 'リード4(チフ)',
  lead_5_charang: 'リード5(チャランゴ)',
  lead_6_voice: 'リード6(ボイス)',
  lead_7_fifths: 'リード7(5度)',
  lead_8_bass__lead: 'リード8(ベース&リード)',
  pad_1_new_age: 'パッド1(ニューエイジ)',
  pad_2_warm: 'パッド2(ウォーム)',
  pad_3_polysynth: 'パッド3(ポリシンセ)',
  pad_4_choir: 'パッド4(クワイア)',
  pad_5_bowed: 'パッド5(ボウド)',
  pad_6_metallic: 'パッド6(メタリック)',
  pad_7_halo: 'パッド7(ハロー)',
  pad_8_sweep: 'パッド8(スウィープ)',
  fx_1_rain: 'FX1(レイン)',
  fx_2_soundtrack: 'FX2(サウンドトラック)',
  fx_3_crystal: 'FX3(クリスタル)',
  fx_4_atmosphere: 'FX4(アトモスフィア)',
  fx_5_brightness: 'FX5(ブライトネス)',
  fx_6_goblins: 'FX6(ゴブリン)',
  fx_7_echoes: 'FX7(エコー)',
  fx_8_scifi: 'FX8(SF)',
  sitar: 'シタール',
  banjo: 'バンジョー',
  shamisen: '三味線',
  koto: '琴',
  kalimba: 'カリンバ',
  bagpipe: 'バグパイプ',
  fiddle: 'フィドル',
  shanai: 'シャナイ',
  tinkle_bell: 'ティンクルベル',
  agogo: 'アゴゴ',
  steel_drums: 'スティールドラム',
  woodblock: 'ウッドブロック',
  taiko_drum: '太鼓',
  melodic_tom: 'メロディックタム',
  synth_drum: 'シンセドラム',
  reverse_cymbal: 'リバースシンバル',
  guitar_fret_noise: 'ギターフレットノイズ',
  breath_noise: 'ブレスノイズ',
  seashore: '波の音',
  bird_tweet: '鳥のさえずり',
  telephone_ring: '電話の呼び出し音',
  helicopter: 'ヘリコプター',
  applause: '拍手',
  gunshot: '銃声',
};

const SOUNDFONT_NAMES = getSoundfontNames();
PARTS.forEach((part) => {
  const select = document.getElementById(`instrument-${part}`);
  if (!select) return;
  SOUNDFONT_NAMES.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = INSTRUMENT_LABELS_JA[name] || name;
    select.appendChild(opt);
  });
  select.value = score.instruments[part] || DEFAULT_INSTRUMENT;
  select.addEventListener('change', () => {
    score.instruments[part] = select.value;
    pushHistory();
  });
});

// --- 選択中の音符: タイ・スラー・強弱・アーティキュレーション・歌詞 ---

function withSelectedNote(fn) {
  const note = getSelectedNote();
  if (!note) {
    setStatus('音符を選択してください');
    return;
  }
  fn(note);
  pushHistory();
  render();
  syncNoteControlsFromSelection();
}

document.getElementById('dynamic-select').addEventListener('change', (e) => {
  withSelectedNote((note) => { note.dynamic = e.target.value; });
});
document.getElementById('articulation-select').addEventListener('change', (e) => {
  withSelectedNote((note) => { note.articulation = e.target.value; });
});

const rehearsalSelect = document.getElementById('rehearsal-select');
REHEARSAL_OPTIONS.forEach((v) => {
  const opt = document.createElement('option');
  opt.value = v;
  opt.textContent = v || 'なし';
  rehearsalSelect.appendChild(opt);
});
rehearsalSelect.addEventListener('change', (e) => {
  setMarkForSelectedNote('rehearsal', e.target.value);
});

const registrationSelect = document.getElementById('registration-select');
REGISTRATION_OPTIONS.forEach((v) => {
  const opt = document.createElement('option');
  opt.value = v;
  opt.textContent = v || 'なし';
  registrationSelect.appendChild(opt);
});
registrationSelect.addEventListener('change', (e) => {
  setMarkForSelectedNote('registration', e.target.value);
});
document.getElementById('btn-cresc-start').addEventListener('click', () => {
  withSelectedNote((note) => { note.hairpin = note.hairpin === 'cresc-start' ? null : 'cresc-start'; });
});
document.getElementById('btn-cresc-end').addEventListener('click', () => {
  withSelectedNote((note) => { note.hairpin = note.hairpin === 'cresc-end' ? null : 'cresc-end'; });
});
document.getElementById('btn-decresc-start').addEventListener('click', () => {
  withSelectedNote((note) => { note.hairpin = note.hairpin === 'decresc-start' ? null : 'decresc-start'; });
});
document.getElementById('btn-decresc-end').addEventListener('click', () => {
  withSelectedNote((note) => { note.hairpin = note.hairpin === 'decresc-end' ? null : 'decresc-end'; });
});
document.getElementById('btn-lyric').addEventListener('click', () => {
  // 歌詞 is per-line (段落) *per staff*, not per-note — 対象小節 (same input
  // the 小節タブ's マーカー/小節線 controls use) picks which line via
  // whichever measure it belongs to, and lyric-part-select picks which staff.
  const measure = targetMeasure();
  if (!measure) return;
  const part = document.getElementById('lyric-part-select').value;
  const partLabel = { upper: '上鍵盤', lower: '下鍵盤', pedal: 'ペダル' }[part];
  showPromptModal(`歌詞・${partLabel}（この小節が属する段落に表示されます）`, measure.lyrics[part] || '').then((value) => {
    if (value === null) return;
    measure.lyrics[part] = value;
    pushHistory();
    render();
  });
});

// --- 小節設定: レジストレーション・コード・小節線・リピート・マーカー ---

function targetMeasure() {
  const targetInput = document.getElementById('measure-target-input');
  const idx = Math.round(Number(targetInput.value)) - 1;
  if (idx < 0 || idx >= score.measures.length) {
    setStatus('小節番号が範囲外です');
    return null;
  }
  return score.measures[idx];
}

// Centralized measure-level setters so both the ribbon controls and the
// measure-number right-click menu share the same behavior (including: a
// "終止線" (final barline) truncates every measure after it, since nothing
// should follow the end of the piece).
async function setBarlineEnd(measureIndex, value) {
  const measure = score.measures[measureIndex];
  if (!measure) return;
  if (value === 'final' && measureIndex < score.measures.length - 1) {
    const removed = score.measures.slice(measureIndex + 1);
    // Setting a final barline in the middle of a piece throws away everything
    // after it. That's the intended behavior, but doing it silently meant one
    // menu click could delete most of a score with no warning — so confirm
    // whenever the measures being dropped actually contain music.
    const hasMusic = removed.some((m) => PARTS.some((p) => (m[p] || []).length > 0));
    if (hasMusic) {
      const ok = await showConfirmModal(
        `終止線より後の${removed.length}小節(音符を含む)を削除します。よろしいですか?`,
      );
      if (!ok) return;
    }
    measure.barlineEnd = value;
    score.measures.length = measureIndex + 1;
  } else {
    measure.barlineEnd = value;
  }
  pushHistory();
  render();
}

function toggleRepeatStart(measureIndex) {
  const measure = score.measures[measureIndex];
  if (!measure) return;
  measure.repeatStart = !measure.repeatStart;
  pushHistory();
  render();
}

function toggleRepeatEnd(measureIndex) {
  const measure = score.measures[measureIndex];
  if (!measure) return;
  measure.repeatEnd = !measure.repeatEnd;
  pushHistory();
  render();
}

function setMarker(measureIndex, value) {
  const measure = score.measures[measureIndex];
  if (!measure) return;
  measure.marker = value;
  pushHistory();
  render();
}

function toggleLineBreak(measureIndex) {
  const measure = score.measures[measureIndex];
  if (!measure) return;
  measure.lineBreak = !measure.lineBreak;
  pushHistory();
  render();
}

function showMeasureContextMenu(clientX, clientY, measureIndex) {
  const measure = score.measures[measureIndex];
  if (!measure) return;
  showContextMenu(clientX, clientY, [
    { header: `${measureIndex + 1}小節目` },
    { header: '小節線' },
    { label: '通常線', active: measure.barlineEnd === 'single', onClick: () => setBarlineEnd(measureIndex, 'single') },
    { label: '二重線', active: measure.barlineEnd === 'double', onClick: () => setBarlineEnd(measureIndex, 'double') },
    { label: '終止線(以降の小節を削除)', active: measure.barlineEnd === 'final', onClick: () => setBarlineEnd(measureIndex, 'final') },
    { separator: true },
    {
      label: measure.repeatStart ? 'リピート開始を解除' : 'リピート開始にする',
      onClick: () => toggleRepeatStart(measureIndex),
    },
    {
      label: measure.repeatEnd ? 'リピート終了を解除' : 'リピート終了にする',
      onClick: () => toggleRepeatEnd(measureIndex),
    },
    { separator: true },
    {
      label: measure.lineBreak ? 'ここでの改行を解除' : 'ここで改行する',
      active: !!measure.lineBreak,
      onClick: () => toggleLineBreak(measureIndex),
    },
    { separator: true },
    {
      label: 'n番括弧',
      submenu: [
        { label: 'なし', active: !measure.volta, onClick: () => setVolta(measureIndex, null) },
        ...[1, 2, 3, 4, 5].map((n) => ({
          label: `${n}番`,
          active: !!(measure.volta && measure.volta.number === n),
          onClick: () => setVolta(measureIndex, n),
        })),
      ],
    },
    { separator: true },
    { header: 'マーカー' },
    { label: 'なし', active: !measure.marker, onClick: () => setMarker(measureIndex, '') },
    { label: 'Segno', active: measure.marker === 'Segno', onClick: () => setMarker(measureIndex, 'Segno') },
    { label: 'D.C.', active: measure.marker === 'D.C.', onClick: () => setMarker(measureIndex, 'D.C.') },
    { label: 'D.S.', active: measure.marker === 'D.S.', onClick: () => setMarker(measureIndex, 'D.S.') },
    { label: 'Fine', active: measure.marker === 'Fine', onClick: () => setMarker(measureIndex, 'Fine') },
    { label: 'Coda', active: measure.marker === 'Coda', onClick: () => setMarker(measureIndex, 'Coda') },
  ]);
}

document.getElementById('btn-repeat-start').addEventListener('click', () => {
  const measure = targetMeasure();
  if (!measure) return;
  toggleRepeatStart(score.measures.indexOf(measure));
});
document.getElementById('btn-repeat-end').addEventListener('click', () => {
  const measure = targetMeasure();
  if (!measure) return;
  toggleRepeatEnd(score.measures.indexOf(measure));
});
document.getElementById('btn-apply-barline').addEventListener('click', () => {
  const measure = targetMeasure();
  if (!measure) return;
  setBarlineEnd(score.measures.indexOf(measure), document.getElementById('barline-select').value);
});
document.getElementById('btn-apply-marker').addEventListener('click', () => {
  const measure = targetMeasure();
  if (!measure) return;
  setMarker(score.measures.indexOf(measure), document.getElementById('marker-select').value);
});

// --- 移調(音階度数、小節範囲指定可) ---

document.getElementById('btn-transpose').addEventListener('click', () => {
  const from = Math.round(Number(document.getElementById('transpose-from-input').value)) - 1;
  const to = Math.round(Number(document.getElementById('transpose-to-input').value)) - 1;
  const steps = Math.round(Number(document.getElementById('transpose-steps-input').value)) || 0;
  if (from < 0 || to >= score.measures.length || from > to) {
    setStatus('小節範囲が正しくありません');
    return;
  }
  if (steps === 0) { setStatus('度数を入力してください'); return; }
  // Transposing moves every tone in the region at once. Rather than
  // retargeting incoming links one tone at a time (which would rescan the
  // whole score per note), the moved notes are collected first and every
  // スラー/グリッサンド that lands on one has its stored pitch shifted by the
  // same interval in a single pass afterwards. Without this, transposing a
  // region silently deleted all the slurs and glissandos ending inside it.
  const movedNoteIds = new Set();
  for (let i = from; i <= to; i++) {
    PARTS.forEach((part) => {
      score.measures[i][part].forEach((n) => {
        if (n.isRest) return;
        movedNoteIds.add(n.id);
        n.keys.forEach((tone) => { tone.key = transposeKey(tone.key, steps); });
      });
    });
  }
  retargetLinksAfterTranspose(
    score, PARTS, movedNoteIds, (pk) => pitchKeyOf(transposeKey(pk, steps)),
  );
  pushHistory();
  render();
  setStatus(`${from + 1}〜${to + 1}小節目を${steps}度移調しました`);
});

// --- 範囲選択(小節単位): コピー・ペースト・音符の削除 ---

// Clamps a possibly-stale range selection (e.g. measures were removed since
// it was made) against the score's current bounds; returns null if nothing
// of the selection remains valid.
function clampedRangeSelection() {
  if (!rangeSelection) return null;
  const { part, measureStart } = rangeSelection;
  const measureEnd = Math.min(rangeSelection.measureEnd, score.measures.length - 1);
  if (measureStart > measureEnd) return null;
  return { part, measureStart, measureEnd };
}

function doRangeCopy() {
  const range = clampedRangeSelection();
  if (!range) { setStatus('範囲を選択してください(譜面をドラッグ)'); return; }
  const { part, measureStart, measureEnd } = range;
  const measures = [];
  for (let i = measureStart; i <= measureEnd; i++) {
    measures.push(structuredClone(score.measures[i][part]));
  }
  clipboard = { part, measures };
  setStatus(`${measureStart + 1}〜${measureEnd + 1}小節目をコピーしました`);
}

function doRangeDelete() {
  const range = clampedRangeSelection();
  if (!range) { setStatus('範囲を選択してください(譜面をドラッグ)'); return; }
  const { part, measureStart, measureEnd } = range;
  for (let i = measureStart; i <= measureEnd; i++) {
    score.measures[i][part] = [];
  }
  pushHistory();
  render();
  setStatus('音符を削除しました');
}

function doRangePaste(targetStartOverride) {
  if (!clipboard) { setStatus('先にコピーしてください'); return; }
  const targetStart = targetStartOverride !== undefined
    ? targetStartOverride
    : Math.round(Number(document.getElementById('paste-target-input').value)) - 1;
  if (targetStart < 0) { setStatus('貼付先の小節番号が正しくありません'); return; }
  while (score.measures.length < targetStart + clipboard.measures.length) {
    score.measures.push(createEmptyMeasure());
  }
  // This paste *replaces* each target measure's contents, so what has to fit
  // is the copied measure's own total against the target's capacity — which
  // can differ (pasting an ordinary measure onto the shorter pickup measure).
  const tooLong = clipboard.measures.findIndex((notes, offset) => {
    const beats = notes.reduce((sum, n) => sum + noteBeats(n), 0);
    return beats > measureCapacity(score, targetStart + offset) + 1e-6;
  });
  if (tooLong !== -1) {
    reportMeasureFull(targetStart + tooLong);
    return;
  }
  // Cloned as one flat batch rather than measure by measure, so that a
  // タイ/スラー/グリッサンド running *between* two copied measures is rewritten
  // to point at the copies instead of at the notes it was copied from.
  const flatClones = cloneNotesWithFreshIds(clipboard.measures.flat());
  let cursor = 0;
  clipboard.measures.forEach((notes, offset) => {
    const targetIndex = targetStart + offset;
    score.measures[targetIndex][clipboard.part] = flatClones.slice(cursor, cursor + notes.length);
    cursor += notes.length;
  });
  pushHistory();
  render();
  setStatus('ペーストしました');
}

function showRangeContextMenu(clientX, clientY, region, localX) {
  const items = [
    { label: 'コピー', onClick: doRangeCopy },
    { label: 'ペースト', onClick: () => doRangePaste(rangeSelection ? rangeSelection.measureStart : undefined) },
    { label: '音符の削除', onClick: doRangeDelete },
  ];
  // A note-level clipboard (see copySelectedNotes) pastes at the exact mouse
  // position within this measure, distinct from the measure-range paste
  // above (which always pastes whole measures starting at 対象小節).
  if (noteClipboard && noteClipboard.length && region) {
    items.push({ separator: true });
    items.push({
      label: `音符をペースト(${noteClipboard.length}個、クリック位置に挿入)`,
      onClick: () => pasteNotesAtPosition(region, localX),
    });
  }
  showContextMenu(clientX, clientY, items);
}

// ---------- 音符単位の範囲選択: 右クリック→コピー/削除、空白右クリック→ペースト ----------
//
// Distinct from the measure-range system above (which operates on whole
// measures via rangeSelection/clipboard) — this one operates on the specific
// selected note(s) (see noteRangeSelection), chord-as-one-unit, and pastes at
// the exact position the user right-clicks rather than at 対象小節.

// Whichever note-level selection is currently active: the horizontal-drag
// range if it has grown to 2+ notes, otherwise just the single `selected`
// note (so right-clicking a lone selected note still offers copy/delete).
function getActiveNoteSelectionRefs() {
  if (noteRangeSelection && noteRangeSelection.length >= 2) return noteRangeSelection;
  if (selected) return [{ measureIndex: selected.measureIndex, part: selected.part, noteId: selected.noteId }];
  return [];
}

function copySelectedNotes() {
  const refs = getActiveNoteSelectionRefs();
  if (!refs.length) return;
  noteClipboard = refs
    .map((r) => score.measures[r.measureIndex][r.part].find((n) => n.id === r.noteId))
    .filter(Boolean)
    .map((n) => structuredClone(n));
  setStatus(`${noteClipboard.length}個の音符をコピーしました`);
}

function deleteSelectedNoteRange() {
  const refs = getActiveNoteSelectionRefs();
  if (!refs.length) return;
  refs.forEach((r) => {
    const measure = score.measures[r.measureIndex];
    clearSlursTargeting(r.noteId);
    measure[r.part] = measure[r.part].filter((n) => n.id !== r.noteId);
  });
  noteRangeSelection = null;
  selected = null;
  pushHistory();
  render();
  syncNoteControlsFromSelection();
  setStatus('選択した音符を削除しました');
}

// Inserts a deep copy of noteClipboard's notes into `region`'s measure/part
// at whichever index localX lands closest to (same left-to-right insertion
// logic as insertNote). Refused outright if the measure has no room, like any
// other insertion.
function pasteNotesAtPosition(region, localX) {
  if (!noteClipboard || !noteClipboard.length) { setStatus('コピーした音符がありません'); return; }
  const measure = score.measures[region.measureIndex];
  const insertIndex = findInsertIndex(region, localX);
  const clones = cloneNotesWithFreshIds(noteClipboard);
  const addedBeats = clones.reduce((sum, n) => sum + noteBeats(n), 0);
  if (!fitsInMeasure(region.measureIndex, region.part, addedBeats)) {
    reportMeasureFull(region.measureIndex);
    return;
  }
  measure[region.part].splice(insertIndex, 0, ...clones);
  pushHistory();
  render();
  setStatus(`${clones.length}個の音符をペーストしました`);
}

const DYNAMIC_OPTIONS = ['', 'pp', 'p', 'mp', 'mf', 'f', 'ff'];
const HAIRPIN_OPTIONS = [
  { value: 'cresc-start', label: 'クレッシェンド開始' },
  { value: 'cresc-end', label: 'クレッシェンド終了' },
  { value: 'decresc-start', label: 'デクレッシェンド開始' },
  { value: 'decresc-end', label: 'デクレッシェンド終了' },
];
const ARTICULATION_OPTIONS = [
  { value: '', label: 'なし' },
  { value: 'staccato', label: 'スタッカート' },
  { value: 'staccatissimo', label: 'スタッカーティッシモ' },
  { value: 'tenuto', label: 'テヌート' },
  { value: 'accent', label: 'アクセント' },
  { value: 'marcato', label: 'マルカート' },
  { value: 'fermata', label: 'フェルマータ' },
  { value: 'trill', label: 'トリル' },
  { value: 'turn', label: 'ターン' },
  { value: 'mordent', label: 'モルデント' },
  { value: 'arpeggio', label: 'アルペジオ' },
];

// Builds the 強弱記号/クレッシェンド・デクレッシェンド/アーティキュレーション/
// リハーサル記号/レジストレーション submenus for a single selected note's
// right-click menu (メニュー＞カテゴリ＞値, see openSubmenuFor) — an
// alternative to the ribbon's 記号 tab for setting the same attributes
// without leaving the score. Only meaningful for exactly one selected note,
// not a multi-note range (see showNoteRangeContextMenu's refs.length check).
function noteAttributeSubmenus() {
  const note = getSelectedNote();
  if (!note) return [];
  const mark = getMarkForSelectedNote();
  return [
    {
      label: '強弱記号',
      submenu: DYNAMIC_OPTIONS.map((v) => ({
        label: v || 'なし',
        active: (note.dynamic || '') === v,
        onClick: () => withSelectedNote((n) => { n.dynamic = v; }),
      })),
    },
    {
      label: 'クレッシェンド・デクレッシェンド',
      submenu: HAIRPIN_OPTIONS.map((opt) => ({
        label: opt.label,
        active: note.hairpin === opt.value,
        onClick: () => withSelectedNote((n) => {
          n.hairpin = n.hairpin === opt.value ? null : opt.value;
        }),
      })),
    },
    {
      label: 'アーティキュレーション',
      submenu: ARTICULATION_OPTIONS.map((opt) => ({
        label: opt.label,
        active: (note.articulation || '') === opt.value,
        onClick: () => withSelectedNote((n) => { n.articulation = opt.value; }),
      })),
    },
    {
      label: 'リハーサル記号',
      submenu: REHEARSAL_OPTIONS.map((v) => ({
        label: v || 'なし',
        active: (mark ? mark.rehearsal || '' : '') === v,
        onClick: () => setMarkForSelectedNote('rehearsal', v),
      })),
    },
    {
      label: 'レジストレーション',
      submenu: REGISTRATION_OPTIONS.map((v) => ({
        label: v || 'なし',
        active: (mark ? mark.registration || '' : '') === v,
        onClick: () => setMarkForSelectedNote('registration', v),
      })),
    },
  ];
}

// Removes the N連符 grouping from whichever tuplet(s) the given notes belong
// to — the whole group at once, since a tuplet is only meaningful as a set.
// Until this existed there was no way to undo a 連符 short of deleting the
// notes and placing them again.
function clearTupletForNotes(refs) {
  const tupletIds = new Set();
  refs.forEach((r) => {
    const measure = score.measures[r.measureIndex];
    const note = measure && (measure[r.part] || []).find((n) => n.id === r.noteId);
    if (note && note.tupletId) tupletIds.add(note.tupletId);
  });
  if (tupletIds.size === 0) { setStatus('連符になっている音符を選択してください'); return; }
  // Ungrouping restores each note's full written duration (a triplet eighth
  // goes from 1/3 to 1/2 of a beat), so a measure that was exactly full as a
  // tuplet no longer fits. Check every affected measure before changing
  // anything, so the operation either applies completely or not at all.
  const growth = new Map(); // "measureIndex|part" -> extra beats
  score.measures.forEach((measure, measureIndex) => {
    PARTS.forEach((part) => {
      (measure[part] || []).forEach((n) => {
        if (!n.tupletId || !tupletIds.has(n.tupletId)) return;
        const extra = durationBeats(n.duration, n.dotted, 1) - noteBeats(n);
        const key = `${measureIndex}|${part}`;
        growth.set(key, (growth.get(key) || 0) + extra);
      });
    });
  });
  const overfull = [...growth.entries()].find(([key, extra]) => {
    const [measureIndex, part] = key.split('|');
    return !fitsInMeasure(Number(measureIndex), part, extra);
  });
  if (overfull) {
    setStatus(`${Number(overfull[0].split('|')[0]) + 1}小節目に入りきらないため、連符を解除できません`);
    return;
  }

  const touched = [];
  score.measures.forEach((measure, measureIndex) => {
    PARTS.forEach((part) => {
      let changed = false;
      (measure[part] || []).forEach((n) => {
        if (!n.tupletId || !tupletIds.has(n.tupletId)) return;
        n.tupletId = null;
        n.tupletCount = null;
        changed = true;
      });
      if (changed) touched.push({ measureIndex, part });
    });
  });
  multiSelected = [];
  pushHistory();
  render();
  setStatus('連符を解除しました');
}

// True when at least one of the given notes is part of a tuplet — used to
// show the 解除 menu item only where it would actually do something.
function refsIncludeTuplet(refs) {
  return refs.some((r) => {
    const measure = score.measures[r.measureIndex];
    const note = measure && (measure[r.part] || []).find((n) => n.id === r.noteId);
    return !!(note && note.tupletId);
  });
}

function showNoteRangeContextMenu(clientX, clientY) {
  const refs = getActiveNoteSelectionRefs();
  const attributeSubmenus = refs.length === 1 ? noteAttributeSubmenus() : [];
  showContextMenu(clientX, clientY, [
    { header: `${refs.length}個の音符を選択中` },
    { label: 'コピー', onClick: copySelectedNotes },
    { label: '削除', onClick: deleteSelectedNoteRange },
    ...(refsIncludeTuplet(refs)
      ? [{ label: '連符を解除', onClick: () => clearTupletForNotes(refs) }]
      : []),
    ...(attributeSubmenus.length ? [{ separator: true }, ...attributeSubmenus] : []),
    { separator: true },
    {
      label: '選択解除',
      onClick: () => { noteRangeSelection = null; selected = null; render(); },
    },
  ]);
}

// ---------- Ctrl/Cmd+click multi-selection: right-click → タイ/スラー/連符 ----------
//
// Chord tie/slur through the single-selection タイ/スラー buttons (see
// applyTieToSelectedTone / toggleSlurFromSelectedTone) only ever connects a
// tone to "the next" note. For picking exactly which notes something applies
// to — e.g. two specific notes buried in different chords — Ctrl/Cmd+click
// each one (Office-style) and right-click the selection instead.

// Reading order for a multi-selection: by measure, then by part (in the
// upper→lower→pedal order the score itself is laid out in), then by that
// note's position within its part. Good enough to make "first" and "last"
// well-defined for タイ/スラー/連符 without needing real musical time.
function sortMultiSelected(items) {
  return [...items].sort((a, b) => {
    if (a.measureIndex !== b.measureIndex) return a.measureIndex - b.measureIndex;
    if (a.part !== b.part) return PARTS.indexOf(a.part) - PARTS.indexOf(b.part);
    const measure = score.measures[a.measureIndex];
    const ai = measure[a.part].findIndex((n) => n.id === a.noteId);
    const bi = measure[b.part].findIndex((n) => n.id === b.noteId);
    return ai - bi;
  });
}

function resolveMultiSelectedTone(item) {
  const measure = score.measures[item.measureIndex];
  const note = measure && measure[item.part].find((n) => n.id === item.noteId);
  if (!note || note.isRest) return null;
  const tone = note.keys[item.keyIndex];
  if (!tone) return null;
  return { note, tone };
}

// Ties each consecutive pair (in reading order) that share a part and pitch.
// A pair that doesn't (different part, different pitch, or a rest in the
// way) is just skipped rather than blocking the rest of the selection.
function applyMultiTie() {
  const sorted = sortMultiSelected(multiSelected);
  let applied = 0;
  let skipped = 0;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const ra = resolveMultiSelectedTone(a);
    const rb = resolveMultiSelectedTone(b);
    if (a.part !== b.part || !ra || !rb || pitchKeyOf(ra.tone.key) !== pitchKeyOf(rb.tone.key)) {
      skipped += 1;
      continue;
    }
    ra.tone.tieToNext = true;
    applied += 1;
  }
  multiSelected = [];
  pushHistory();
  render();
  setStatus(`タイを${applied}箇所つけました${skipped ? `(高さが違う${skipped}箇所はスキップしました)` : ''}`);
}

// Slurs from the first selected note to the last (reading order) — a slur
// spans a passage rather than pairing up notes like タイ does, and unlike a
// tie it doesn't need matching pitches.
function applyMultiSlur() {
  const sorted = sortMultiSelected(multiSelected);
  if (sorted.length < 2) { setStatus('スラーには2つ以上の音符を選択してください'); return; }
  const start = resolveMultiSelectedTone(sorted[0]);
  const end = resolveMultiSelectedTone(sorted[sorted.length - 1]);
  if (!start || !end) { setStatus('休符にはスラーをつけられません'); return; }
  start.tone.slurTo = { noteId: sorted[sorted.length - 1].noteId, pitchKey: pitchKeyOf(end.tone.key) };
  multiSelected = [];
  pushHistory();
  render();
  setStatus('スラーをつけました');
}

// Same shape as applyMultiSlur, but for グリッサンド (see toggleGlissandoFromSelectedTone).
function applyMultiGlissando() {
  const sorted = sortMultiSelected(multiSelected);
  if (sorted.length < 2) { setStatus('グリッサンドには2つ以上の音符を選択してください'); return; }
  const start = resolveMultiSelectedTone(sorted[0]);
  const end = resolveMultiSelectedTone(sorted[sorted.length - 1]);
  if (!start || !end) { setStatus('休符にはグリッサンドをつけられません'); return; }
  start.tone.glissandoTo = { noteId: sorted[sorted.length - 1].noteId, pitchKey: pitchKeyOf(end.tone.key) };
  multiSelected = [];
  pushHistory();
  render();
  setStatus('グリッサンドをつけました');
}

// Groups the selection into an N連符 — they must all be the same part, the
// same measure, and consecutive there (a tuplet is a rhythmic regrouping of
// back-to-back notes, not an arbitrary set).
function applyMultiTuplet(count) {
  const sorted = sortMultiSelected(multiSelected);
  if (sorted.length !== count) { setStatus(`${count}連符にする音符を${count}個選択してください`); return; }
  const { part, measureIndex } = sorted[0];
  if (!sorted.every((s) => s.part === part && s.measureIndex === measureIndex)) {
    setStatus('連符は同じ小節・同じ段の音符を選択してください');
    return;
  }
  const measure = score.measures[measureIndex];
  const indices = sorted.map((s) => measure[part].findIndex((n) => n.id === s.noteId)).sort((a, b) => a - b);
  const contiguous = indices.every((idx, i) => i === 0 || idx === indices[i - 1] + 1);
  if (!contiguous) { setStatus('連符にする音符は連続している必要があります'); return; }
  const tupletId = makeNoteId();
  sorted.forEach((s) => {
    const note = measure[s.part].find((n) => n.id === s.noteId);
    if (note) { note.tupletId = tupletId; note.tupletCount = count; }
  });
  multiSelected = [];
  pushHistory();
  render();
  setStatus(`${count}連符にしました`);
}

function showMultiSelectContextMenu(clientX, clientY) {
  showContextMenu(clientX, clientY, [
    { header: `${multiSelected.length}個選択中` },
    { label: 'タイ', onClick: applyMultiTie },
    { label: 'スラー', onClick: applyMultiSlur },
    { label: 'グリッサンド', onClick: applyMultiGlissando },
    { label: '3連符', onClick: () => applyMultiTuplet(3) },
    { label: '5連符', onClick: () => applyMultiTuplet(5) },
    { label: '7連符', onClick: () => applyMultiTuplet(7) },
    ...(refsIncludeTuplet(multiSelected)
      ? [{ label: '連符を解除', onClick: () => clearTupletForNotes([...multiSelected]) }]
      : []),
    { separator: true },
    { label: '選択解除', onClick: () => { multiSelected = []; render(); } },
  ]);
}

document.getElementById('btn-range-copy').addEventListener('click', doRangeCopy);
document.getElementById('btn-range-delete').addEventListener('click', doRangeDelete);

// n番括弧 (see drawVoltaBrackets in staffRenderer.js) — one bracket covers
// exactly one measure and is set on a single 対象小節, the same way 小節線 /
// リピート / マーカー are. A bracket applies to the whole system rather than
// one staff, so it lives on the measure itself and has no `part`.
function setVolta(measureIndex, number) {
  const measure = score.measures[measureIndex];
  if (!measure) return;
  measure.volta = number ? { number } : null;
  pushHistory();
  render();
}

document.getElementById('btn-volta-apply').addEventListener('click', () => {
  const measure = targetMeasure();
  if (!measure) return;
  const number = Number(document.getElementById('volta-number-select').value);
  setVolta(score.measures.indexOf(measure), number);
});
document.getElementById('btn-volta-clear').addEventListener('click', () => {
  const measure = targetMeasure();
  if (!measure) return;
  setVolta(score.measures.indexOf(measure), null);
});
document.getElementById('btn-range-paste').addEventListener('click', () => doRangePaste());

// --- テンプレート(空フォーマットのみ)の保存/読み込み ---

document.getElementById('btn-save-template').addEventListener('click', () => {
  const template = {
    type: 'electone-template',
    timeSig: score.timeSig,
    keySignature: score.keySignature || 'C',
    pickupBeats: score.pickupBeats || 0,
    measureCount: score.measures.length,
    clefs: { ...score.clefs },
  };
  download('template.json', [JSON.stringify(template, null, 2)], 'application/json');
});

const templateInput = document.getElementById('template-input');
document.getElementById('btn-load-template').addEventListener('click', () => templateInput.click());
templateInput.addEventListener('change', async () => {
  const file = templateInput.files[0];
  templateInput.value = '';
  if (!file) return;
  if (!(await confirmDiscardUnsaved('新規作成'))) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const tpl = JSON.parse(reader.result);
      const count = Math.max(1, Math.round(tpl.measureCount) || 1);
      // Built from createEmptyScore() and then overridden, NOT assembled as a
      // fresh object literal: a template only carries the handful of fields
      // below, and a score built from just those is missing everything else
      // the app reads unconditionally (instruments, shapes, the title/composer
      // font styles, measureWidthScale, …). syncControlsFromScore() reaches
      // straight into score.instruments[part] and threw on the very next line.
      score = {
        ...createEmptyScore(),
        timeSig: tpl.timeSig && isValidTimeSig(tpl.timeSig) ? tpl.timeSig : '4/4',
        keySignature: tpl.keySignature || 'C',
        pickupBeats: Number(tpl.pickupBeats) || 0,
        clefs: { ...PART_CLEF, ...(tpl.clefs || {}) },
        measures: Array.from({ length: count }, () => createEmptyMeasure()),
      };
      history = [structuredClone(score)];
      historyIndex = 0;
      savedHistoryIndex = 0;
      selected = null;
      rangeSelection = null;
      selectedMeasureIndex = null;
      syncControlsFromScore();
      render();
      setStatus('テンプレートから作成しました');
    } catch (err) {
      setStatus('テンプレートの読み込みに失敗しました');
    }
  };
  reader.readAsText(file);
});

updateRangeLabel();
updateWidthSliderUI();
render();

// --- 終了時の保存確認 ---
// main.js intercepts the window's close button and sends 'close-requested'
// instead of closing immediately, since only the renderer knows whether
// there are unsaved edits (see savedHistoryIndex above).
const closeConfirmModalEl = document.getElementById('close-confirm-modal');
const closeConfirmSaveBtn = document.getElementById('close-confirm-save');
const closeConfirmDiscardBtn = document.getElementById('close-confirm-discard');
const closeConfirmCancelBtn = document.getElementById('close-confirm-cancel');

function showCloseConfirmModal() {
  return new Promise((resolve) => {
    closeConfirmModalEl.hidden = false;
    const cleanup = () => {
      closeConfirmModalEl.hidden = true;
      closeConfirmSaveBtn.removeEventListener('click', onSave);
      closeConfirmDiscardBtn.removeEventListener('click', onDiscard);
      closeConfirmCancelBtn.removeEventListener('click', onCancel);
    };
    const onSave = () => { cleanup(); resolve('save'); };
    const onDiscard = () => { cleanup(); resolve('discard'); };
    const onCancel = () => { cleanup(); resolve('cancel'); };
    closeConfirmSaveBtn.addEventListener('click', onSave);
    closeConfirmDiscardBtn.addEventListener('click', onDiscard);
    closeConfirmCancelBtn.addEventListener('click', onCancel);
  });
}

if (window.electronAPI && window.electronAPI.onCloseRequested) {
  window.electronAPI.onCloseRequested(async () => {
    if (historyIndex === savedHistoryIndex) {
      window.electronAPI.respondClose('close');
      return;
    }
    const action = await showCloseConfirmModal();
    if (action === 'cancel') return;
    if (action === 'save') {
      saveScoreFile();
      // Give the Blob-download a moment to actually start before the
      // renderer (and its Blob URL) gets torn down by window.close().
      await new Promise((resolve) => { setTimeout(resolve, 400); });
    }
    window.electronAPI.respondClose('close');
  });
}

