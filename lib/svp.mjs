// Synthesizer V Studio project (.svp) reader/writer.
//
// .svp is plain JSON (plus a trailing NUL byte that the editor itself writes).
// Musical time is stored in "blicks"; one quarter note is SV.QUARTER = 705600000.
// The schema below reproduces what Synthesizer V Studio 2 (svp version 153)
// writes for a single vocal track, so files produced here open as ordinary
// projects and can be rendered from the GUI.

import { randomUUID } from 'node:crypto';

/** Blicks per quarter note (SV.QUARTER in the scripting API). */
export const QUARTER = 705600000;

/** File format version written by Synthesizer V Studio 2.x. */
export const SVP_VERSION = 153;

const TRACK_COLOR = 'ff7db235';

const PARAMETER_NAMES = [
  'pitchDelta',
  'vibratoEnv',
  'loudness',
  'tension',
  'breathiness',
  'voicing',
  'gender',
  'toneShift',
];

const NOTE_NAMES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Beats (quarter notes) -> blicks. */
export function beatsToBlick(beats) {
  return Math.round(Number(beats) * QUARTER);
}

/** Blicks -> beats (quarter notes). */
export function blickToBeats(blick) {
  return Number(blick) / QUARTER;
}

/**
 * Convert a pitch token to a MIDI note number.
 * Accepts "C4", "c#4", "Db3", "A-1" or a plain number like 60.
 */
