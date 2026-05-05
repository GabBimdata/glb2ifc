#!/usr/bin/env bun
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    console.error(result.error.message || result.error);
    process.exit(1);
  }

  process.exit(result.status ?? 0);
}

function mapWindowsArgs(rawArgs) {
  const mapped = [];
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === '--cuda') { mapped.push('-Cuda'); continue; }
    if (arg === '--vulkan') { mapped.push('-Vulkan'); continue; }
    if (arg === '--skip-build') { mapped.push('-SkipBuild'); continue; }
    if (arg === '--find-only') { mapped.push('-FindOnly'); continue; }

    const valueFlags = new Map([
      ['--llama-server-bin', '-LlamaServerBin'],
      ['--llama-cpp-dir', '-LlamaCppDir'],
      ['--build-dir', '-BuildDir'],
      ['--model-path', '-ModelPath'],
    ]);

    const equalsMatch = arg.match(/^(--[^=]+)=(.*)$/);
    if (equalsMatch && valueFlags.has(equalsMatch[1])) {
      mapped.push(valueFlags.get(equalsMatch[1]), equalsMatch[2]);
      continue;
    }

    if (valueFlags.has(arg)) {
      const next = rawArgs[index + 1];
      if (!next) {
        console.error(`Missing value for ${arg}`);
        process.exit(1);
      }
      mapped.push(valueFlags.get(arg), next);
      index += 1;
      continue;
    }

    mapped.push(arg);
  }
  return mapped;
}

if (process.platform === 'win32') {
  const powershellArgs = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join('scripts', 'setup-qwen-windows.ps1'),
    ...mapWindowsArgs(args),
  ];

  run('powershell', powershellArgs);
}

run('bash', [path.join('scripts', 'setup-qwen-linux.sh'), ...args]);
