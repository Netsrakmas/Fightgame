/* Micro Wars — rules engine. Pure logic, no DOM (loadable in node for tests). */
'use strict';

if (typeof module !== 'undefined' && typeof window === 'undefined') {
  Object.assign(globalThis, require('./data.js'));
}

const Engine = (() => {

  /* ---------- RNG (deterministic, save-friendly) ---------- */
  function rand(state) {
    state.seed = (state.seed + 0x6D2B79F5) | 0;
    let t = state.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /* ---------- game construction ---------- */
  function makeGame(mapDef, opts = {}) {
    const grid = mapDef.grid;
    const h = grid.length, w = grid[0].length;
    const state = {
      w, h,
      terrain: [],
      props: {},          // "x,y" -> {owner, cap, capper}
      units: [],
      players: [
        { funds: (mapDef.startFunds ? mapDef.startFunds[0] : (opts.funds ?? 5000)), isAI: !!opts.p1AI, built: 0, lost: 0, killed: 0 },
        { funds: (mapDef.startFunds ? mapDef.startFunds[1] : (opts.funds ?? 5000)), isAI: opts.p2AI !== false, built: 0, lost: 0, killed: 0 },
      ],
      turn: 0, day: 1,
      fog: !!opts.fog,
      seed: (opts.seed ?? ((Math.random() * 0xffffffff) | 0)) | 0,
      nextId: 1,
      winner: null,
      noProduction: !!mapDef.noProduction,
    };
    for (let y = 0; y < h; y++) {
      const row = [];
      for (let x = 0; x < w; x++) {
        const ch = grid[y][x];
        const def = CHAR_TERRAIN[ch];
        if (!def) throw new Error(`bad map char '${ch}' at ${x},${y} in ${mapDef.id}`);
        row.push(def.t);
        if (def.owner !== undefined) state.props[`${x},${y}`] = { owner: def.owner, cap: CAPTURE_POINTS, capper: null };
      }
      state.terrain.push(row);
    }
    for (const u of (mapDef.units || [])) {
      spawnUnit(state, u.t, u.p, u.x, u.y, u.hp ?? MAX_HP);
    }
    // P1 gets its day-1 income here since endTurn() only pays the player whose turn starts
    state.players[0].funds += countProperties(state, 0) * INCOME_PER_PROPERTY;
    return state;
  }

  function spawnUnit(state, type, owner, x, y, hp = MAX_HP) {
    const u = { id: state.nextId++, type, owner, x, y, hp, acted: false, cargo: [] };
    state.units.push(u);
    return u;
  }

  /* ---------- queries ---------- */
  const key = (x, y) => `${x},${y}`;
  const inBounds = (s, x, y) => x >= 0 && y >= 0 && x < s.w && y < s.h;
  const terrainAt = (s, x, y) => TERRAIN[s.terrain[y][x]];
  const unitAt = (s, x, y) => s.units.find(u => u.x === x && u.y === y) || null;
  const unitById = (s, id) => s.units.find(u => u.id === id) || null;
  const propAt = (s, x, y) => s.props[key(x, y)] || null;
  const displayHP = (u) => Math.ceil(u.hp / 10);
  const dist = (x1, y1, x2, y2) => Math.abs(x1 - x2) + Math.abs(y1 - y2);

  function moveCost(unitType, terrId) {
    const c = TERRAIN[terrId].move[UNITS[unitType].cls];
    return c === undefined ? Infinity : c;
  }

  /* ---------- movement ---------- */
  /* Dijkstra. Returns Map key -> {cost, from}. Friendly units passable, enemies block. */
  function reachable(state, unit) {
    const res = new Map();
    const start = key(unit.x, unit.y);
    res.set(start, { cost: 0, from: null });
    const frontier = [{ x: unit.x, y: unit.y, cost: 0 }];
    while (frontier.length) {
      let bi = 0;
      for (let i = 1; i < frontier.length; i++) if (frontier[i].cost < frontier[bi].cost) bi = i;
      const cur = frontier.splice(bi, 1)[0];
      const curKey = key(cur.x, cur.y);
      if (res.get(curKey).cost < cur.cost) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (!inBounds(state, nx, ny)) continue;
        const step = moveCost(unit.type, state.terrain[ny][nx]);
        if (step === Infinity) continue;
        const occ = unitAt(state, nx, ny);
        if (occ && occ.owner !== unit.owner) {
          // in fog, unseen enemies don't block (they ambush); without fog they always block
          if (!state.fog || isVisibleTo(state, unit.owner, nx, ny)) continue;
        }
        const nc = cur.cost + step;
        if (nc > UNITS[unit.type].move) continue;
        const prev = res.get(key(nx, ny));
        if (!prev || nc < prev.cost) {
          res.set(key(nx, ny), { cost: nc, from: curKey });
          frontier.push({ x: nx, y: ny, cost: nc });
        }
      }
    }
    return res;
  }

  function buildPath(reach, x, y) {
    const path = [];
    let k = key(x, y);
    while (k) {
      const [px, py] = k.split(',').map(Number);
      path.unshift({ x: px, y: py });
      k = reach.get(k).from;
    }
    return path;
  }

  /* What kind of stop is possible at x,y for `unit`: 'move' | 'load' | 'join' | null */
  function stopKind(state, unit, x, y) {
    const occ = unitAt(state, x, y);
    if (!occ || occ === unit) return 'move';
    if (occ.owner !== unit.owner) {
      // in fog an unseen enemy must not leave a hole in the move overlay; the
      // actual move triggers the ambush rule in doMove instead
      if (state.fog && !isVisibleTo(state, unit.owner, x, y)) return 'move';
      return null;
    }
    const od = UNITS[occ.type];
    if (od.carries && od.carries.includes(unit.type) && occ.cargo.length < 1) return 'load';
    if (occ.type === unit.type && (occ.hp < MAX_HP || unit.hp < MAX_HP) && occ.cargo.length === 0 && unit.cargo.length === 0) return 'join';
    return null;
  }

  /* ---------- combat ---------- */
  function baseDamage(attType, defType) {
    const row = DAMAGE[attType];
    return row ? (row[defType] ?? null) : null;
  }

  /* Forecast (no luck). attX/attY: tile the attacker fires from. */
  function forecast(state, att, def, attX = att.x, attY = att.y) {
    const base = baseDamage(att.type, def.type);
    if (base === null) return null;
    const dmg = calcDamage(base, att.hp, def, state);
    let counter = 0;
    const defRange = UNITS[def.type].range;
    if (dmg < def.hp && !UNITS[def.type].indirect && defRange[1] >= 1 &&
        dist(attX, attY, def.x, def.y) === 1 && baseDamage(def.type, att.type) !== null) {
      const defHpAfter = def.hp - dmg;
      counter = calcCounterDamage(baseDamage(def.type, att.type), defHpAfter, att, state, attX, attY);
    }
    return { dmg: Math.min(dmg, def.hp), counter: Math.min(counter, att.hp) };
  }

  function terrainStars(state, u) {
    if (AIR_UNITS.has(u.type)) return 0;
    return terrainAt(state, u.x, u.y).def;
  }

  function calcDamage(base, attHp, def, state) {
    const stars = terrainStars(state, def);
    return Math.max(1, Math.floor(base * (attHp / 100) * (100 - stars * displayHP(def)) / 100));
  }

  function calcCounterDamage(base, defHp, att, state, attX, attY) {
    const stars = AIR_UNITS.has(att.type) ? 0 : TERRAIN[state.terrain[attY][attX]].def;
    const attDisp = Math.ceil(att.hp / 10);
    return Math.max(1, Math.floor(base * (defHp / 100) * (100 - stars * attDisp) / 100));
  }

  /* enemies attackable by `unit` if it were standing at (x,y); hasMoved matters for indirect */
  function attackTargets(state, unit, x, y, hasMoved) {
    const ud = UNITS[unit.type];
    if (ud.range[1] < 1) return [];
    if (ud.indirect && hasMoved) return [];
    const out = [];
    for (const e of state.units) {
      if (e.owner === unit.owner) continue;
      const d = dist(x, y, e.x, e.y);
      if (d < ud.range[0] || d > ud.range[1]) continue;
      if (baseDamage(unit.type, e.type) === null) continue;
      if (state.fog && !isVisibleTo(state, unit.owner, e.x, e.y)) continue;
      out.push(e);
    }
    return out;
  }

  /* ---------- actions (mutate state, return events for animation) ---------- */
  function stopCapture(state, unit) {
    if (unit.cappingAt) {
      const p = state.props[unit.cappingAt];
      if (p && p.capper === unit.id) { p.cap = CAPTURE_POINTS; p.capper = null; }
      unit.cappingAt = null;
    }
  }

  /* Moves along path. With fog on, an unseen enemy on the path triggers an
     ambush: the unit stops on the previous tile and its turn ends. */
  function doMove(state, unit, path) {
    const events = [];
    let stop = path.length - 1;
    let trapped = false;
    for (let i = 1; i < path.length; i++) {
      const occ = unitAt(state, path[i].x, path[i].y);
      if (occ && occ.owner !== unit.owner) { stop = i - 1; trapped = true; break; }
    }
    const used = path.slice(0, stop + 1);
    const dest = used[used.length - 1];
    if (dest.x !== unit.x || dest.y !== unit.y) stopCapture(state, unit);
    events.push({ type: 'move', unit: unit.id, path: used, trapped });
    unit.x = dest.x; unit.y = dest.y;
    if (trapped) unit.acted = true;
    return events;
  }

  function killUnit(state, unit, events) {
    stopCapture(state, unit);
    state.players[unit.owner].lost += 1 + unit.cargo.length;
    state.players[1 - unit.owner].killed += 1 + unit.cargo.length;
    state.units = state.units.filter(u => u !== unit);
    events.push({ type: 'die', unit: unit.id, x: unit.x, y: unit.y, owner: unit.owner, utype: unit.type, cargo: unit.cargo.length });
    checkRout(state, events);
  }

  function doAttack(state, att, def) {
    const events = [];
    stopCapture(state, att);   // attacking abandons any capture in progress
    const f = forecast(state, att, def);
    const luck = Math.floor(rand(state) * 10 * (att.hp / 100));
    const dmg = Math.min(def.hp, f.dmg + luck);
    def.hp -= dmg;
    events.push({ type: 'attack', from: att.id, to: def.id, dmg, x: def.x, y: def.y });
    if (def.hp <= 0) {
      killUnit(state, def, events);
    } else if (f.counter > 0) {
      // recompute from the defender's actual remaining HP (luck may differ from forecast)
      const cBase = baseDamage(def.type, att.type);
      const counter = calcCounterDamage(cBase, def.hp, att, state, att.x, att.y);
      const cLuck = Math.floor(rand(state) * 10 * (def.hp / 100));
      const cdmg = Math.min(att.hp, counter + cLuck);
      att.hp -= cdmg;
      events.push({ type: 'attack', from: def.id, to: att.id, dmg: cdmg, counter: true, x: att.x, y: att.y });
      if (att.hp <= 0) killUnit(state, att, events);
    }
    if (state.units.includes(att)) att.acted = true;
    return events;
  }

  function doCapture(state, unit) {
    const events = [];
    const p = propAt(state, unit.x, unit.y);
    if (!p) return events;
    if (p.capper !== unit.id) { p.cap = CAPTURE_POINTS; p.capper = unit.id; }
    p.cap -= displayHP(unit);
    unit.cappingAt = key(unit.x, unit.y);
    unit.acted = true;
    if (p.cap <= 0) {
      p.owner = unit.owner; p.cap = CAPTURE_POINTS; p.capper = null; unit.cappingAt = null;
      events.push({ type: 'captured', x: unit.x, y: unit.y, owner: unit.owner });
      if (terrainAt(state, unit.x, unit.y).hq) {
        state.winner = unit.owner;
        events.push({ type: 'win', player: unit.owner, how: 'hq' });
      }
    } else {
      events.push({ type: 'capturing', x: unit.x, y: unit.y, left: p.cap });
    }
    return events;
  }

  function doWait(state, unit) {
    stopCapture(state, unit);  // waiting abandons any capture in progress
    unit.acted = true;
    return [{ type: 'wait', unit: unit.id }];
  }

  function doLoad(state, unit, transport) {
    stopCapture(state, unit);
    state.units = state.units.filter(u => u !== unit);
    unit.x = transport.x; unit.y = transport.y;
    transport.cargo.push(unit);
    return [{ type: 'load', unit: unit.id, into: transport.id }];
  }

  function doDrop(state, transport, cx, cy) {
    const events = [];
    const cargo = transport.cargo.pop();
    cargo.x = cx; cargo.y = cy; cargo.acted = true;
    state.units.push(cargo);
    transport.acted = true;
    events.push({ type: 'drop', unit: cargo.id, from: transport.id, x: cx, y: cy });
    return events;
  }

  function dropTiles(state, transport) {
    if (!transport.cargo.length) return [];
    const cargo = transport.cargo[0];
    const out = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = transport.x + dx, ny = transport.y + dy;
      if (!inBounds(state, nx, ny)) continue;
      if (moveCost(cargo.type, state.terrain[ny][nx]) === Infinity) continue;
      if (unitAt(state, nx, ny)) continue;
      out.push({ x: nx, y: ny });
    }
    return out;
  }

  function doJoin(state, unit, other) {
    stopCapture(state, unit);
    const total = unit.hp + other.hp;
    const refund = total > MAX_HP ? Math.floor(UNITS[unit.type].cost * (total - MAX_HP) / 100) : 0;
    other.hp = Math.min(MAX_HP, total);
    other.acted = true;
    state.players[unit.owner].funds += refund;
    state.units = state.units.filter(u => u !== unit);
    return [{ type: 'join', unit: unit.id, into: other.id, refund }];
  }

  function buildUnit(state, x, y, type) {
    const p = state.players[state.turn];
    const cost = UNITS[type].cost;
    if (cost > p.funds) return null;
    if (unitAt(state, x, y)) return null;
    p.funds -= cost;
    p.built++;
    const u = spawnUnit(state, type, state.turn, x, y);
    u.acted = true;
    return u;
  }

  function buildableAt(state, x, y) {
    if (state.noProduction) return null;
    const p = propAt(state, x, y);
    if (!p || p.owner !== state.turn) return null;
    const t = terrainAt(state, x, y);
    if (!t.produces || unitAt(state, x, y)) return null;
    const list = Object.keys(UNITS).filter(id =>
      t.produces === 'air' ? AIR_UNITS.has(id) : !AIR_UNITS.has(id));
    return list;
  }

  /* actions available to `unit` if it stops at (x,y) having taken `path` */
  function possibleActions(state, unit, x, y, path) {
    const hasMoved = path.length > 1;
    const actions = [];
    if (attackTargets(state, unit, x, y, hasMoved).length) actions.push('fire');
    if (UNITS[unit.type].capture) {
      const p = state.props[key(x, y)];
      if (p && p.owner !== unit.owner) actions.push('capture');
    }
    if (unit.cargo.length) {
      const saved = { x: unit.x, y: unit.y };
      unit.x = x; unit.y = y;
      const tiles = dropTiles(state, unit);
      unit.x = saved.x; unit.y = saved.y;
      if (tiles.length) actions.push('drop');
    }
    actions.push('wait');
    return actions;
  }

  /* ---------- turn flow ---------- */
  function checkRout(state, events) {
    if (state.winner !== null) return;
    for (let p = 0; p < state.players.length; p++) {
      if (!state.units.some(u => u.owner === p)) {
        state.winner = 1 - p;
        events.push({ type: 'win', player: 1 - p, how: 'rout' });
        return;
      }
    }
  }

  function countProperties(state, player) {
    let n = 0;
    for (const k in state.props) if (state.props[k].owner === player) n++;
    return n;
  }

  function endTurn(state) {
    const events = [];
    state.turn = (state.turn + 1) % state.players.length;
    if (state.turn === 0) { state.day++; }
    const p = state.players[state.turn];
    const income = countProperties(state, state.turn) * INCOME_PER_PROPERTY;
    p.funds += income;
    events.push({ type: 'day', day: state.day, turn: state.turn, income });
    // repairs & reactivation
    for (const u of state.units) {
      if (u.owner !== state.turn) continue;
      u.acted = false;
      const prop = propAt(state, u.x, u.y);
      const t = terrainAt(state, u.x, u.y);
      if (prop && prop.owner === u.owner && t.repairs) {
        const isAir = AIR_UNITS.has(u.type);
        if ((t.repairs === 'air') === isAir && u.hp < MAX_HP) {
          let heal = Math.min(REPAIR_HP, MAX_HP - u.hp);
          const perTen = UNITS[u.type].cost / 10;
          while (heal > 0 && p.funds < Math.ceil(perTen * heal / 10)) heal -= 10;
          if (heal > 0) {
            p.funds -= Math.ceil(perTen * heal / 10);
            u.hp += heal;
            events.push({ type: 'repair', unit: u.id, x: u.x, y: u.y, heal });
          }
        }
      }
    }
    return events;
  }

  /* ---------- fog of war ---------- */
  function computeVision(state, player) {
    const vis = new Set();
    const addRadius = (cx, cy, r) => {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r + Math.abs(dy); dx <= r - Math.abs(dy); dx++) {
          const x = cx + dx, y = cy + dy;
          if (!inBounds(state, x, y)) continue;
          const d = Math.abs(dx) + Math.abs(dy);
          if (TERRAIN[state.terrain[y][x]].hides && d > 1) continue; // woods only seen adjacent
          vis.add(key(x, y));
        }
      }
    };
    for (const u of state.units) {
      if (u.owner !== player) continue;
      let r = UNITS[u.type].vision;
      if (terrainAt(state, u.x, u.y).visionBonus && !AIR_UNITS.has(u.type)) r += terrainAt(state, u.x, u.y).visionBonus;
      addRadius(u.x, u.y, r);
    }
    for (const k in state.props) {
      if (state.props[k].owner === player) {
        const [x, y] = k.split(',').map(Number);
        addRadius(x, y, 1);
      }
    }
    return vis;
  }

  function isVisibleTo(state, player, x, y) {
    if (!state.fog) return true;
    if (!state._visCache || state._visCache.player !== player || state._visCache.stamp !== state._visStamp) {
      state._visCache = { player, stamp: state._visStamp, set: computeVision(state, player) };
    }
    return state._visCache.set.has(key(x, y));
  }

  function invalidateVision(state) { state._visStamp = (state._visStamp || 0) + 1; }

  /* ---------- (de)serialization ---------- */
  function serialize(state) {
    const { _visCache, _visStamp, ...rest } = state;
    return JSON.stringify(rest);
  }
  function deserialize(json) { return JSON.parse(json); }

  return {
    makeGame, spawnUnit, rand,
    key, inBounds, terrainAt, unitAt, unitById, propAt, displayHP, dist, moveCost,
    reachable, buildPath, stopKind,
    baseDamage, forecast, attackTargets,
    doMove, doAttack, doCapture, doWait, doLoad, doDrop, doJoin, dropTiles,
    buildUnit, buildableAt, possibleActions,
    endTurn, checkRout, countProperties,
    computeVision, isVisibleTo, invalidateVision,
    serialize, deserialize,
  };
})();

if (typeof module !== 'undefined') module.exports = Engine;
