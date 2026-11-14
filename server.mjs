#!/usr/bin/env node
// MCP server for Synthesizer V Studio.
//
// Speaks the Model Context Protocol over stdio (newline-delimited JSON-RPC 2.0)
// and exposes tools that write real .svp projects, inspect them, and open them
// in the editor. It has no third-party dependencies: it only needs Node.js.
//
// Environment overrides:
//   SV_APP_DIR        folder that holds synthv-sharp.exe
//   SV_DATABASES_DIR  folder that holds the voice database folders
//   SV_SONGS_DIR      default folder for generated projects

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildNote,
  buildProject,
  parseMeter,
  parseNotation,
  parseProject,
  normalizeNotes,
  serializeProject,
  summarizeProject,
} from './lib/svp.mjs';
import { databaseDescriptor, databaseRoots, findVoice, listVoices } from './lib/voices.mjs';
import { appDirectory, executablePath, openProject, studioStatus } from './lib/studio.mjs';

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER_INFO = { name: 'sv-mcp', version: '1.0.0' };
const DEFAULT_LANGUAGE = 'mandarin';
const DEFAULT_VOICE = 'Kasane Teto';
const DEFAULT_BPM = 120;

const INSTRUCTIONS = [
  'Synthesizer V Studio song writing bridge.',
  'Call write_song with notes or a compact notation to create a real .svp project,',
  'then call open_song so the user can listen, edit and render it.',
  'read_song inspects an existing project; list_voices lists installed singers.',
  'This server cannot render audio: rendering stays a click in the editor.',
].join(' ');

function songsDirectory() {
  if (process.env.SV_SONGS_DIR) return process.env.SV_SONGS_DIR;
  return path.join(PACKAGE_ROOT, 'songs');
}

function slugify(text) {
  const slug = String(text || 'song')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 60);
  return slug || 'song';
}

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

// ---------------------------------------------------------------- tools

const TOOLS = {
  list_voices: {
    description:
      '列出本机安装的所有 Synthesizer V 声库（名称、版本、支持的语种、所在文件夹）。写歌前用它挑 voice。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const voices = await listVoices();
      return {
        databasesDirectory: process.env.SV_DATABASES_DIR || databaseRoots()[0] || null,
        count: voices.length,
        voices: voices.map((voice) => ({
          name: voice.name,
          folder: voice.folder,
          version: voice.version,
          vendor: voice.vendor,
          baseLanguage: voice.baseLanguage,
          languages: voice.languages,
          verified: voice.known,
        })),
      };
    },
  },

  write_song: {
    description:
      '把一段旋律+歌词写成真正的 Synthesizer V 工程文件（.svp）并保存到磁盘。' +
      '用 notes 数组或 notation 简谱字符串给出旋律；写好后调用 open_song 让用户在编辑器里试听、渲染。' +
      'notation 写法：每个音 `音高:拍数:歌词`，例如 `C4:1:你 D4:0.5:好 R:0.5 | E4:2:啊`；R 是休止，- 是延音，拍数按四分音符计。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '工程名，同时作为默认导出文件名' },
        bpm: { type: 'number', description: '速度，默认 120' },
        meter: { type: 'string', description: '拍号，如 4/4、3/4、6/8，默认 4/4' },
        voice: { type: 'string', description: '声库名或文件夹名，默认 Kasane Teto；先用 list_voices 查' },
        language: {
          type: 'string',
          description: '演唱语言：mandarin / japanese / english / cantonese / spanish，默认 mandarin',
        },
        notation: { type: 'string', description: '简谱字符串（与 notes 二选一）' },
        notes: {
          type: 'array',
          description: '音符数组（与 notation 二选一）',
          items: {
            type: 'object',
            properties: {
              pitch: { type: ['string', 'number'], description: 'C4、F#3、Bb2 或 MIDI 数字' },
              onset: { type: 'number', description: '起始拍（四分音符为 1，从 0 开始）' },
              duration: { type: 'number', description: '时值（拍）' },
              lyric: { type: 'string', description: '一个音节，如 你、好、la' },
            },
            required: ['pitch', 'onset', 'duration'],
            additionalProperties: false,
          },
        },
        path: { type: 'string', description: '输出路径（可选，默认写到 sv-mcp/songs/）' },
        track_name: { type: 'string', description: '轨道名' },
        vocal_mode: { type: 'string', description: '可选：声库的 Vocal Mode 预设名，如 Joyful / Power' },
        vocal_mode_amount: { type: 'number', description: 'Vocal Mode 强度 0-100，默认 100' },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (args) => {
      const voice =
        (await findVoice(args.voice)) ||
        (await findVoice(DEFAULT_VOICE)) ||
        (await listVoices())[0] ||
        null;
      if (!voice) throw new Error('no voice database found; check SV_DATABASES_DIR or install a voice');

      const language = String(args.language || DEFAULT_LANGUAGE).toLowerCase();
      const bpm = Number(args.bpm ?? DEFAULT_BPM);
      if (!(bpm > 0 && bpm < 1000)) throw new Error(`bad bpm: ${args.bpm}`);
      const meter = parseMeter(args.meter);

      const warnings = [];
      let rawNotes;
      let totalBeats;
      if (Array.isArray(args.notes) && args.notes.length) {
        const normalized = normalizeNotes(args.notes);
        rawNotes = normalized.notes;
        warnings.push(...normalized.warnings);
        totalBeats = rawNotes.reduce((max, n) => Math.max(max, n.onset + n.duration), 0);
      } else if (args.notation) {
        const parsed = parseNotation(args.notation);
        rawNotes = parsed.notes;
        totalBeats = parsed.beats;
        warnings.push(...parsed.warnings);
      } else {
        throw new Error('provide either notes[] or notation');
      }
      if (!rawNotes.length) throw new Error('the song has no notes');

      const notes = rawNotes.map((note) => buildNote(note));
      notes.sort((a, b) => a.onset - b.onset);

      const title = String(args.title || '未命名歌曲');
      const database = databaseDescriptor(voice, language);
      const project = buildProject({
        title,
        bpm,
        meter,
        database,
        notes,
        trackName: args.track_name || title,
        vocalMode: args.vocal_mode ? { preset: args.vocal_mode, amount: args.vocal_mode_amount } : null,
      });

      const requested = args.path ? path.resolve(args.path) : null;
      const outDir = requested ? path.dirname(requested) : songsDirectory();
      const outPath = requested || path.join(outDir, `${slugify(title)}.svp`);
      await fsp.mkdir(outDir, { recursive: true });
      await fsp.writeFile(outPath, serializeProject(project));

      const bytes = (await fsp.stat(outPath)).size;
      return {
        path: outPath,
        bytes,
        title,
        bpm,
        meter: `${meter.numerator}/${meter.denominator}`,
        voice: { database: database.name, language: language, base: database.language },
        notes: notes.length,
        beats: Number(totalBeats.toFixed(3)),
        seconds: Number(((totalBeats * 60) / bpm).toFixed(2)),
        lyrics: rawNotes.map((n) => n.lyric || 'la').join(' ').trim(),
        warnings,
        next: 'open_song 打开这个工程；在编辑器里按空格试听，用「渲染」面板导出 wav。',
      };
    },
  },

  read_song: {
    description: '读取一个 .svp 工程的摘要：速度、拍号、声库、音符数、歌词、音域、时长（不打开编辑器）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '.svp 文件路径' },
        include_notes: { type: 'boolean', description: '是否返回逐个音符，默认 false' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const file = path.resolve(String(args.path));
      const buffer = await fsp.readFile(file);
      const data = parseProject(buffer);
      const summary = summarizeProject(data);
      if (!args.include_notes) {
        for (const track of summary.tracks) delete track.notes;
      }
      return { path: file, ...summary };
    },
  },

  open_song: {
    description: '用 Synthesizer V Studio 打开一个 .svp 工程（编辑器已在运行时会新开一个窗口）。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '.svp 文件路径' } },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const file = path.resolve(String(args.path));
      const launched = openProject(PACKAGE_ROOT, file);
      return { ...launched, note: '编辑器是独立进程，本工具返回时窗口可能仍在加载。' };
    },
  },

  app_status: {
    description: '查看 Synthesizer V Studio 是否在运行，以及程序所在路径。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({
      ...studioStatus(),
      appDirectory: appDirectory(PACKAGE_ROOT),
      executable: executablePath(PACKAGE_ROOT),
      songsDirectory: songsDirectory(),
    }),
  },
};

