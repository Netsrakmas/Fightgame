/* Micro Wars — AI player. Pure logic, no DOM (loadable in node for tests). */
'use strict';

if (typeof module !== 'undefined' && typeof window === 'undefined') {
  Object.assign(globalThis, require('./data.js'));
  globalThis.Engine = require('./engine.js');
}

const AI = (() => {
  const E = Engine;

  function unitValue(u) { return UNITS[u.type].cost * (u.hp / 100); }

  /* enemy tiles worth walking toward */
  function objectives(state, me) {
    const caps = [];
    for (const k in state.props) {
      const p = state.props[k];
      if (p.owner !== me) {
        const [x, y] = k.split(',').map(Number);
        caps.push({ x, y, hq: TERRAIN[state.terrain[y][x]].hq, owner: p.owner });
      }
    }
    return caps;
  }

  function nearestEnemy(state, me, x, y) {
    let best = null, bd = Infinity;
    for (const u of state.units) {
      if (u.owner === me) continue;
      const d = E.dist(x, y, u.x, u.y);
      if (d < bd) { bd = d; best = u; }
    }
    return best;
  }

  /* threat at tile: total % damage enemy directs could plausibly do if we stand there */
  function tileThreat(state, me, unit, x, y) {
    let threat = 0;
    for (const e of state.units) {
      if (e.owner === me) continue;
      const base = E.baseDamage(e.type, unit.type);
      if (base === null) continue;
      const range = UNITS[e.type].move + UNITS[e.type].range[1];
      if (E.dist(e.x, e.y, x, y) <= range) threat += base * (e.hp / 100);
    }
    return threat;
  }

  /* flood fill of foot-passable terrain (ignores units) from x,y */
  function footRegion(state, x, y) {
    const seen = new Set([x + ',' + y]);
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= state.w || ny >= state.h) continue;
        const k = nx + ',' + ny;
        if (seen.has(k)) continue;
        if (E.moveCost('INF', state.terrain[ny][nx]) === Infinity) continue;
        seen.add(k);
        stack.push([nx, ny]);
      }
    }
    return seen;
  }

  function regionHasGoal(state, me, region, enemyOnly) {
    for (const k in state.props) {
      const p = state.props[k];
      if (p.owner === me) continue;
      if (enemyOnly && p.owner < 0) continue;
      if (region.has(k)) return true;
    }
    return false;
  }

  /* Build the best plan for one unit. Plan: {score, tile:{x,y}, path, action, target?, dropAt?} */
  function bestPlan(state, unit) {
    const me = unit.owner;
    const reach = E.reachable(state, unit);
    const ud = UNITS[unit.type];
    const plans = [];
    const caps = objectives(state, me);

    // foot units cut off from every capturable property board a transport instead
    const cutOff = ud.capture &&
      !regionHasGoal(state, me, footRegion(state, unit.x, unit.y), false);

    for (const [k, node] of reach) {
      const [x, y] = k.split(',').map(Number);
      const kind = E.stopKind(state, unit, x, y);
      if (kind === 'load' && cutOff) {
        plans.push({ score: 5000, x, y, getPath: () => E.buildPath(reach, x, y), action: 'load' });
        continue;
      }
      if (kind !== 'move') continue;
      const hasMoved = !(x === unit.x && y === unit.y);
      const path = () => E.buildPath(reach, x, y);

      // --- attacks ---
      const targets = E.attackTargets(state, unit, x, y, hasMoved);
      for (const t of targets) {
        const savedX = unit.x, savedY = unit.y;
        unit.x = x; unit.y = y;
        const f = E.forecast(state, unit, t);
        unit.x = savedX; unit.y = savedY;
        if (!f) continue;
        let score = (f.dmg / 100) * UNITS[t.type].cost;
        if (f.dmg >= t.hp) score += UNITS[t.type].cost * 0.35 + 300;
        score -= (f.counter / 100) * UNITS[unit.type].cost * 0.7;
        if (t.cappingAt) score += 1200;                     // interrupt captures
        if (ud.indirect) score += 400;                       // indirects should fire when they can
        if (score > 0) plans.push({ score, x, y, getPath: path, action: 'fire', target: t });
      }

      // --- capture ---
      if (ud.capture) {
        const p = state.props[k];
        if (p && p.owner !== me) {
          const t = TERRAIN[state.terrain[y][x]];
          let score = t.hq ? 1e6 : (t.produces ? 4200 : 3200);
          if (p.capper === unit.id) score += 2500;           // finish what you started
          score -= tileThreat(state, me, unit, x, y) * 4;
          if (score > 0) plans.push({ score, x, y, getPath: path, action: 'capture' });
        }
      }

      // --- retreat to repair ---
      if (unit.hp <= 45) {
        const p = state.props[k];
        const t = TERRAIN[state.terrain[y][x]];
        if (p && p.owner === me && t.repairs && ((t.repairs === 'air') === AIR_UNITS.has(unit.type))) {
          const score = ((MAX_HP - unit.hp) / 100) * ud.cost * 0.5;
          plans.push({ score, x, y, getPath: path, action: 'wait' });
        }
      }

      // --- transports: ferry cargo toward a capture goal, drop nearby ---
      if (ud.carries) {
        if (unit.cargo.length) {
          let goal = null, bd = Infinity;
          for (const c of caps) {
            const d = E.dist(x, y, c.x, c.y) + (c.hq ? -2 : 0);
            if (d < bd) { bd = d; goal = c; }
          }
          if (goal) {
            const cur = E.dist(x, y, goal.x, goal.y);
            if (cur <= 5) {
              const saved = { x: unit.x, y: unit.y };
              unit.x = x; unit.y = y;
              const tiles = E.dropTiles(state, unit);
              unit.x = saved.x; unit.y = saved.y;
              let bestTile = null, btd = Infinity;
              for (const t of tiles) {
                const td = E.dist(t.x, t.y, goal.x, goal.y);
                if (td < btd && td < cur && footRegion(state, t.x, t.y).has(goal.x + ',' + goal.y)) { btd = td; bestTile = t; }
              }
              if (bestTile) plans.push({ score: 4600 - cur * 50, x, y, getPath: path, action: 'drop', dropAt: bestTile });
            }
            plans.push({ score: 90 - cur * 2 - node.cost * 0.1, x, y, getPath: path, action: 'wait' });
          }
        } else {
          // empty transport shadows the nearest foot soldier
          let d = Infinity;
          for (const u of state.units) {
            if (u.owner === me && UNITS[u.type].capture) d = Math.min(d, E.dist(x, y, u.x, u.y));
          }
          if (d < Infinity) plans.push({ score: 20 - d, x, y, getPath: path, action: 'wait' });
        }
        continue;
      }

      // --- advance toward objective ---
      let goal = null;
      if (ud.capture) {
        let bd = Infinity;
        for (const c of caps) {
          let d = E.dist(x, y, c.x, c.y) + (c.hq ? -2 : 0);
          if (d < bd) { bd = d; goal = c; }
        }
      }
      if (!goal) {
        const e = nearestEnemy(state, me, x, y);
        if (e) goal = e;
        else { const hq = caps.find(c => c.hq); if (hq) goal = hq; }
      }
      if (goal) {
        const d = E.dist(x, y, goal.x, goal.y);
        let score = 60 - d * 2 - node.cost * 0.1;
        if (ud.indirect) score -= tileThreat(state, me, unit, x, y) * 0.02;   // indirects hang back a bit
        plans.push({ score, x, y, getPath: path, action: 'wait' });
      }
    }
    if (!plans.length) return { score: 0, x: unit.x, y: unit.y, getPath: () => [{ x: unit.x, y: unit.y }], action: 'wait' };
    plans.sort((a, b) => b.score - a.score);
    return plans[0];
  }

  /* ---------- production ---------- */
  function chooseBuild(state, me, funds, tKind, counts, enemy, landlocked) {
    const enemyAir = enemy.filter(u => AIR_UNITS.has(u.type) && u.type !== 'TCOPTER').length;
    const myAA = counts.AA || 0, myFighters = counts.FIGHTER || 0;
    if (tKind === 'air') {
      const footCount = (counts.INF || 0) + (counts.MECH || 0);
      if (landlocked && !(counts.TCOPTER > 0) && footCount > 0 && funds >= 5000) return 'TCOPTER';
      if (enemyAir > myFighters && funds >= 20000) return 'FIGHTER';
      if (funds >= 22000 && (counts.BOMBER || 0) < 2 && Math.floor(E.rand(state) * 3) === 0) return 'BOMBER';
      if (funds >= 9000) return 'BCOPTER';
      return null;
    }
    // land
    const props = E.countProperties(state, me);
    const infCount = (counts.INF || 0) + (counts.MECH || 0);
    if (landlocked) {
      // ground army can't reach the enemy: keep a small garrison, bank the rest for air power
      const landCount = state.units.filter(u => u.owner === me && !AIR_UNITS.has(u.type)).length;
      if (landCount >= Math.max(3, props) || funds < 1000) return null;
      return 'INF';
    }
    if (infCount < Math.max(2, Math.floor(props * 0.5)) && funds >= 1000) {
      return funds >= 3000 && E.rand(state) < 0.25 ? 'MECH' : 'INF';
    }
    if (enemyAir > myAA + myFighters && funds >= 8000) return 'AA';
    const wish = [];
    if (funds >= 16000) wish.push('MDTANK', 'TANK', 'TANK');
    if (funds >= 15000) wish.push('ROCKET');
    if (funds >= 7000) wish.push('TANK', 'TANK', 'TANK');
    if (funds >= 6000) wish.push('ARTY', 'ARTY');
    if (funds >= 4000 && state.day <= 3) wish.push('RECON');
    if (funds >= 3000) wish.push('MECH');
    if (funds >= 1000) wish.push('INF');
    if (!wish.length) return null;
    return wish[Math.floor(E.rand(state) * wish.length)];
  }

  function produce(state) {
    const me = state.turn;
    const events = [];
    if (state.noProduction) return events;
    const enemy = state.units.filter(u => u.owner !== me);
    const landlockedCache = new Map();  // per-property: enemy unreachable on foot from here
    for (const k in state.props) {
      const p = state.props[k];
      if (p.owner !== me) continue;
      const [x, y] = k.split(',').map(Number);
      const t = TERRAIN[state.terrain[y][x]];
      if (!t.produces || E.unitAt(state, x, y)) continue;
      let landlocked = landlockedCache.get(k);
      if (landlocked === undefined) {
        landlocked = !regionHasGoal(state, me, footRegion(state, x, y), true);
        landlockedCache.set(k, landlocked);
      }
      const counts = {};
      for (const u of state.units) if (u.owner === me) counts[u.type] = (counts[u.type] || 0) + 1;
      const type = chooseBuild(state, me, state.players[me].funds, t.produces, counts, enemy, landlocked);
      if (!type || UNITS[type].cost > state.players[me].funds) continue;
      const u = E.buildUnit(state, x, y, type);
      if (u) events.push({ type: 'build', unit: u.id, utype: type, x, y, owner: me });
    }
    return events;
  }

  /* One AI step: act with one unit, or produce+end turn. Returns {events, done} */
  function step(state) {
    const me = state.turn;
    const pending = state.units.filter(u => u.owner === me && !u.acted);
    if (!pending.length) {
      const events = produce(state);
      return { events, done: true };
    }
    // pick the unit with the strongest plan so high-value moves happen before blockers move
    let best = null;
    for (const u of pending) {
      const plan = bestPlan(state, u);
      if (!best || plan.score > best.plan.score) best = { u, plan };
    }
    const { u, plan } = best;
    const events = [];
    const path = plan.getPath();
    if (plan.action === 'load') {
      const transport = E.unitAt(state, plan.x, plan.y);
      // walk to the tile next to the transport first so fog ambushes apply
      const walk = path.slice(0, -1);
      let trapped = false;
      if (walk.length > 1) {
        const mv = E.doMove(state, u, walk);
        events.push(...mv);
        trapped = mv[0].trapped;
      }
      if (!trapped && transport && transport.cargo.length === 0 && E.dist(u.x, u.y, transport.x, transport.y) === 1) {
        events.push(...E.doLoad(state, u, transport));
      }
      u.acted = true;
      E.invalidateVision(state);
      return { events, done: state.winner !== null };
    }
    if (path.length > 1) {
      const mv = E.doMove(state, u, path);
      events.push(...mv);
      if (mv[0].trapped) {   // ambushed: the planned action no longer applies
        E.invalidateVision(state);
        return { events, done: state.winner !== null };
      }
    }
    E.invalidateVision(state);
    if (plan.action === 'fire' && state.units.includes(plan.target)) {
      events.push(...E.doAttack(state, u, plan.target));
    } else if (plan.action === 'capture') {
      events.push(...E.doCapture(state, u));
    } else if (plan.action === 'drop' && u.cargo.length && !E.unitAt(state, plan.dropAt.x, plan.dropAt.y)) {
      events.push(...E.doDrop(state, u, plan.dropAt.x, plan.dropAt.y));
    } else {
      events.push(...E.doWait(state, u));
    }
    if (state.units.includes(u)) u.acted = true;
    E.invalidateVision(state);
    return { events, done: state.winner !== null };
  }

  return { step, produce, bestPlan };
})();

if (typeof module !== 'undefined') module.exports = AI;
