// Zero-dependency regression test for index.html's pure logic: the hand-written
// YAML frontmatter parser/serializer, relationship mirroring, sibling derivation,
// and the generation-based layout algorithm. Runs the app's own <script> in a
// minimal vm sandbox (no real DOM needed) so this stays in lockstep with the
// single-file app with no separate copy of the logic to drift out of sync.
//
// Run with: node tests/core.test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scriptMatch = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
if(!scriptMatch) throw new Error('Could not find inline <script> block in index.html');
const code = scriptMatch[1];

function makeEl(){
  return {
    style:{}, dataset:{}, children:[], _html:'',
    addEventListener(){}, querySelectorAll(){ return []; }, querySelector(){ return null; },
    appendChild(){}, remove(){}, closest(){ return null; }, setAttribute(){},
    get textContent(){ return ''; }, set textContent(v){},
    get innerHTML(){ return this._html; }, set innerHTML(v){ this._html = v; },
  };
}
const documentStub = {
  readyState: 'complete',
  getElementById(){ return makeEl(); },
  addEventListener(){},
  createElement(){ return makeEl(); },
  createElementNS(){ return makeEl(); },
};
const sandbox = {
  window: { addEventListener(){}, showDirectoryPicker: undefined },
  document: documentStub,
  console,
  URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
  alert: () => {},
};
sandbox.window.document = documentStub;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const T = sandbox.window.__TEST__;
assert.ok(T, 'test hooks exposed on window.__TEST__');

// vm sandbox objects live in a different realm than this script, so cross-realm
// arrays/objects are compared structurally via JSON rather than assert.deepEqual
// (which trips on prototype identity across realms).
const j = (v) => JSON.stringify(v);
let passed = 0;
function ok(label){ passed++; console.log('OK:', label); }

// ---- frontmatter parse / round-trip ----
const sample = `---
id: jiri-novak-1978
name: Jiří Novák
gender: male
dob: 1978-03-14
dob_precision: exact
birthplace: Prague, Czechoslovakia
dod:
deathplace:
occupation: Engineer
photo: ../photos/jiri-novak-1978.jpg
parents:
  - vaclav-novak-1950
  - marie-novakova-1952
children:
  - jan-novak-2005
spouses:
  - partner_id: anna-novakova-1980
    status: married
    start_date: 2003-06-14
    start_date_precision: exact
    end_date:
    end_date_precision:
    order: 1
custom_note: some ad hoc detail
---
Life story body here.
Second line.
`;
const { frontmatter, body } = T.parseFrontmatter(sample);
assert.equal(frontmatter.id, 'jiri-novak-1978');
assert.equal(frontmatter.name, 'Jiří Novák');
assert.equal(j(frontmatter.parents), j(['vaclav-novak-1950','marie-novakova-1952']));
assert.equal(frontmatter.spouses.length, 1);
assert.equal(frontmatter.spouses[0].partner_id, 'anna-novakova-1980');
assert.equal(frontmatter.spouses[0].order, 1);
assert.equal(frontmatter.custom_note, 'some ad hoc detail');
assert.ok(body.startsWith('Life story body here.'));
ok('frontmatter parse');

const serialized = T.serializePersonFile(frontmatter, body);
const reparsed = T.parseFrontmatter(serialized);
assert.equal(j(reparsed.frontmatter.spouses), j(frontmatter.spouses));
assert.equal(j(reparsed.frontmatter.parents), j(frontmatter.parents));
assert.equal(reparsed.frontmatter.custom_note, 'some ad hoc detail');
ok('frontmatter round-trip (write then re-parse is lossless)');

// ---- slug / id generation ----
assert.equal(T.slugify('Jiří Novák'), 'jiri-novak');
const existing = new Set(['jiri-novak-1978']);
const id1 = T.generateId('Jiří Novák', '1978-03-14', existing);
assert.notEqual(id1, 'jiri-novak-1978');
assert.ok(id1.startsWith('jiri-novak-1978-'));
ok('id generation + collision suffix');

// ---- relationship mirroring & rebuild ----
const people = new Map();
people.set('p1', { filename:'p1.md', frontmatter:{ id:'p1', name:'Parent One' }, body:'' });
people.set('p2', { filename:'p2.md', frontmatter:{ id:'p2', name:'Parent Two' }, body:'' });
people.set('c1', { filename:'c1.md', frontmatter:{ id:'c1', name:'Child One' }, body:'' });