export function pitchToMidi(token) {
  if (typeof token === 'number') {
    if (!Number.isFinite(token)) throw new Error(`invalid pitch: ${token}`);
    return Math.round(token);
  }
  const text = String(token).trim();
  if (/^-?\d+$/.test(text)) return Number(text);
  const m = /^([A-Ga-g])([#b]{0,2})(-?\d+)$/.exec(text);
  if (!m) throw new Error(`cannot read pitch "${token}" (use C4, F#3, Bb2 or a MIDI number)`);
  const semitone = NOTE_NAMES[m[1].toUpperCase()];
  let pitch = semitone + (m[3] ? (Number(m[3]) + 1) * 12 : 0);
  for (const accident of m[2]) pitch += accident === '#' ? 1 : -1;
  if (pitch < 0 || pitch > 127) throw new Error(`pitch out of MIDI range: ${token}`);
  return pitch;
}

/** MIDI note number -> "C4" style name (used when summarizing a project). */
export function midiToPitchName(midi) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const value = Math.round(midi);
  return names[((value % 12) + 12) % 12] + (Math.floor(value / 12) - 1);
}

/** Parse "4/4" (or "6/8", or {numerator, denominator}) into meter fields. */
export function parseMeter(meter) {
  if (meter && typeof meter === 'object') {
    const numerator = Number(meter.numerator);
    const denominator = Number(meter.denominator ?? 4);
    if (!(numerator > 0) || !(denominator > 0)) throw new Error('meter must be positive');
    return { numerator, denominator };
  }
  const text = String(meter ?? '4/4').trim();
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(text);
  if (!m) throw new Error(`cannot read meter "${text}" (use 4/4, 3/4, 6/8...)`);
  return { numerator: Number(m[1]), denominator: Number(m[2]) };
}

function emptyParameters() {
  const parameters = {};
  for (const name of PARAMETER_NAMES) parameters[name] = { mode: 'cubic', points: [] };
  return parameters;
}

function takes(expr) {
  return { activeTakeId: 0, takes: [{ id: 0, expr: expr ?? 0.0, liked: false }] };
}

/** Build one note object exactly as the editor stores it. */
export function buildNote({ pitch, onset, duration, lyric }) {
  const blickOnset = beatsToBlick(onset);
  const blickDuration = beatsToBlick(duration);
  if (!(blicksOk(blickOnset)) || !(blicksOk(blickDuration)) || blickDuration <= 0) {
    throw new Error(`invalid note timing: onset=${onset} duration=${duration}`);
  }
  return {
    musicalType: 'singing',
    onset: blickOnset,
    duration: blickDuration,
    lyrics: lyric == null || lyric === '' ? 'la' : String(lyric),
    phonemes: '',
    accent: '',
    pitch: Math.round(pitch),
    detune: 0,
    instantMode: true,
    attributes: { evenSyllableDuration: true },
    systemAttributes: {
      tF0Offset: 0.0,
      tF0Left: 0.1,
      tF0Right: 0.1,
      dF0Left: 0.0,
      dF0Right: 0.0,
      dF0Vbr: 0.0,
      evenSyllableDuration: true,
    },
    pitchTakes: takes(0.0),
    timbreTakes: takes(0.0),
  };
}

function blicksOk(value) {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

/**
 * Build a complete .svp document.
 *
 * @param {object} options
 * @param {string} options.title        project / export file name
 * @param {number} options.bpm
 * @param {{numerator:number,denominator:number}} options.meter
 * @param {object} options.database     mainRef.database descriptor
 * @param {Array}  options.notes        [{pitch, onset, duration, lyric}] in beats
 * @param {string} [options.trackName]
 * @param {{preset:string, amount?:number}} [options.vocalMode]
 */
export function buildProject({ title, bpm, meter, database, notes, trackName, vocalMode }) {
  const groupUuid = randomUUID();
  const group = {
    name: 'main',
    uuid: groupUuid,
    parameters: emptyParameters(),
    vocalModes: {},
    notes: notes.slice().sort((a, b) => a.onset - b.onset),
  };

  const voice = { vocalModeInherited: true, vocalModePreset: '', vocalModeParams: {} };
  if (vocalMode && vocalMode.preset) {
    const amount = Number.isFinite(Number(vocalMode.amount)) ? Number(vocalMode.amount) : 100;
    voice.vocalModeInherited = false;
    voice.vocalModePreset = String(vocalMode.preset);
    voice.vocalModeParams = { [String(vocalMode.preset)]: amount };
  }

  const track = {
    name: trackName || 'Vocal',
    dispColor: TRACK_COLOR,
    dispOrder: 0,
    renderEnabled: true,
    mixer: { gainDecibel: 0.0, pan: 0.0, mute: false, solo: false, display: true },
    mainGroup: group,
    mainRef: {
      groupID: groupUuid,
      blickAbsoluteBegin: 0,
      blickAbsoluteEnd: -1,
      blickOffset: 0,
      pitchOffset: 0,
      isInstrumental: false,
      systemPitchDelta: { mode: 'cubic', points: [] },
      database,
      dictionary: '',
      voice,
      pitchTakes: takes(0.0),
      timbreTakes: takes(0.0),
    },
    groups: [],
  };

  return {
    version: SVP_VERSION,
    time: {
      meter: [{ index: 0, numerator: meter.numerator, denominator: meter.denominator }],
      tempo: [{ position: 0, bpm: Number(bpm) }],
    },
    library: [],
    tracks: [track],
    renderConfig: {
      destination: '',
      filename: title || 'untitled',
      numChannels: 1,
      aspirationFormat: 'noAspiration',
      bitDepth: 16,
      sampleRate: 44100,
      exportMixDown: true,
      exportPitch: false,
    },
  };
}

/** Serialize a project the way the editor saves it (JSON + trailing NUL). */
export function serializeProject(project) {
  return Buffer.concat([Buffer.from(JSON.stringify(project), 'utf8'), Buffer.from([0])]);
}

/** Parse .svp bytes, tolerating the trailing NUL and a UTF-8 BOM. */
export function parseProject(buffer) {
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\u0000+$/u, '').trim();
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || !Array.isArray(data.tracks)) {
    throw new Error('not a Synthesizer V project (missing "tracks")');
  }
  return data;
}

/** Human-readable summary of a parsed project. */
export function summarizeProject(data) {
  const tempo = Array.isArray(data.time?.tempo) ? data.time.tempo : [];
  const meter = Array.isArray(data.time?.meter) ? data.time.meter : [];
  const bpm = tempo.length ? Number(tempo[0].bpm) : null;
  const tracks = (data.tracks || []).map((track, index) => {
    const ref = track.mainRef || {};
    const database = ref.database || {};
    const notes = (track.mainGroup?.notes || []).map((note) => ({
      onset: blickToBeats(note.onset),
      duration: blickToBeats(note.duration),
      pitch: note.pitch,
      name: midiToPitchName(note.pitch),
      lyric: note.lyrics,
    }));
    const endBeat = notes.reduce((max, n) => Math.max(max, n.onset + n.duration), 0);
    return {
      index,
      name: track.name,
      instrumental: Boolean(ref.isInstrumental),
      noteCount: notes.length,
      beats: endBeat,
      seconds: bpm ? (endBeat * 60) / bpm : null,
      voice: {
        database: database.name || '',
        language: database.languageOverride || database.language || '',
        backend: database.backendType || '',
        version: database.version || '',
      },
      lyrics: notes.map((n) => n.lyric).join(' ').trim(),
      pitchRange: notes.length
        ? `${midiToPitchName(Math.min(...notes.map((n) => n.pitch)))}..${midiToPitchName(
            Math.max(...notes.map((n) => n.pitch)),
          )}`
        : '',
      notes,
    };
  });
  const first = tracks[0];
  return {
    version: data.version,
    bpm,
    meter: meter.length ? `${meter[0].numerator}/${meter[0].denominator}` : null,
    renderFileName: data.renderConfig?.filename ?? null,
    trackCount: tracks.length,
    noteCount: first ? first.noteCount : 0,
    seconds: first ? first.seconds : 0,
    lyrics: first ? first.lyrics : '',
    tracks,
  };
}

