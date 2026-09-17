import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
async function walk(dir) {
  const items = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(items.map(item => item.isDirectory() ? walk(`${dir}/${item.name}`) : [`${dir}/${item.name}`]));
  return files.flat();
}
const files = ['server.js', ...(await Promise.all(['src','public','scripts','tests'].map(walk))).flat()];
let checked = 0, failed = 0;
for (const file of files) {
  if (/\.(js|mjs)$/.test(file)) {
    const result = spawnSync('node', ['--check', file], { encoding: 'utf8' });
    checked++;
    if (result.error || result.status !== 0) { failed++; console.error(result.error || result.stderr); }
  } else if (file.endsWith('.html')) {
    const html = await readFile(file, 'utf8');
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      if (/\bsrc\s*=/.test(match[1]) || /type\s*=\s*["'](?:importmap|application\/)/.test(match[1])) continue;
      const type = /type\s*=\s*["']module/.test(match[1]) ? 'module' : 'commonjs';
      const result = spawnSync('node', ['--check', `--input-type=${type}`], { input: match[2], encoding: 'utf8' });
      checked++;
      if (result.error || result.status !== 0) { failed++; console.error(file, result.error || result.stderr); }
    }
  }
}
console.log(`${checked} scripts checked, ${failed} errors.`);
process.exitCode = failed ? 1 : 0;