// ---------------------------------------------------------------- protocol

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolList() {
  return Object.entries(TOOLS).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

async function callTool(id, params) {
  const name = params?.name;
  const tool = TOOLS[name];
  if (!tool) {
    fail(id, -32602, `unknown tool: ${name}`);
    return;
  }
  const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  try {
    const result = await tool.handler(args);
    ok(id, { content: text(result), isError: false });
  } catch (error) {
    ok(id, {
      content: text({ error: String(error?.message || error) }),
      isError: true,
    });
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize': {
      const version = params?.protocolVersion || '2025-06-18';
      ok(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
      return;
    }
    case 'notifications/initialized':
    case 'initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed':
      return;
    case 'ping':
      if (isRequest) ok(id, {});
      return;
    case 'tools/list':
      ok(id, { tools: toolList() });
      return;
    case 'tools/call':
      await callTool(id, params);
      return;
    case 'resources/list':
      ok(id, { resources: [] });
      return;
    case 'resources/templates/list':
      ok(id, { resourceTemplates: [] });
      return;
    case 'prompts/list':
      ok(id, { prompts: [] });
      return;
    case 'logging/setLevel':
      ok(id, {});
      return;
    default:
      if (isRequest) fail(id, -32601, `method not found: ${method}`);
  }
}

function main() {
  let buffer = '';
  let pending = 0;
  let inputEnded = false;

  const exitWhenIdle = () => {
    if (inputEnded && pending === 0) process.exit(0);
  };

  const dispatch = (message) => {
    pending += 1;
    Promise.resolve(handleMessage(message))
      .catch((error) => {
        process.stderr.write(`sv-mcp handler error: ${error?.stack || error}\n`);
      })
      .finally(() => {
        pending -= 1;
        exitWhenIdle();
      });
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        fail(null, -32700, 'parse error');
        continue;
      }
      dispatch(message);
    }
  });
  process.stdin.on('end', () => {
    inputEnded = true;
    exitWhenIdle();
  });
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  process.stderr.write(`sv-mcp ready (root: ${PACKAGE_ROOT})\n`);
}

main();