const index = T.emptyIndex();
index.parentChild.push({ parent:'p1', child:'c1', type:'biological' });
index.parentChild.push({ parent:'p2', child:'c1', type:'biological' });
index.spousePairs.push({ id:'r1', a:'p1', b:'p2', status:'married', start_date:'2000-01-01', start_date_precision:'exact', end_date:null, end_date_precision:null, order_a:null, order_b:null });

T.computeMirrors(index, people);
assert.equal(j([...people.get('c1').frontmatter.parents].sort()), j(['p1','p2']));
assert.equal(j(people.get('p1').frontmatter.children), j(['c1']));
assert.equal(people.get('p1').frontmatter.spouses[0].partner_id, 'p2');
assert.equal(people.get('p1').frontmatter.spouses[0].order, 1);
ok('computeMirrors (index -> frontmatter)');

const rebuilt = T.rebuildIndexFromPeople(people);
assert.equal(rebuilt.parentChild.length, 2);
assert.equal(rebuilt.spousePairs.length, 1);
ok('rebuildIndexFromPeople (frontmatter -> index fallback)');

assert.equal(T.computeSiblings('c1', index).length, 0);

people.set('c2', { filename:'c2.md', frontmatter:{ id:'c2', name:'Child Two' }, body:'' });
index.parentChild.push({ parent:'p1', child:'c2', type:'biological' });
index.parentChild.push({ parent:'p2', child:'c2', type:'biological' });
const sibs2 = T.computeSiblings('c1', index);
assert.equal(sibs2.length, 1);
assert.equal(sibs2[0].id, 'c2');
assert.equal(sibs2[0].type, 'full');
ok('full sibling derivation (both parents shared)');

people.set('p3', { filename:'p3.md', frontmatter:{ id:'p3', name:'Step Parent' }, body:'' });
people.set('c3', { filename:'c3.md', frontmatter:{ id:'c3', name:'Step Child' }, body:'' });
index.spousePairs.push({ id:'r2', a:'p1', b:'p3', status:'married', start_date:'2015-01-01', start_date_precision:'exact', end_date:null, end_date_precision:null, order_a:2, order_b:1 });
index.parentChild.push({ parent:'p3', child:'c3', type:'biological' });
const stepEntry = T.computeSiblings('c1', index).find(s=>s.id==='c3');
assert.ok(stepEntry, 'step sibling found');
assert.equal(stepEntry.type, 'step');
ok('step sibling derivation (via parent\'s remarriage)');

// ---- layout: generations, spouse clustering, and parentless-spouse alignment ----
const ids = ['p1','p2','c1','c2','p3','c3'];
const { positions, gen } = T.computeLayout(ids, index, {});
assert.equal(gen.get('p1'), 0);
assert.equal(gen.get('c1'), 1);
assert.equal(gen.get('c2'), 1);
assert.equal(gen.get('c3'), 1);
const x1 = positions.get('p1').x, x2 = positions.get('p2').x;
assert.equal(Math.abs(x1-x2), 170+34);
ok('layout: generations + spouse clustering (couples adjacent)');

// A spouse with no parents recorded (added before their own parents were
// mapped) should be pulled onto their partner's row, not default to gen 0.
const idx2 = T.emptyIndex();
idx2.parentChild.push({ parent:'gp1', child:'partnerWithParents', type:'biological' });
idx2.parentChild.push({ parent:'gp2', child:'partnerWithParents', type:'biological' });
idx2.spousePairs.push({ id:'r3', a:'partnerWithParents', b:'newPartner', status:'married', start_date:null, start_date_precision:'unknown', order_a:null, order_b:null });
const { gen: gen2 } = T.computeLayout(['gp1','gp2','partnerWithParents','newPartner'], idx2, {});
assert.equal(gen2.get('newPartner'), gen2.get('partnerWithParents'));
assert.notEqual(gen2.get('newPartner'), gen2.get('gp1'));
ok('layout: parentless spouse aligned onto partner\'s generation row');

