import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EQUIPMENT_TYPES } from '../src/studio/equipment-catalog.js';

test('every studio equipment is backed by a replaceable GLB asset', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));

  for (const [type, item] of Object.entries(EQUIPMENT_TYPES)) {
    assert.ok(item.asset, `${type} must have an asset path`);
    assert.equal(item.exactAsset, true, `${type} must use exact IFC geometry`);

    const relative = item.asset.replace(/^\//, 'public/');
    assert.ok(existsSync(`${root}/${relative}`), `missing GLB: ${relative}`);
  }
});
