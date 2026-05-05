#!/usr/bin/env bun
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';

const QWEN_ENV_KEYS = [
  'QWEN_LLAMA_SERVER_BIN',
  'QWEN_MODEL_PATH',
  'QWEN_LLAMA_HOST',
  'QWEN_LLAMA_PORT',
  'QWEN_LLAMA_CONTEXT',
  'QWEN_LLAMA_BATCH',
  'QWEN_AUTO_START',
  'QWEN_RERANKER_URL',
];

function repairQwenEnvNewlines(content) {
  let repaired = String(content || '');
  for (const key of QWEN_ENV_KEYS) {
    repaired = repaired.replace(new RegExp(`([^\r\n])(?=${key}=)`, 'g'), '$1\n');
  }
  return repaired;
}

function parseEnvLines(content) {
  return repairQwenEnvNewlines(content).split(/\r?\n/);
}

function loadLocalEnvFiles() {
  const loaded = [];
  for (const filename of ['.env', '.env.local']) {
    const envPath = path.join(root, filename);
    if (!fs.existsSync(envPath)) continue;
    loaded.push(envPath);
    for (const line of parseEnvLines(fs.readFileSync(envPath, 'utf8'))) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const key = match[1];
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
  return loaded;
}

function normalizeConfiguredPath(value) {
  const clean = String(value || '').trim().replace(/^["']|["']$/g, '');
  if (!clean) return '';
  if (clean === '~') return os.homedir();
  if (clean.startsWith(`~${path.sep}`) || clean.startsWith('~/')) {
    return path.join(os.homedir(), clean.slice(2));
  }
  return path.isAbsolute(clean) ? clean : path.resolve(root, clean);
}

function exists(filePath) {
  try { return Boolean(filePath) && fs.existsSync(filePath); } catch (_) { return false; }
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values.filter(Boolean)) {
    const key = isWindows ? String(value).toLowerCase() : String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function findPortableCMake() {
  const cmakeToolsDir = path.join(root, '.tools', 'cmake');
  if (!exists(cmakeToolsDir)) return '';

  const stack = [cmakeToolsDir];
  const found = [];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase() === 'cmake.exe' && full.toLowerCase().includes(`${path.sep}bin${path.sep}`)) {
        found.push(full);
      }
    }
  }
  return found.sort().pop() || '';
}

function findInPath(commandName) {
  if (isWindows && commandName.toLowerCase() === 'cmake') {
    const portable = findPortableCMake();
    if (portable) return portable;
  }

  const names = isWindows
    ? [`${commandName}.exe`, commandName, `${commandName}.cmd`, `${commandName}.bat`]
    : [commandName];
  for (const entry of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (exists(candidate)) return candidate;
    }
  }
  return '';
}


function hasVSNativeBuildTools() {
  if (!isWindows) return false;
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (exists(vswhere)) {
    try {
      const out = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Workload.NativeDesktop', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
      if (out) return true;
    } catch (_) {}
  }
  return Boolean(findInPath('cl') || findInPath('clang') || findInPath('gcc'));
}

function candidateRoots() {
  const roots = [
    process.env.QWEN_LLAMA_CPP_DIR,
    process.env.LLAMA_CPP_DIR,
    path.join(root, '.tools', 'llama.cpp'),
    path.join(root, 'tools', 'llama.cpp'),
    path.join(root, 'llama.cpp'),
    path.resolve(root, '..', 'llama.cpp'),
    path.resolve(root, '..', '..', 'llama.cpp'),
  ];

  if (isWindows) {
    const drive = path.parse(root).root || 'C:\\';
    roots.push(path.win32.join(drive, 'Github', 'llama.cpp'));
    roots.push('F:\\Github\\llama.cpp');
    roots.push('C:\\Github\\llama.cpp');
  }

  return unique(roots.map(normalizeConfiguredPath));
}

function candidateBins() {
  const configured = normalizeConfiguredPath(process.env.QWEN_LLAMA_SERVER_BIN || '');
  const names = isWindows ? ['llama-server.exe'] : ['llama-server'];
  const suffixes = [
    path.join('build', 'bin', 'Release'),
    path.join('build', 'bin', 'RelWithDebInfo'),
    path.join('build', 'bin', 'Debug'),
    path.join('build', 'bin'),
    path.join('bin', 'Release'),
    'bin',
    path.join('examples', 'server', 'Release'),
    path.join('server', 'Release'),
    '',
  ];

  const bins = [];
  if (configured) bins.push(configured);
  for (const candidateRoot of candidateRoots()) {
    for (const suffix of suffixes) {
      for (const name of names) bins.push(path.join(candidateRoot, suffix, name));
    }
  }
  bins.push(findInPath('llama-server'));
  return unique(bins);
}

