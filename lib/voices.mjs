// Voice database discovery and mainRef.database descriptors.
//
// Synthesizer V Studio keeps installed voice databases outside the program
// folder, in the user's Documents/Dreamtonics/Synthesizer V Studio/databases
// directory. Each database folder holds a large "voice.nofs" file whose header
// (around byte 4000) stores the display name, version, vendor and the list of
// supported languages as plain text.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const KNOWN_LANGUAGES = ['japanese', 'mandarin', 'english', 'cantonese', 'spanish'];

const PHONESET_BY_LANGUAGE = {
  japanese: 'romaji',
  mandarin: 'xsampa',
  cantonese: 'xsampa',
  english: 'arpabet',
  spanish: 'xsampa',
};

// Descriptors observed in projects that the user already rendered successfully.
// They win over the header heuristic because a wrong descriptor makes the
// editor open the project without its singer.
const KNOWN_DATABASES = {
  'kasane teto': {
    name: 'Kasane Teto',
    language: 'japanese',
    phoneset: 'romaji',
    backendType: 'SVR2AI',
    version: '104',
  },
  'kasane teto (lite)': {
    name: 'Kasane Teto (Lite)',
    language: 'japanese',
    phoneset: 'romaji',
    backendType: 'SVR2AI',
    version: '100',
  },
};

/** Directories that may contain voice databases, most specific first. */
export function databaseRoots() {
  const roots = [];
  if (process.env.SV_DATABASES_DIR) roots.push(process.env.SV_DATABASES_DIR);
  const docs = path.join(os.homedir(), 'Documents', 'Dreamtonics', 'Synthesizer V Studio', 'databases');
  roots.push(docs);
  const appDir = process.env.SV_APP_DIR;
  if (appDir) roots.push(path.join(appDir, 'databases'));
  return roots.filter((root, index) => roots.indexOf(root) === index && fs.existsSync(root));
}

function printableFields(header) {
  const fields = {};
  const keys = ['.name', '.version', '.vendor', '.language', '.phoneset', '.multi'];
  for (const key of keys) {
    const start = header.indexOf(key);
    if (start < 0) continue;
    const rest = header.slice(start + key.length);
    const stop = rest.indexOf('.', 1);
    const segment = stop > 0 ? rest.slice(0, stop) : rest.slice(0, 120);
    const text = segment.replace(/[^\x20-\x7e]+/gu, ' ').replace(/\s+/gu, ' ').trim();
    if (text) fields[key.slice(1)] = text;
  }
  return fields;
}

function cleanName(raw) {
  let name = String(raw || '').trim();
  // Trailing bytes from the binary length prefix sometimes decode as
  // printable punctuation ("$", "!", "* %" ...). Strip those.
  name = name.replace(/[^A-Za-z0-9)]+$/u, '').trim();
  const open = (name.match(/\(/gu) || []).length;
  const close = (name.match(/\)/gu) || []).length;
  if (close > open) name = name.replace(/\)+$/u, ')'.repeat(open));
  return name.trim();
}

function languagesFrom(fields) {
  if (fields.multi) {
    return fields.multi
      .split(/\s+/u)
      .map((token) => token.toLowerCase())
      .filter((token) => KNOWN_LANGUAGES.includes(token));
  }
  if (fields.language) {
    const single = fields.language.toLowerCase().replace(/[^a-z]/gu, '');
    if (KNOWN_LANGUAGES.includes(single)) return [single];
  }
  return [];
}

function readVoiceEntry(folder, dirName) {
  const nofsPath = path.join(folder, 'voice.nofs');
  let header = '';
  try {
    const fd = fs.openSync(nofsPath, 'r');
    try {
      const buffer = Buffer.alloc(16384);
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      header = buffer.subarray(0, read).toString('latin1');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const fields = printableFields(header);
  const name = cleanName(fields.name) || dirName.replace(/_/gu, ' ');
  const languages = languagesFrom(fields);
  const known = KNOWN_DATABASES[name.toLowerCase()];
  // Multi-language databases list every supported language without naming the
  // native one; Japanese-first covers the Japanese AI voices that ship with it.
  const baseLanguage =
    known?.language || (languages.includes('japanese') ? 'japanese' : languages[0] || 'japanese');
  const version = (fields.version || '').match(/\d+/u)?.[0] || known?.version || '100';

  return {
    name,
    folder: dirName,
    path: folder,
    vendor: cleanName(fields.vendor),
    version,
    languages: known ? KNOWN_LANGUAGES.filter((l) => l === known.language || languages.includes(l)) : languages,
    baseLanguage,
    basePhoneset: known?.phoneset || PHONESET_BY_LANGUAGE[baseLanguage] || 'romaji',
    backendType: 'SVR2AI',
    known: Boolean(known),
  };
}

/** All installed voice databases, in a stable order. */
export async function listVoices() {
  const voices = [];
  const seen = new Set();
  for (const root of databaseRoots()) {
    let entries = [];
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(root, entry.name);
      if (!fs.existsSync(path.join(folder, 'voice.nofs'))) continue;
      const key = entry.name.toLowerCase();
      if (seen.has(key)) continue;
      const voice = readVoiceEntry(folder, entry.name);
      if (!voice) continue;
      seen.add(key);
      voices.push(voice);
    }
  }
  voices.sort((a, b) => a.name.localeCompare(b.name));
  return voices;
}

/** Find a voice by display name or folder name (case-insensitive). */
export async function findVoice(query) {
  if (query == null || String(query).trim() === '') return null;
  const voices = await listVoices();
  const needle = String(query).trim().toLowerCase();
  return (
    voices.find((v) => v.name.toLowerCase() === needle) ||
    voices.find((v) => v.folder.toLowerCase() === needle) ||
    voices.find((v) => v.name.toLowerCase().includes(needle)) ||
    null
  );
}

/**
 * Build the mainRef.database descriptor for a voice.
 *
 * The editor stores the database's native language plus an optional override
 * for cross-lingual singing; a Chinese lyric on a Japanese database therefore
 * becomes language "japanese" with languageOverride "mandarin".
 */
export function databaseDescriptor(voice, language) {
  const requested = language ? String(language).toLowerCase() : null;
  const base = {
    name: voice.name,
    language: voice.baseLanguage,
    phoneset: voice.basePhoneset,
    backendType: voice.backendType || 'SVR2AI',
    version: String(voice.version || '100'),
  };
  if (requested && requested !== voice.baseLanguage) {
    return {
      ...base,
      languageOverride: requested,
      phonesetOverride: PHONESET_BY_LANGUAGE[requested] || 'xsampa',
    };
  }
  return base;
}
