/* Micro Wars — headless engine/AI tests. Run: node tests/test.js */
'use strict';
const { TERRAIN, CHAR_TERRAIN, UNITS, DAMAGE, MAX_HP, CAPTURE_POINTS } = require('../js/data.js');
const { MAPS, CAMPAIGN } = require('../js/maps.js');
const Engine = require('../js/engine.js');
const AI = require('../js/ai.js');

let failures = 0, checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) { failures++; console.error('FAIL: ' + msg); }
}

/* ---------- map validation ---------- */
for (const m of [...MAPS, ...CAMPAIGN]) {
  const w = m.grid[0].length;
  ok(m.grid.every(r => r.length === w), `${m.id}: all rows length ${w}`);
  for (const row of m.grid) {
    for (const ch of row) ok(CHAR_TERRAIN[ch], `${m.id}: valid char '${ch}'`);
  }
  const flat = m.grid.join('');
  ok(flat.includes('1'), `${m.id}: has P1 HQ`);
  ok(flat.includes('2'), `${m.id}: has P2 HQ`);
  if (!m.noProduction) {
    ok(flat.includes('b'), `${m.id}: P1 has a base`);
    ok(flat.includes('d'), `${m.id}: P2 has a base`);
  }
  const seen = new Set();
  for (const u of m.units || []) {
    ok(UNITS[u.t], `${m.id}: unit type ${u.t}`);
    ok(u.x >= 0 && u.x < w && u.y >= 0 && u.y < m.grid.length, `${m.id}: unit in bounds ${u.x},${u.y}`);
    const k = `${u.x},${u.y}`;
    ok(!seen.has(k), `${m.id}: no stacked units at ${k}`);
    seen.add(k);
    const terr = CHAR_TERRAIN[m.grid[u.y][u.x]].t;
    ok(TERRAIN[terr].move[UNITS[u.t].cls] !== undefined, `${m.id}: ${u.t} can stand on ${terr} at ${k}`);
  }
}

/* ---------- damage table sanity ---------- */
for (const a in DAMAGE) {
  for (const d in DAMAGE[a]) {
    ok(UNITS[d], `damage target ${d} exists`);
    ok(DAMAGE[a][d] > 0 && DAMAGE[a][d] <= 130, `damage ${a}->${d} in range`);
  }
}
ok(!DAMAGE.APC && !DAMAGE.TCOPTER, 'transports cannot attack');

/* ---------- engine basics ---------- */
{
  const g = Engine.makeGame(MAPS[0], { seed: 42, p2AI: true });
  ok(g.w === 12 && g.h === 9, 'border map dims');
  const inf = g.units.find(u => u.owner === 0);
  const reach = Engine.reachable(g, inf);
  ok(reach.size > 5, 'infantry has movement options');
  for (const [k, node] of reach) ok(node.cost <= UNITS.INF.move, 'move cost within range');

  // movement over mountain costs 2 for foot
  ok(Engine.moveCost('INF', 'MOUNTAIN') === 2, 'foot mountain cost');
  ok(Engine.moveCost('TANK', 'MOUNTAIN') === Infinity, 'treads blocked by mountain');
  ok(Engine.moveCost('BOMBER', 'SEA') === 1, 'air over sea');
}

/* ---------- combat ---------- */
{
  const g = Engine.makeGame(MAPS[0], { seed: 7 });
  g.units = [];
  const a = Engine.spawnUnit(g, 'TANK', 0, 4, 4);
  const b = Engine.spawnUnit(g, 'INF', 1, 5, 4);
  const f = Engine.forecast(g, a, b);
  ok(f.dmg >= 50 && f.dmg <= 80, `tank vs inf forecast reasonable (${f.dmg})`);
  const ev = Engine.doAttack(g, a, b);
  ok(ev.some(e => e.type === 'attack'), 'attack event emitted');
  ok(b.hp < MAX_HP || !g.units.includes(b), 'defender damaged');

  // indirect cannot be countered
  g.units = [];
  const art = Engine.spawnUnit(g, 'ARTY', 0, 4, 4);
  const tk = Engine.spawnUnit(g, 'TANK', 1, 6, 4);
  const f2 = Engine.forecast(g, art, tk);
  ok(f2.counter === 0, 'indirect attack draws no counter');
  // artillery min range
  const tgts = Engine.attackTargets(g, art, 4, 4, false);
  ok(tgts.includes(tk), 'artillery hits at range 2');
  const close = Engine.spawnUnit(g, 'RECON', 1, 5, 4);
  ok(!Engine.attackTargets(g, art, 4, 4, false).includes(close), 'artillery cannot hit adjacent');
  ok(Engine.attackTargets(g, art, 4, 4, true).length === 0, 'indirect cannot move and fire');
}

/* ---------- kill + rout ---------- */
{
  const g = Engine.makeGame(MAPS[0], { seed: 3 });
  g.units = [];
  const a = Engine.spawnUnit(g, 'MDTANK', 0, 4, 4);
  const b = Engine.spawnUnit(g, 'INF', 1, 5, 4, 10);
  Engine.doAttack(g, a, b);
  ok(!g.units.includes(b), 'weak unit destroyed');
  ok(g.winner === 0, 'rout detected -> P1 wins');
}

