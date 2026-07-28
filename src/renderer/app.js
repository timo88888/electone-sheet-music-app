import {
  PARTS, CLEF_OPTIONS, CLEF_LABELS, KEY_SIGNATURES, CHORD_ROOTS, CHORD_QUALITY_OPTIONS,
  TEMPO_NOTE_VALUES, TEMPO_NOTE_GLYPHS, DURATION_LABELS, effectiveQuarterBpm,
  detectChordCandidates, chordPitchClassesForLowerNote,
  REHEARSAL_OPTIONS, REGISTRATION_OPTIONS,
  createEmptyScore, createEmptyMeasure, makeNoteId, noteAnnotationDefaults,
  durationBeats, beatsPerMeasure, measureCapacity, isValidTimeSig,
  tupletNotesOccupied, noteBeats, noteBeatWindow,
} from './scoreModel.js';
import { renderScore, LAYOUT } from './staffRenderer.js';
import {
  pitchForIndex, indexForY, transposeKey, parseKey, buildKey,
} from './pitchMap.js';
import {
  Player, renderScoreToWavBuffer, buildPlaybackEvents, PLAYBACK_LEAD,
} from './playback.js';
import { buildMidiFile } from './midiExport.js';

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
          n.keys = n.keys.map((k) => ({ key: k, tieToNext: !!n.tieToNext, slurTo: null }));
          delete n.tieToNext;
          delete n.slur;
        } else {
          (n.keys || []).forEach((tone) => {
            if (tone.slurTo === undefined) tone.slurTo = null;
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
  if (!loaded.measureWidthScale) loaded.measureWidthScale = 1;
  return loaded;
}

let score = createEmptyScore();
let history = [structuredClone(score)];
let historyIndex = 0;

let selectedDuration = 'q';
let selectedDotted = false;
let selectedRest = false;
let selectedAccidental = ''; // '' (unspecified), '#', 'b', or 'n' (explicit natural)

let zoom = 1;
let selected = null; // { measureIndex, part, noteId, keyIndex } — keyIndex picks one tone within a chord
let hitMap = [];
let annotationHitMap = [];
let markHitMap = [];
let dragging = null;
let rangeDragging = null; // { part, page, startMeasure, endMeasure }
let rangeSelection = null; // { part, measureStart, measureEnd }
let clipboard = null; // { part, measures: [[note,...], ...] }
let pendingClick = null; // { pageIndex, region, startClientX, startClientY, localY }
let selectedLink = null; // null | 'tuplet3' | 'tuplet5' | 'tuplet7' — see insertNote
let pendingSlurStart = null; // { measureIndex, part, noteId, keyIndex } | null — see toggleSlurFromSelectedTone
let multiSelected = []; // { measureIndex, part, noteId, keyIndex }[] — Ctrl/Cmd+click, see showMultiSelectContextMenu
let selectedMeasureIndex = null;
let highlightTimers = [];
let highlightEls = [];
const DRAG_THRESHOLD = 6;

const player = new Player();

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

function pushHistory() {
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

function render() {
  markSelection();
  recomputeAutoChords();
  const result = renderScore(scoreContainer, score, LAYOUT);
  hitMap = result.hitMap;
  annotationHitMap = result.annotationHitMap;
  markHitMap = result.markHitMap;
  attachPageHandlers(result.pages);
  scoreContainer.style.transform = `scale(${zoom})`;
  updateMeasureCount();
  renderRangeHighlight(result.pages);
  renderMeasureNumbers(result.pages);
  renderTitleHeader(result.pages);
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
  updateWidthSliderUI();
  PARTS.forEach((part) => {
    const select = document.getElementById(`clef-${part}`);
    if (select) select.value = score.clefs[part];
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

  note.keys.push({ key, tieToNext: false, slurTo: null });
  sortNoteKeys(note);
  const keyIndex = note.keys.findIndex((t) => t.key === key);
  selected = {
    measureIndex: region.measureIndex, part: region.part, noteId: note.id, keyIndex,
  };

  pushHistory();
  render();
  syncNoteControlsFromSelection();
  setStatus('和音に音を追加しました');
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

function attachPageHandlers(pages) {
  pages.forEach((pageDiv, pageIndex) => {
    pageDiv.addEventListener('mousedown', (e) => onPageMouseDown(e, pageDiv, pageIndex));
    pageDiv.addEventListener('contextmenu', (e) => onPageContextMenu(e, pageDiv, pageIndex));
  });
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
      && y >= r.topY - 45 && y <= r.topY + 85,
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
      && y >= r.topY - 45 && y <= r.topY + 85,
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
  tempoGlyph.textContent = TEMPO_NOTE_GLYPHS[score.bpmNoteValue] || TEMPO_NOTE_GLYPHS.q;
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

function hideContextMenu() {
  contextMenuEl.hidden = true;
  contextMenuEl.innerHTML = '';
}

function showContextMenu(clientX, clientY, items) {
  contextMenuEl.innerHTML = '';
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
      row.addEventListener('click', () => {
        hideContextMenu();
        item.onClick();
      });
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
  if (!contextMenuEl.hidden && !contextMenuEl.contains(e.target)) hideContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideContextMenu();
    if (pendingSlurStart) {
      pendingSlurStart = null;
      setStatus('スラーを取り消しました');
    }
  }
});

function onPageMouseDown(e, pageDiv, pageIndex) {
  if (e.button !== 0) return;
  const { x, y } = toLocalCoords(pageDiv, e.clientX, e.clientY);

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
    dragging = {
      region, note: existing.noteRef, keyIndex: existing.keyIndex, wasRest: existing.noteRef.isRest,
      startClientX: e.clientX, startClientY: e.clientY, moved: false,
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
  showRangeContextMenu(e.clientX, e.clientY);
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
  if (!dragging) return;
  if (!dragging.moved) {
    const dx = e.clientX - dragging.startClientX;
    const dy = e.clientY - dragging.startClientY;
    if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
    dragging.moved = true;
  }
  const pageDiv = dragging.region.page !== undefined
    ? scoreContainer.querySelectorAll('.score-page')[dragging.region.page]
    : null;
  if (!pageDiv) return;
  const { y } = toLocalCoords(pageDiv, e.clientX, e.clientY);
  const index = indexForY(y, dragging.region.topY, dragging.region.step);
  const baseKey = pitchForIndex(dragging.region.clef, index);
  const { letter, octave } = parseKey(baseKey);
  const tone = dragging.note.keys[dragging.keyIndex];
  const existingAccidental = parseKey(tone.key).accidental;
  const key = buildKey(letter, existingAccidental, octave);
  if (tone.key !== key) {
    tone.key = key;
    render();
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
    let changed = false;
    if (dragging.wasRest && dragging.note.isRest) {
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
});

// Clicking the blank margin around the pages (not on any page itself) also
// clears the range selection.
document.querySelector('.score-scroll').addEventListener('mousedown', (e) => {
  if (e.target.closest('.score-page')) return;
  clearRangeSelection();
  clearMeasureSelection();
  clearSelection();
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
// from the end can ripple forward through several measures. This is what
// makes a measure's declared capacity a soft wrapping point rather than a
// hard limit, same as inserting a note mid-measure in mainstream notation
// software (Finale, Sibelius, Dorico, MuseScore) reflows everything after it
// instead of simply refusing the insertion.
function cascadeOverflow(startMeasureIndex, part) {
  let idx = startMeasureIndex;
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
    if (splitAt === -1) return;
    const overflow = notes.splice(splitAt);
    if (idx + 1 >= score.measures.length) score.measures.push(createEmptyMeasure());
    score.measures[idx + 1][part] = overflow.concat(score.measures[idx + 1][part]);
    idx += 1;
  }
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
    keys: [{ key, tieToNext: false, slurTo: null }],
    duration: selectedDuration,
    dotted: selectedDotted,
    isRest: selectedRest,
    selected: false,
    dynamic: '',
    hairpin: null,
    lyric: '',
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
    setSelectedLink(null);
  }

  measure[region.part].splice(insertIndex, 0, ...notesToInsert);
  cascadeOverflow(region.measureIndex, region.part);

  pushHistory();
  render();
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

// A note being deleted might be the target of another tone's スラー
// elsewhere in the score (slurs are explicit links, not position-based) —
// clear any that point at it so they don't linger as dangling references.
function clearSlursTargeting(noteId) {
  score.measures.forEach((m) => {
    PARTS.forEach((part) => {
      m[part].forEach((n) => {
        n.keys.forEach((t) => {
          if (t.slurTo && t.slurTo.noteId === noteId) t.slurTo = null;
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

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
    e.preventDefault();
    deleteSelected();
  } else if (e.ctrlKey && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
    e.preventDefault();
    redo();
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

// Same-staff-position identity (letter+octave, ignoring accidental) for a
// slur's stored target — must match staffRenderer.js's pitchId() format
// exactly, since that's what resolves this link back into a specific tone
// at render time.
function pitchKeyOf(key) {
  const { letter, octave } = parseKey(key);
  return `${letter.toLowerCase()}/${octave}`;
}

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
    const newNote = {
      id: makeNoteId(),
      keys: [{ key: tone.key, tieToNext: false, slurTo: null }],
      duration: selectedDuration,
      dotted: selectedDotted,
      isRest: false,
      // If the selected note is a chord, this new note only concerns this
      // one tone — `partialChordNote` marks it so it doesn't cut off any of
      // the chord's *other* tones' ties in flight (see its use in
      // playback.js); it briefly means this beat and the chord's other real
      // continuation note overlap in the written rhythm, but that's
      // preferable to silently dropping a tie.
      partialChordNote: note.keys.length > 1,
      selected: false,
      dynamic: '',
      hairpin: null,
      lyric: '',
      articulation: '',
      tupletId: null,
      tupletCount: null,
      ...noteAnnotationDefaults(),
    };
    // No matching pitch right after this note — insert one automatically
    // (same pitch, current ribbon duration), tied, instead of requiring the
    // user to type it themselves first. cascadeOverflow pushes it (and
    // whatever it displaces) into the next measure if this one is already
    // full, creating one at the end of the score if needed — same as how a
    // real tied note would be written across the barline.
    siblings.splice(noteIdx + 1, 0, newNote);
    cascadeOverflow(selected.measureIndex, selected.part);
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

document.querySelectorAll('[data-tone-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.toneAction === 'tie') applyTieToSelectedTone();
    else if (btn.dataset.toneAction === 'slur') toggleSlurFromSelectedTone();
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

document.getElementById('btn-add-measure').addEventListener('click', () => {
  score.measures.push(createEmptyMeasure());
  pushHistory();
  render();
});

document.getElementById('btn-remove-measure').addEventListener('click', () => {
  if (score.measures.length <= 1) {
    setStatus('これ以上削除できません');
    return;
  }
  const last = score.measures[score.measures.length - 1];
  const isEmpty = PARTS.every((p) => last[p].length === 0);
  const doRemove = () => {
    score.measures.pop();
    pushHistory();
    render();
  };
  if (isEmpty) { doRemove(); return; }
  showConfirmModal('最後の小節には音符があります。削除しますか?').then((ok) => { if (ok) doRemove(); });
});

document.getElementById('btn-zoom-in').addEventListener('click', () => {
  zoom = Math.min(2, zoom + 0.1);
  render();
});
document.getElementById('btn-zoom-out').addEventListener('click', () => {
  zoom = Math.max(0.5, zoom - 0.1);
  render();
});

const bpmInput = document.getElementById('bpm-input');
const bpmNoteSelect = document.getElementById('bpm-note-select');
TEMPO_NOTE_VALUES.forEach((value) => {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = `${TEMPO_NOTE_GLYPHS[value]}(${DURATION_LABELS[value]})`;
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
function schedulePlaybackHighlights() {
  const events = buildPlaybackEvents(score, effectiveQuarterBpm(score));
  events.forEach((ev) => {
    if (!ev.ids || ev.ids.length === 0) return;
    const targets = ev.ids.map((id) => findNoteHitById(id)).filter(Boolean);
    if (targets.length === 0) return;
    const shownEls = [];
    const onTimer = setTimeout(() => {
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
    }, (ev.time + PLAYBACK_LEAD) * 1000);
    const offTimer = setTimeout(() => {
      shownEls.forEach((el) => el.remove());
      highlightEls = highlightEls.filter((el) => !shownEls.includes(el));
    }, (ev.time + ev.duration + PLAYBACK_LEAD) * 1000);
    highlightTimers.push(onTimer, offTimer);
  });
}

const playBtn = document.getElementById('btn-play');
playBtn.addEventListener('click', () => {
  if (player.playing) {
    player.stop();
    clearPlaybackHighlights();
    playBtn.classList.remove('active');
    return;
  }
  playBtn.classList.add('active');
  clearPlaybackHighlights();
  schedulePlaybackHighlights();
  player.play(score, effectiveQuarterBpm(score), () => {
    playBtn.classList.remove('active');
    clearPlaybackHighlights();
  });
});

document.getElementById('btn-print').addEventListener('click', () => {
  window.print();
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

document.getElementById('btn-save').addEventListener('click', () => {
  download(`${score.title || 'score'}.json`, [JSON.stringify(score, null, 2)], 'application/json');
});

const openInput = document.getElementById('open-input');
document.getElementById('btn-open').addEventListener('click', () => openInput.click());
openInput.addEventListener('change', () => {
  const file = openInput.files[0];
  if (!file) return;
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
  openInput.value = '';
});

document.getElementById('btn-export-midi').addEventListener('click', () => {
  const buffer = buildMidiFile(score, effectiveQuarterBpm(score));
  download(`${score.title || 'score'}.mid`, [buffer], 'audio/midi');
});

document.getElementById('btn-export-wav').addEventListener('click', async () => {
  setStatus('音声を書き出し中...');
  const buffer = await renderScoreToWavBuffer(score, effectiveQuarterBpm(score));
  download(`${score.title || 'score'}.wav`, [buffer], 'audio/wav');
  setStatus('書き出しました');
});

const titleInput = document.getElementById('title-input');
titleInput.value = score.title;
titleInput.addEventListener('change', () => {
  score.title = titleInput.value || '無題の楽譜';
  pushHistory();
});

// --- 拍子記号 ---

const timeSigInput = document.getElementById('timesig-input');
timeSigInput.value = score.timeSig;
document.getElementById('btn-apply-timesig').addEventListener('click', () => {
  const value = timeSigInput.value.trim();
  if (!isValidTimeSig(value)) {
    setStatus('拍子記号の形式が正しくありません(例: 4/4)');
    return;
  }
  score.timeSig = value;
  const full = beatsPerMeasure(score);
  if (score.pickupBeats > full) {
    score.pickupBeats = full;
    pickupInput.value = full;
  }
  pushHistory();
  render();
});

// --- 弱起(ピックアップ小節) ---

const pickupInput = document.getElementById('pickup-input');
pickupInput.value = score.pickupBeats || 0;
pickupInput.addEventListener('change', () => {
  const full = beatsPerMeasure(score);
  const value = Math.max(0, Math.min(full, Number(pickupInput.value) || 0));
  pickupInput.value = value;
  score.pickupBeats = value;
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
  const note = getSelectedNote();
  if (!note) { setStatus('音符を選択してください'); return; }
  showPromptModal('歌詞', note.lyric || '').then((value) => {
    if (value === null) return;
    note.lyric = value;
    pushHistory();
    render();
    syncNoteControlsFromSelection();
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
function setBarlineEnd(measureIndex, value) {
  const measure = score.measures[measureIndex];
  if (!measure) return;
  measure.barlineEnd = value;
  if (value === 'final' && measureIndex < score.measures.length - 1) {
    score.measures.length = measureIndex + 1;
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
  for (let i = from; i <= to; i++) {
    PARTS.forEach((part) => {
      score.measures[i][part].forEach((n) => {
        if (!n.isRest) n.keys.forEach((tone) => { tone.key = transposeKey(tone.key, steps); });
      });
    });
  }
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
  clipboard.measures.forEach((notes, offset) => {
    const targetIndex = targetStart + offset;
    score.measures[targetIndex][clipboard.part] = notes.map((n) => ({ ...structuredClone(n), id: makeNoteId() }));
  });
  pushHistory();
  render();
  setStatus('ペーストしました');
}

function showRangeContextMenu(clientX, clientY) {
  showContextMenu(clientX, clientY, [
    { label: 'コピー', onClick: doRangeCopy },
    { label: 'ペースト', onClick: () => doRangePaste(rangeSelection ? rangeSelection.measureStart : undefined) },
    { label: '音符の削除', onClick: doRangeDelete },
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
    { label: '3連符', onClick: () => applyMultiTuplet(3) },
    { label: '5連符', onClick: () => applyMultiTuplet(5) },
    { label: '7連符', onClick: () => applyMultiTuplet(7) },
    { separator: true },
    { label: '選択解除', onClick: () => { multiSelected = []; render(); } },
  ]);
}

document.getElementById('btn-range-copy').addEventListener('click', doRangeCopy);
document.getElementById('btn-range-delete').addEventListener('click', doRangeDelete);
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
templateInput.addEventListener('change', () => {
  const file = templateInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const tpl = JSON.parse(reader.result);
      const count = Math.max(1, Math.round(tpl.measureCount) || 1);
      score = {
        title: '無題の楽譜',
        composer: '',
        lyricist: '',
        timeSig: tpl.timeSig || '4/4',
        keySignature: tpl.keySignature || 'C',
        pickupBeats: tpl.pickupBeats || 0,
        clefs: tpl.clefs || { upper: 'treble', lower: 'bass', pedal: 'bass' },
        measures: Array.from({ length: count }, () => createEmptyMeasure()),
      };
      history = [structuredClone(score)];
      historyIndex = 0;
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
  templateInput.value = '';
});

updateRangeLabel();
updateWidthSliderUI();
render();

