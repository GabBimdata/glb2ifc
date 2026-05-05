#!/usr/bin/env bun
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

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
  for (const filename of ['.env', '.env.local']) {
    const envPath = path.join(root, filename);
    if (!fs.existsSync(envPath)) continue;
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
}

async function probeJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* noop */ }
    return { ok: response.ok, status: response.status, json, text };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

loadLocalEnvFiles();

const appUrl = process.env.GLB2IFC_APP_URL || 'http://127.0.0.1:3737/api/qwen-status';
const host = process.env.QWEN_LLAMA_HOST || '127.0.0.1';
const port = process.env.QWEN_LLAMA_PORT || '8081';
const baseUrl = process.env.QWEN_LLAMA_BASE_URL || `http://${host}:${port}`;

console.log('Qwen configuration');
console.log('──────────────────');
console.log(`QWEN_LLAMA_SERVER_BIN=${process.env.QWEN_LLAMA_SERVER_BIN || '(auto)'}`);
console.log(`QWEN_MODEL_PATH=${process.env.QWEN_MODEL_PATH || path.join(root, 'models', 'Qwen3-Reranker-0.6B-Q4_K_M.gguf')}`);
console.log(`QWEN_LLAMA_BASE_URL=${baseUrl}`);
console.log('');

const app = await probeJson(appUrl);
if (app.ok) {
  console.log('App /api/qwen-status: OK');
  console.log(JSON.stringify(app.json, null, 2));
} else {
  console.log('App /api/qwen-status: unavailable');
  console.log(app.error || `HTTP ${app.status}`);
}

console.log('');
const health = await probeJson(`${baseUrl}/health`);
if (health.ok) {
  console.log('llama-server /health: OK');
  console.log(health.text || JSON.stringify(health.json, null, 2));
} else {
  console.log('llama-server /health: unavailable');
  console.log(health.error || `HTTP ${health.status}`);
}