/* ---------- capture ---------- */
{
  const g = Engine.makeGame(MAPS[0], { seed: 3 });
  g.units = [];
  const inf = Engine.spawnUnit(g, 'INF', 0, 5, 3); // neutral city on border map at 5,3
  const p = Engine.propAt(g, 5, 3);
  ok(p && p.owner === -1, 'neutral city present');
  Engine.doCapture(g, inf);
  ok(p.cap === CAPTURE_POINTS - 10, 'capture progress at full hp');
  inf.acted = false;
  Engine.doCapture(g, inf);
  ok(p.owner === 0, 'city captured after 2 turns at 10hp');

  // interrupting capture resets
  const inf2 = Engine.spawnUnit(g, 'INF', 0, 6, 3);
  const p2 = Engine.propAt(g, 6, 3);
  Engine.doCapture(g, inf2);
  ok(p2.cap < CAPTURE_POINTS, 'second capture started');
  Engine.doMove(g, inf2, [{ x: 6, y: 3 }, { x: 6, y: 2 }]);
  ok(p2.cap === CAPTURE_POINTS, 'capture reset after moving away');
}

/* ---------- capture resets on wait / attack ---------- */
{
  const g = Engine.makeGame(MAPS[0], { seed: 3 });
  g.units = [];
  const inf = Engine.spawnUnit(g, 'INF', 0, 5, 3);
  const p = Engine.propAt(g, 5, 3);
  Engine.doCapture(g, inf);
  inf.acted = false;
  Engine.doWait(g, inf);
  ok(p.cap === CAPTURE_POINTS, 'waiting in place resets capture progress');
  Engine.doCapture(g, inf);
  const enemy = Engine.spawnUnit(g, 'INF', 1, 6, 3);
  inf.acted = false;
  Engine.doAttack(g, inf, enemy);
  ok(p.cap === CAPTURE_POINTS, 'attacking resets capture progress');
}

/* ---------- day-1 income parity ---------- */
{
  const g = Engine.makeGame(MAPS[0], { seed: 3, funds: 5000 });
  const p1Start = g.players[0].funds;
  Engine.endTurn(g);
  ok(p1Start === g.players[1].funds, `both players start with income (${p1Start} vs ${g.players[1].funds})`);
}

/* ---------- fog: AI ambush aborts planned action ---------- */
{
  const g = Engine.makeGame(MAPS[0], { seed: 2, fog: true, p1AI: true });
  g.units = [];
  const tank = Engine.spawnUnit(g, 'TANK', 0, 2, 2);
  const victim = Engine.spawnUnit(g, 'INF', 1, 8, 2, 30);
  Engine.spawnUnit(g, 'INF', 1, 6, 2); // hidden blocker on the road
  Engine.invalidateVision(g);
  const r = AI.step(g);
  ok(victim.hp === 30 || Engine.dist(tank.x, tank.y, victim.x, victim.y) <= 1,
    'trapped AI unit does not attack out of range');
}

/* ---------- air units get no mountain vision bonus ---------- */
{
  const g = Engine.makeGame(MAPS[3], { seed: 3, fog: true }); // valley has mountains
  g.units = [];
  for (const k in g.props) g.props[k].owner = -1; // property vision would pollute the check
  Engine.spawnUnit(g, 'BCOPTER', 0, 0, 0); // mountain corner
  const vis = Engine.computeVision(g, 0);
  const far = [...vis].some(k => {
    const [x, y] = k.split(',').map(Number);
    return Math.abs(x) + Math.abs(y) > 4 + 1;
  });
  ok(!far, 'B-Copter on mountain sees only its own vision range');
}

/* ---------- map balance: per-player property parity ---------- */
for (const m of MAPS) {
  const flat = m.grid.join('');
  const n = ch => (flat.match(new RegExp(ch, 'g')) || []).length;
  ok(n('b') === n('d'), `${m.id}: base parity (${n('b')} vs ${n('d')})`);
  ok(n('c') === n('e'), `${m.id}: city parity (${n('c')} vs ${n('e')})`);
  ok(n('p') === n('q'), `${m.id}: airport parity (${n('p')} vs ${n('q')})`);
}

/* ---------- HQ win ---------- */
{
  const g = Engine.makeGame(MAPS[0], { seed: 3 });
  g.units = [];
  const inf = Engine.spawnUnit(g, 'MECH', 0, 11, 0); // P2 HQ
  const p = Engine.propAt(g, 11, 0);
  for (let i = 0; i < 4 && g.winner === null; i++) { inf.acted = false; Engine.doCapture(g, inf); }
  ok(g.winner === 0, 'HQ capture wins the game');
}

