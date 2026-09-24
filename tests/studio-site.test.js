import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/studio/model.js';
import { buildElements, siteElements } from '../src/studio/build.js';
import { exportIfc } from '../src/studio/ifc-export.js';

function project() {
  const pr = M.newProject('Abords');
  const L = pr.levels[0];
  const h = [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]];
  for (let i = 0; i < 4; i++) M.addWall(L, h[i], h[i + 1], { type: 'ext30' });
  M.recomputeAll(pr);
  pr.site.boundary = [[-8, -6], [22, -6], [22, 20], [-8, 20]];
  pr.site.surfaces = [
    { id: 's1', type: 'road', poly: [[12, -6], [16, -6], [16, 14], [12, 14]] },
    { id: 's2', type: 'lawn', poly: [[-6, 10], [10, 10], [10, 18], [-6, 18]] },
  ];
  pr.site.parkings = [{ id: 'p1', x: 14, y: 2, rotation: 90, width: 2.5, depth: 5 }];
  pr.site.trees = [{ id: 't1', x: -4, y: 14, diameter: 4, height: 7, kind: 'deciduous' }, { id: 't2', x: 19, y: 16, diameter: 3, height: 9, kind: 'conifer' }];
  pr.site.hedges = [{ id: 'h1', points: [[-8, 20], [22, 20]], height: 1.6, width: 0.8 }];
  return pr;
}

const openEdges = (mesh) => {
  const key = (p) => p.map((v) => v.toFixed(5)).join(',');
  const P = mesh.positions.map(key);
  const n = new Map();
  for (const [a, b, c] of mesh.triangles) for (const [x, y] of [[a, b], [b, c], [c, a]]) {
    const k = P[x] < P[y] ? `${P[x]}|${P[y]}` : `${P[y]}|${P[x]}`;
    n.set(k, (n.get(k) || 0) + 1);
  }
  return [...n.values()].filter((v) => v !== 2).length;
};

test('site elements are closed solids sitting on the finished ground', () => {
  const pr = project();
  const els = siteElements(pr);
  assert.deepEqual([...new Set(els.map((e) => e.kind))].sort(), ['hedge', 'parking', 'siteSurface', 'terrain', 'tree']);
  for (const e of els) for (const p of e.siteParts) assert.equal(openEdges(p.mesh), 0, `${e.kind} ${p.key}`);
  // la place posée sur la voirie a son marquage au-dessus de l'enrobé
  const pk = els.find((e) => e.kind === 'parking');
  const road = els.find((e) => e.surface?.type === 'road');
  const roadTop = Math.max(...road.siteParts[0].mesh.positions.map((q) => q[2]));
  assert.ok(pk.top > roadTop);
  // un arbre est planté sur la pelouse, pas dessous
  const tree = els.find((e) => e.tree?.id === 't1');
  const lawnTop = Math.max(...els.find((e) => e.surface?.type === 'lawn').siteParts[0].mesh.positions.map((q) => q[2]));
  assert.ok(Math.abs(Math.min(...tree.siteParts[0].mesh.positions.map((q) => q[2])) - lawnTop) < 1e-9);
});

test('site is exported in IfcSite: terrain, civil surfaces, vegetation, parking spaces', () => {
  const ifc = exportIfc(project());
  assert.match(ifc, /IFCGEOGRAPHICELEMENT\([^\n]*\.TERRAIN\./);
  assert.match(ifc, /IFCCIVILELEMENT\([^\n]*'Voirie'/);
  assert.match(ifc, /IFCGEOGRAPHICELEMENT\([^\n]*'Pelouse'/);
  assert.match(ifc, /IFCGEOGRAPHICELEMENT\([^\n]*'Arbre'/);
  assert.match(ifc, /IFCGEOGRAPHICELEMENT\([^\n]*'Haie'/);
  assert.match(ifc, /IFCSPACE\([^\n]*\.PARKING\./);
  assert.match(ifc, /IFCRELCONTAINEDINSPATIALSTRUCTURE\('[^']+',#\d+,\$,\$,\([^)]*\),#\d+\);/);
});

test('roofs are exported as IfcRoof carrying their own geometry', () => {
  const pr = project();
  const ifc = exportIfc(pr);
  assert.match(ifc, /IFCROOF\([^\n]*,#\d+,\$,\.(GABLE|HIP|SHED|FLAT)_ROOF\.\)/, 'IfcRoof avec représentation');
  assert.doesNotMatch(ifc, /IFCSLAB\([^\n]*\.ROOF\.\)/, 'plus de dalle de toiture');
});

test('older projects without a site open with an empty one', () => {
  const pr = project();
  delete pr.site;
  const again = M.validateProject(JSON.parse(JSON.stringify(pr)));
  assert.deepEqual(again.site, M.emptySite());
  assert.ok(buildElements(again).elements.every((e) => e.kind !== 'terrain'));
});

test('all paved site surfaces are civil elements contained directly in the site', () => {
  const pr = project();
  pr.site.surfaces = ['road', 'path', 'paving'].map((type, i) => ({ id: `civil-${i}`, type, poly: [[12, 0], [14, 0], [14, 2], [12, 2]] }));
  const ifc = exportIfc(pr);
  const siteId = ifc.match(/(#\d+)=IFCSITE\(/)[1];
  const surfaces = [...ifc.matchAll(/(#\d+)=IFCCIVILELEMENT\(([^\n]*)\);/g)];
  assert.equal(surfaces.length, 3);
  for (const [_, id, attrs] of surfaces) {
    assert.equal(attrs.split(',').length, 8, 'IfcCivilElement has no PredefinedType argument');
    assert.ok(ifc.split('\n').some(line => line.includes('IFCRELCONTAINEDINSPATIALSTRUCTURE(') && line.endsWith(`,${siteId});`) && line.includes(id + ',')));
  }
  assert.doesNotMatch(ifc, /IFCSLAB\([^\n]*'Dallage'/);
});