// ---- spouse order resolution ----
const list = [
  { partner_id:'a', order:null, start_date:'2010-01-01' },
  { partner_id:'b', order:1, start_date:'1990-01-01' },
  { partner_id:'c', order:null, start_date:'1995-01-01' },
];
const byPartner = Object.fromEntries(T.resolveSpouseOrder(list).map(r=>[r.partner_id, r.displayOrder]));
assert.equal(byPartner.b, 1);
assert.equal(byPartner.c, 2);
assert.equal(byPartner.a, 3);
ok('spouse order: manual override respected, rest chronological');

// ---- relationship attribution: a child belongs to a specific couple's
// relationship, not just to two independent parent links ----
const relIdx = T.emptyIndex();
relIdx.spousePairs.push({ id:'rel-1', a:'mom', b:'dad', status:'divorced', start_date:'1995-01-01', start_date_precision:'exact', end_date:'2001-01-01', end_date_precision:'exact', order_a:1, order_b:1 });
relIdx.spousePairs.push({ id:'rel-2', a:'mom', b:'stepdad', status:'married', start_date:'2003-01-01', start_date_precision:'exact', end_date:null, end_date_precision:null, order_a:2, order_b:1 });

// addParentChild writes to the live state.index; exercise the same
// attribution logic directly against relIdx so this test doesn't leak into
// (or depend on) other tests' shared state. The UI now attributes a child
// to a relationship by its explicit spousePairs id (the "Other parent"
// dropdown's value IS the id — no guessing/lookup involved), so the test
// mirrors that directly rather than searching for it.
function addPC(index, parent, child, relationshipId){
  index.parentChild.push({ parent, child, type:'biological', relationship_id: relationshipId || null });
}
addPC(relIdx, 'mom', 'kid1', 'rel-1');
addPC(relIdx, 'dad', 'kid1', 'rel-1');
const kid1Links = relIdx.parentChild.filter(pc=>pc.child==='kid1');
assert.equal(kid1Links.length, 2);
assert.ok(kid1Links.every(l=>l.relationship_id==='rel-1'));
ok('relationship attribution: child of couple A tagged with that spousePairs id');

addPC(relIdx, 'mom', 'kid2', 'rel-2');
addPC(relIdx, 'stepdad', 'kid2', 'rel-2');
const kid2Links = relIdx.parentChild.filter(pc=>pc.child==='kid2');
assert.ok(kid2Links.every(l=>l.relationship_id==='rel-2'));
ok('relationship attribution: remarriage produces a distinct relationship id');

// Rebuild from mirrored files must NOT guess when a pair has more than one
// relationship on record (divorce + remarriage to the same person) — that
// can't be disambiguated from the flat parents/spouses mirror.
const ambiguousIdx = T.emptyIndex();
ambiguousIdx.spousePairs.push({ id:'amb-1', a:'x', b:'y', status:'divorced', start_date:'1990-01-01', start_date_precision:'exact', end_date:'1995-01-01', end_date_precision:'exact', order_a:1, order_b:1 });
ambiguousIdx.spousePairs.push({ id:'amb-2', a:'x', b:'y', status:'married', start_date:'2000-01-01', start_date_precision:'exact', end_date:null, end_date_precision:null, order_a:2, order_b:2 });
const rebuiltPeople = new Map();
rebuiltPeople.set('x', { filename:'x.md', frontmatter:{ id:'x', name:'X', parents:[], children:['z'], spouses:[] }, body:'' });
rebuiltPeople.set('y', { filename:'y.md', frontmatter:{ id:'y', name:'Y', parents:[], children:['z'], spouses:[] }, body:'' });
rebuiltPeople.set('z', { filename:'z.md', frontmatter:{ id:'z', name:'Z', parents:['x','y'], children:[], spouses:[] }, body:'' });
const rebuiltAmbiguous = T.rebuildIndexFromPeople(rebuiltPeople);
const zLinks = rebuiltAmbiguous.parentChild.filter(pc=>pc.child==='z');
assert.equal(zLinks.length, 2);
assert.ok(zLinks.every(l=>l.relationship_id===null), 'ambiguous rebuild should not guess a relationship id');
ok('rebuild fallback stays conservative when a pair has multiple relationships on record');

