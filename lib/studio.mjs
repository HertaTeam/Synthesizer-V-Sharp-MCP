// Locating the Synthesizer V Studio executable, launching projects and
// reporting whether the editor is running.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EXE_NAMES = [
  'synthv-sharp.exe',
  'Synthesizer V Studio 2 Pro.exe',
  'Synthesizer V Studio Pro.exe',
  'Synthesizer V Studio Basic.exe',
];

const PROCESS_NAMES = ['synthv-sharp.exe', 'Synthesizer V Studio 2 Pro.exe', 'Synthesizer V Studio Pro.exe'];

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Directory of the program, from SV_APP_DIR or the folder above this package. */
export function appDirectory(packageRoot) {
  const candidates = [];
  if (process.env.SV_APP_DIR) candidates.push(process.env.SV_APP_DIR);
  candidates.push(path.dirname(packageRoot), packageRoot);
  for (const dir of candidates) {
    if (EXE_NAMES.some((name) => exists(path.join(dir, name)))) return dir;
  }
  return null;
}

/** Absolute path of the editor executable, or null when it cannot be found. */
export function executablePath(packageRoot) {
  const dir = appDirectory(packageRoot);
  if (!dir) return null;
  for (const name of EXE_NAMES) {
    const file = path.join(dir, name);
    if (exists(file)) return file;
  }
  return null;
}

function tasklistRunning() {
  const names = [...new Set([...PROCESS_NAMES])];
  for (const name of names) {
    const result = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    const output = String(result.stdout || '');
    if (/-FileItem|\.exe/iu.test(output) && !/no tasks|没有运行/u.test(output)) return name;
  }
  return null;
}

/** Running state of the editor (process image name or null). */
export function studioStatus() {
  const running = tasklistRunning();
  return { running: Boolean(running), process: running };
}

/**
 * Launch the editor with a project file and return immediately.
 * The editor is detached from this server so it survives tool calls.
 */
export function openProject(packageRoot, projectPath) {
  const exe = executablePath(packageRoot);
  if (!exe) throw new Error('Synthesizer V Studio executable not found; set SV_APP_DIR');
  if (projectPath && !exists(projectPath)) throw new Error(`project not found: ${projectPath}`);
  const args = projectPath ? [projectPath] : [];
  const child = spawn(exe, args, {
    cwd: path.dirname(exe),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return { pid: child.pid, executable: exe, project: projectPath ?? null };
}