const TOKEN_SEPARATOR = /[\s,]+/u;

/**
 * Parse a compact melody notation into note objects.
 *
 * Every token is `pitch:beats[:lyric]` (either `:` or `/` works):
 *   C4:1:你     a quarter-note C4 singing "你"
 *   D4:0.5:好   an eighth-note D4
 *   R:1         a rest (advances time, adds no note)
 *   -:0.5:啊    hold the previous pitch
 *   |           a bar line; ignored
 *
 * Beats are counted in quarter notes, so 4/4 bars are 4 beats long.
 */
export function parseNotation(notation) {
  const tokens = String(notation ?? '')
    .split(TOKEN_SEPARATOR)
    .map((t) => t.trim())
    .filter(Boolean);

  const notes = [];
  const warnings = [];
  let position = 0;
  let lastPitch = null;

  for (const token of tokens) {
    if (token === '|' || token === '||') continue;
    const parts = token.split(/[:/]/);
    if (parts.length < 2) {
      warnings.push(`ignored token "${token}" (expected pitch:beats:lyric)`);
      continue;
    }
    const [rawPitch, rawBeats, ...lyricParts] = parts;
    const beats = Number(rawBeats);
    if (!Number.isFinite(beats) || beats <= 0) {
      warnings.push(`ignored token "${token}" (bad duration "${rawBeats}")`);
      continue;
    }
    const lyric = lyricParts.length ? lyricParts.join(':') : '';
    if (/^r(est)?$/iu.test(rawPitch)) {
      position += beats;
      continue;
    }
    let pitch;
    if (rawPitch === '-' || rawPitch === '=') {
      if (lastPitch == null) {
        warnings.push(`"-" without a previous note at ${position} beats; treated as a rest`);
        position += beats;
        continue;
      }
      pitch = lastPitch;
    } else {
      pitch = pitchToMidi(rawPitch);
      lastPitch = pitch;
    }
    notes.push({
      pitch,
      onset: position,
      duration: beats,
      lyric: lyric === '' ? (rawPitch === '-' ? '-' : 'la') : lyric,
    });
    position += beats;
  }

  return { notes, warnings, beats: position };
}

/**
 * Normalize an array of caller supplied notes into the internal shape,
 * clipping overlaps that the editor would reject.
 */
export function normalizeNotes(input) {
  const warnings = [];
  const raw = Array.isArray(input) ? input : [];
  const notes = raw.map((note, index) => {
    const pitch = pitchToMidi(note.pitch);
    const onset = Number(note.onset ?? note.start ?? 0);
    const duration = Number(note.duration ?? note.length ?? 1);
    if (!Number.isFinite(onset) || onset < 0) throw new Error(`note ${index}: bad onset`);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`note ${index}: bad duration`);
    return {
      pitch,
      onset,
      duration,
      lyric: note.lyric ?? note.lyrics ?? note.text ?? '',
    };
  });

  notes.sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
  for (let i = 0; i < notes.length - 1; i += 1) {
    const current = notes[i];
    const next = notes[i + 1];
    const end = current.onset + current.duration;
    if (end > next.onset + 1e-9) {
      const clipped = Math.max(0.0625, next.onset - current.onset);
      warnings.push(
        `note ${i} ("${current.lyric || 'la'}") overlapped the next note; shortened ` +
          `${current.duration.toFixed(3)} -> ${clipped.toFixed(3)} beats`,
      );
      current.duration = clipped;
    }
  }
  return { notes, warnings };
}