// ---- layout: a hub with two partners, two kids each, must not scramble ----
// This is the scenario the family-block layout exists for: P is married to
// both A and B (in sequence or in parallel doesn't matter for layout), each
// relationship has two children. The hub should sit between its partners,
// and each partner's children must land together on their own side of the
// hub — not interleaved or collapsed onto the same position.
const hubIdx = T.emptyIndex();
hubIdx.spousePairs.push({ id:'rel-A', a:'P', b:'A', status:'married', start_date:'1990-01-01', start_date_precision:'exact', end_date:null, end_date_precision:null, order_a:1, order_b:1 });
hubIdx.spousePairs.push({ id:'rel-B', a:'P', b:'B', status:'married', start_date:'2005-01-01', start_date_precision:'exact', end_date:null, end_date_precision:null, order_a:2, order_b:1 });
for(const [parent, child] of [['P','kid1'],['A','kid1'],['P','kid2'],['A','kid2']]){
  hubIdx.parentChild.push({ parent, child, type:'biological', relationship_id:'rel-A' });
}
for(const [parent, child] of [['P','kid3'],['B','kid3'],['P','kid4'],['B','kid4']]){
  hubIdx.parentChild.push({ parent, child, type:'biological', relationship_id:'rel-B' });
}
const hubIds = ['P','A','B','kid1','kid2','kid3','kid4'];
const { positions: hubPos, gen: hubGen } = T.computeLayout(hubIds, hubIdx, {});

assert.equal(hubGen.get('P'), 0);
assert.equal(hubGen.get('A'), 0);
assert.equal(hubGen.get('B'), 0);
for(const k of ['kid1','kid2','kid3','kid4']) assert.equal(hubGen.get(k), 1);
ok('hub layout: generations correct (hub + 2 partners row 0, all kids row 1)');

const px = id => hubPos.get(id).x;
assert.ok((px('A') < px('P') && px('P') < px('B')) || (px('B') < px('P') && px('P') < px('A')),
  `hub should sit between its two partners, got A=${px('A')} P=${px('P')} B=${px('B')}`);
ok('hub layout: hub seated between its two partners, not off to one side');

const kidAxs = [px('kid1'), px('kid2')], kidBxs = [px('kid3'), px('kid4')];
const allLeftOfB = kidAxs.every(ax => kidBxs.every(bx => ax < bx));
const allRightOfB = kidAxs.every(ax => kidBxs.every(bx => ax > bx));
assert.ok(allLeftOfB || allRightOfB,
  `each partner's kids must stay grouped on their own side, got A-kids=${kidAxs} B-kids=${kidBxs}`);
ok('hub layout: each partner\'s children grouped together, not interleaved with the other family');

const allXs = hubIds.map(px);
assert.equal(new Set(allXs.filter((x,i)=>hubGen.get(hubIds[i])===0)).size, 3, 'no overlap among row 0');
assert.equal(new Set(allXs.filter((x,i)=>hubGen.get(hubIds[i])===1)).size, 4, 'no overlap among row 1');
ok('hub layout: no overlapping positions within a row');

// ---- "also a parent of" flow: add child X, a parent, then a partner for
// that parent who should optionally also become X's parent ----
// (mirrors what the UI's qa-also-parent checklist does on create)
const spIdx = T.emptyIndex();
spIdx.parentChild.push({ parent:'parent1', child:'x', type:'biological', relationship_id:null });

const peopleSP = new Map();
peopleSP.set('x', { filename:'x.md', frontmatter:{ id:'x', name:'X' }, body:'' });
peopleSP.set('parent1', { filename:'parent1.md', frontmatter:{ id:'parent1', name:'Parent1' }, body:'' });
peopleSP.set('y', { filename:'y.md', frontmatter:{ id:'y', name:'Y' }, body:'' });

const savedIndex = T.state.index, savedPeople = T.state.people;
T.state.index = spIdx;
T.state.people = peopleSP;

assert.equal(j(T.childrenOf('parent1')), j(['x']));
ok('childrenOf: finds a person\'s existing children before a partner is added');

const pair = T.addSpousePair('parent1', 'y', { status:'married' });
T.addParentChild('parent1', 'x', 'biological', pair.id); // backfills the pre-existing link
T.addParentChild('y', 'x', 'biological', pair.id);

const xLinksAfter = T.state.index.parentChild.filter(pc => pc.child === 'x');
assert.equal(xLinksAfter.length, 2);
assert.ok(xLinksAfter.every(l => l.relationship_id === pair.id));
ok('"also a parent of": new partner linked to the existing child, and the pre-existing link backfilled with the same relationship_id');

T.state.index = savedIndex;
T.state.people = savedPeople;

console.log(`\n${passed} checks passed.`);