function resolveQwenModelPath() {
  if (process.env.QWEN_MODEL_PATH) return normalizeConfiguredPath(process.env.QWEN_MODEL_PATH);
  const modelsDir = path.join(root, 'models');
  const defaultModelPath = path.join(modelsDir, 'Qwen3-Reranker-0.6B-Q4_K_M.gguf');
  if (!fs.existsSync(modelsDir)) return defaultModelPath;
  const files = fs.readdirSync(modelsDir)
    .filter((name) => name.toLowerCase().endsWith('.gguf'))
    .map((name) => path.join(modelsDir, name));
  return files.find((file) => /qwen3.*reranker/i.test(path.basename(file))) || files[0] || defaultModelPath;
}

const loadedEnv = loadLocalEnvFiles();
const modelPath = resolveQwenModelPath();
const bins = candidateBins();
const foundBin = bins.find(exists) || '';
const roots = candidateRoots();
const gitPath = findInPath('git');
const cmakePath = findInPath('cmake');
const hasBuildTools = isWindows ? hasVSNativeBuildTools() : true;

console.log('Qwen doctor');
console.log('────────────');
console.log(`Platform: ${process.platform}`);
console.log(`Project:  ${root}`);
console.log(`Env:      ${loadedEnv.length ? loadedEnv.join(', ') : '(no .env/.env.local found)'}`);
console.log('');

console.log('Model');
console.log(`  Path:   ${modelPath}`);
console.log(`  Exists: ${exists(modelPath) ? 'yes' : 'no'}`);
console.log('');

console.log('Prerequisites');
console.log(`  git:     ${gitPath || 'no'}`);
console.log(`  cmake:   ${cmakePath || 'no'}`);
if (isWindows) console.log(`  C++ toolchain: ${hasBuildTools ? 'detected' : 'not detected'}`);
console.log('');

console.log('llama-server');
if (process.env.QWEN_LLAMA_SERVER_BIN) {
  console.log(`  Configured QWEN_LLAMA_SERVER_BIN: ${normalizeConfiguredPath(process.env.QWEN_LLAMA_SERVER_BIN)}`);
}
console.log(`  Found:  ${foundBin || 'no'}`);
console.log('');

console.log('Search roots');
for (const candidateRoot of roots) {
  console.log(`  ${exists(candidateRoot) ? '✓' : '·'} ${candidateRoot}`);
}
console.log('');

const shown = bins.slice(0, 30);
console.log(`Candidate binaries (${bins.length} total, showing ${shown.length})`);
for (const bin of shown) {
  console.log(`  ${exists(bin) ? '✓' : '·'} ${bin}`);
}
if (bins.length > shown.length) console.log(`  … ${bins.length - shown.length} more`);
console.log('');

if (foundBin && exists(modelPath)) {
  console.log('OK: Qwen can be started by the app.');
  process.exit(0);
}

console.log('Next steps');
if (!foundBin) {
  if (isWindows) {
    if (!gitPath || !cmakePath || !hasBuildTools) {
      console.log('  1. Install/check Windows prerequisites:');
      console.log('     bun run qwen:prereqs:windows');
      if (!cmakePath) {
        console.log('     The setup can now install a portable CMake under .tools/cmake if winget does not update PATH.');
      }
      if (!hasBuildTools) {
        console.log('     If it reports missing C++ build tools, install Visual Studio Build Tools with Desktop C++ workload.');
      }
    }
    console.log('  2. Build or locate llama-server.exe:');
    console.log('     bun run qwen:setup:windows');
    console.log('  3. Or point to an existing binary:');
    console.log('     bun run qwen:setup -- --skip-build --llama-server-bin "F:\\Github\\llama.cpp\\build\\bin\\Release\\llama-server.exe"');
  } else {
    console.log('  1. Build llama.cpp server:');
    console.log('     bun run qwen:setup');
  }
}
if (!exists(modelPath)) {
  console.log('  3. Put the Qwen3 reranker GGUF in ./models or set QWEN_MODEL_PATH in .env.local.');
}
process.exit(2);
