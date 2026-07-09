/* Micro Wars — AI player. Pure logic, no DOM (loadable in node for tests). */
'use strict';

if (typeof require !== 'undefined' && typeof window === 'undefined') {
  var Engine = require('./engine.js');
  var { TERRAIN, UNITS, AIR_UNITS, DAMAGE, CAPTURE_POINTS, MAX_HP } = require('./data.js');
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

  /* Build the best plan for one unit. Plan: {score, tile:{x,y}, path, action, target?, buildType?} */
  function bestPlan(state, unit) {
    const me = unit.owner;
    const reach = E.reachable(state, unit);
    const ud = UNITS[unit.type];
    const plans = [];
    const caps = objectives(state, me);

    for (const [k, node] of reach) {
      const [x, y] = k.split(',').map(Number);
      const kind = E.stopKind(state, unit, x, y);
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
        if (unit.type === 'APC' || unit.type === 'TCOPTER') score = 30 - d;   // transports trail behind
        plans.push({ score, x, y, getPath: path, action: 'wait' });
      }
    }
    if (!plans.length) return { score: 0, x: unit.x, y: unit.y, getPath: () => [{ x: unit.x, y: unit.y }], action: 'wait' };
    plans.sort((a, b) => b.score - a.score);
    return plans[0];
  }

  /* ---------- production ---------- */
  function chooseBuild(state, me, funds, tKind, counts, enemy) {
    const enemyAir = enemy.filter(u => AIR_UNITS.has(u.type) && u.type !== 'TCOPTER').length;
    const myAA = counts.AA || 0, myFighters = counts.FIGHTER || 0;
    if (tKind === 'air') {
      if (enemyAir > myFighters && funds >= 20000) return 'FIGHTER';
      if (funds >= 22000 && (counts.BOMBER || 0) < 2 && Math.floor(E.rand(state) * 3) === 0) return 'BOMBER';
      if (funds >= 9000) return 'BCOPTER';
      return null;
    }
    // land
    const props = E.countProperties(state, me);
    const infCount = (counts.INF || 0) + (counts.MECH || 0);
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
    for (const k in state.props) {
      const p = state.props[k];
      if (p.owner !== me) continue;
      const [x, y] = k.split(',').map(Number);
      const t = TERRAIN[state.terrain[y][x]];
      if (!t.produces || E.unitAt(state, x, y)) continue;
      const counts = {};
      for (const u of state.units) if (u.owner === me) counts[u.type] = (counts[u.type] || 0) + 1;
      const type = chooseBuild(state, me, state.players[me].funds, t.produces, counts, enemy);
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
    if (path.length > 1) events.push(...E.doMove(state, u, path));
    E.invalidateVision(state);
    if (plan.action === 'fire' && state.units.includes(plan.target)) {
      events.push(...E.doAttack(state, u, plan.target));
    } else if (plan.action === 'capture') {
      events.push(...E.doCapture(state, u));
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