/* ---------- economy / end turn ---------- */
{
  const g = Engine.makeGame(MAPS[0], { seed: 3 });
  const before = g.players[1].funds;
  const props1 = Engine.countProperties(g, 1);
  Engine.endTurn(g);
  ok(g.turn === 1, 'turn passed to P2');
  ok(g.players[1].funds === before + props1 * 1000, 'income granted');
  Engine.endTurn(g);
  ok(g.turn === 0 && g.day === 2, 'day advanced');
}

/* ---------- repair ---------- */
{
  const g = Engine.makeGame(MAPS[0], { seed: 3 });
  g.units = [];
  const hq = g.grid;
  const u = Engine.spawnUnit(g, 'TANK', 1, 11, 0, 50); // P2 HQ tile
  g.players[1].funds = 100000;
  Engine.endTurn(g); // now P2's turn start
  ok(u.hp === 70, `repaired 2HP on HQ (got ${u.hp})`);
}

/* ---------- build ---------- */
{
  const g = Engine.makeGame(MAPS[0], { seed: 3 });
  g.units = [];
  g.players[0].funds = 7000;
  const list = Engine.buildableAt(g, 1, 0); // P1 base
  ok(list && list.includes('TANK') && !list.includes('BOMBER'), 'base builds land only');
  const u = Engine.buildUnit(g, 1, 0, 'TANK');
  ok(u && u.acted && g.players[0].funds === 0, 'tank built, funds spent');
  ok(Engine.buildUnit(g, 1, 0, 'INF') === null, 'cannot build on occupied tile');
}

/* ---------- load / drop / join ---------- */
{
  const g = Engine.makeGame(MAPS[0], { seed: 3 });
  g.units = [];
  const apc = Engine.spawnUnit(g, 'APC', 0, 4, 4);
  const inf = Engine.spawnUnit(g, 'INF', 0, 5, 4);
  ok(Engine.stopKind(g, inf, 4, 4) === 'load', 'infantry can load into APC');
  Engine.doLoad(g, inf, apc);
  ok(apc.cargo.length === 1 && !g.units.includes(inf), 'loaded');
  const tiles = Engine.dropTiles(g, apc);
  ok(tiles.length > 0, 'drop tiles available');
  Engine.doDrop(g, apc, tiles[0].x, tiles[0].y);
  ok(g.units.includes(inf) && apc.cargo.length === 0, 'dropped');

  const i1 = Engine.spawnUnit(g, 'INF', 0, 7, 7, 40);
  const i2 = Engine.spawnUnit(g, 'INF', 0, 8, 7, 90);
  ok(Engine.stopKind(g, i1, 8, 7) === 'join', 'damaged units can join');
  Engine.doJoin(g, i1, i2);
  ok(i2.hp === 100 && !g.units.includes(i1), 'join capped at 100');
  ok(g.players[0].funds > 5000, 'join overflow refunded');
}

/* ---------- fog ---------- */
{
  const g = Engine.makeGame(MAPS[0], { seed: 3, fog: true });
  const vis = Engine.computeVision(g, 0);
  ok(vis.size > 0, 'vision computed');
  ok(vis.has('0,0'), 'own HQ area visible');
}

/* ---------- serialization round-trip ---------- */
{
  const g = Engine.makeGame(MAPS[1], { seed: 9 });
  const j = Engine.serialize(g);
  const g2 = Engine.deserialize(j);
  ok(g2.units.length === g.units.length && g2.w === g.w, 'serialize round trip');
}

/* ---------- full AI vs AI games on every map ---------- */
for (const m of MAPS) {
  const g = Engine.makeGame(m, { seed: 1234, p1AI: true, p2AI: true });
  let steps = 0;
  const MAX_STEPS = 20000;
  try {
    while (g.winner === null && g.day <= 60 && steps < MAX_STEPS) {
      const r = AI.step(g);
      if (r.done && g.winner === null) Engine.endTurn(g);
      steps++;
    }
  } catch (e) {
    failures++; console.error(`FAIL: AI game crashed on ${m.id}: ${e.stack}`);
  }
  ok(steps < MAX_STEPS, `${m.id}: AI game did not stall (steps=${steps})`);
  console.log(`  AI vs AI on ${m.id}: ${g.winner !== null ? 'P' + (g.winner + 1) + ' wins day ' + g.day : 'no winner by day ' + g.day} (${steps} steps)`);
}

/* ---------- campaign missions playable by AI both sides ---------- */
for (const m of CAMPAIGN) {
  const g = Engine.makeGame(m, { seed: 55, p1AI: true, p2AI: true });
  let steps = 0;
  try {
    while (g.winner === null && g.day <= 60 && steps < 20000) {
      const r = AI.step(g);
      if (r.done && g.winner === null) Engine.endTurn(g);
      steps++;
    }
  } catch (e) {
    failures++; console.error(`FAIL: campaign ${m.id} crashed: ${e.stack}`);
  }
  console.log(`  campaign ${m.id}: ${g.winner !== null ? 'P' + (g.winner + 1) + ' wins day ' + g.day : 'draw by day ' + g.day}`);
}

console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
