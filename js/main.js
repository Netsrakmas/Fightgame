/* Micro Wars — UI, input, screens and game flow. */
'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  /* ================= global app state ================= */
  let game = null;            // engine state
  let meta = null;            // {mode:'skirmish'|'campaign'|'hotseat', mapId, missionIdx, fog}
  let mode = 'idle';          // idle | selected | menu | targeting | dropping | building | danger | ai | locked | over
  let sel = null;             // selected unit
  let reach = null;           // Map from Engine.reachable
  let reachTiles = null;      // Set of stoppable keys
  let plannedPath = null;
  let plannedDest = null;
  let targets = [];
  let dropTiles = [];
  let dangerTiles = null;
  let cursor = null;
  let undoSnapshot = null;
  let aiSpeed = 1;
  let nextUnitIdx = -1;
  let animating = false;
  let animatingUnit = null;
  let gameGen = 0;            // bumped whenever `game` is replaced; async flows bail if it changed
  let raf = 0, lastT = 0;
  let visionCache = null, visionDirty = true;

  const SAVE_KEY = 'mw_save';
  const PROGRESS_KEY = 'mw_campaign';

  /* ================= screens ================= */
  function show(id) {
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  }

  function unlockedMissions() { return Math.min(CAMPAIGN.length, parseInt(localStorage.getItem(PROGRESS_KEY) || '0', 10) + 1); }

  function buildMenus() {
    // map list
    const list = $('#map-list');
    list.innerHTML = '';
    for (const m of MAPS) {
      const el = document.createElement('button');
      el.className = 'row-btn';
      el.innerHTML = `<div class="row-title">${m.name} <span class="dim">${m.grid[0].length}×${m.grid.length}</span></div><div class="row-sub">${m.desc}</div>`;
      el.onclick = () => { Sound.sfx.select(); startSkirmish(m); };
      list.appendChild(el);
    }
    // campaign list
    const clist = $('#campaign-list');
    clist.innerHTML = '';
    const unlocked = unlockedMissions();
    CAMPAIGN.forEach((m, i) => {
      const el = document.createElement('button');
      el.className = 'row-btn';
      const locked = i >= unlocked;
      if (locked) el.classList.add('locked');
      el.innerHTML = `<div class="row-title">${locked ? '🔒' : (i < unlocked - 1 ? '★' : '▶')} Mission ${i + 1}: ${m.name}</div><div class="row-sub">${locked ? 'Complete previous missions to unlock.' : m.objective}</div>`;
      el.onclick = () => { if (!locked) { Sound.sfx.select(); startCampaign(i); } else Sound.sfx.cancel(); };
      clist.appendChild(el);
    });
    $('#btn-continue').style.display = localStorage.getItem(SAVE_KEY) ? '' : 'none';
  }

  /* ================= game start ================= */
  function startSkirmish(mapDef) {
    const fog = $('#opt-fog').checked;
    const twoP = $('#opt-2p').checked;
    meta = { mode: twoP ? 'hotseat' : 'skirmish', mapId: mapDef.id, fog };
    game = Engine.makeGame(mapDef, { fog, p2AI: !twoP, funds: 5000 });
    beginGame();
  }

  function startCampaign(idx) {
    meta = { mode: 'campaign', missionIdx: idx, fog: false };
    game = Engine.makeGame(CAMPAIGN[idx], { fog: false, p2AI: true });
    showIntro(CAMPAIGN[idx], beginGame);
  }

  function showIntro(mission, then) {
    const box = $('#intro');
    $('#intro-title').textContent = `Mission ${CAMPAIGN.indexOf(mission) + 1}: ${mission.name}`;
    $('#intro-text').innerHTML = mission.intro.map(l => `<p>${l}</p>`).join('') +
      `<p class="objective">★ ${mission.objective}</p>`;
    box.classList.add('active');
    $('#intro-start').onclick = () => { Sound.sfx.select(); box.classList.remove('active'); then(); };
  }

  function beginGame() {
    gameGen++;
    const gen = gameGen;
    show('screen-game');
    Sound.playSong('battle');
    mode = 'idle';
    animating = false; animatingUnit = null; undoSnapshot = null;
    sel = null; reach = null; reachTiles = null; plannedPath = null; targets = []; dropTiles = []; dangerTiles = null; cursor = null;
    closePopups();
    Renderer.animPos.clear();
    Renderer.resize();
    Renderer.fitCamera(game);
    Renderer.invalidateMap();
    visionDirty = true;
    updateHUD();
    saveGame();
    banner(dayTitle(), teamColor(game.turn), () => {
      if (gen === gameGen && game && isAITurn()) runAITurn();
    });
    startLoop();
  }

  function dayTitle() { return `Day ${game.day} — ${ARMY[game.turn].name}`; }
  function teamColor(p) { return ARMY[p].color; }
  const isAITurn = () => game.players[game.turn].isAI && game.winner === null;
  const humanPOV = () => {
    if (meta.mode === 'hotseat') return game.turn;
    return game.players[0].isAI ? 1 : 0;
  };

  /* ================= save / load ================= */
  function saveGame() {
    if (!game || game.winner !== null) { localStorage.removeItem(SAVE_KEY); return; }
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ meta, state: Engine.serialize(game) }));
    } catch (e) { /* storage full/blocked */ }
  }

  function continueGame() {
    try {
      const data = JSON.parse(localStorage.getItem(SAVE_KEY));
      meta = data.meta;
      game = Engine.deserialize(data.state);
      beginGame();
    } catch (e) {
      localStorage.removeItem(SAVE_KEY);
      buildMenus();
    }
  }

  /* ================= HUD ================= */
  function updateHUD() {
    const p = game.players[game.turn];
    $('#hud-day').textContent = 'Day ' + game.day;
    $('#hud-funds').textContent = 'G ' + p.funds.toLocaleString();
    const chip = $('#hud-army');
    chip.textContent = ARMY[game.turn].name;
    chip.style.background = ARMY[game.turn].color;
    $('#btn-endturn').disabled = isAITurn() || animating;
    $('#btn-ai-speed').style.display = isAITurn() ? '' : 'none';
    $('#btn-next').style.display = isAITurn() ? 'none' : '';
  }

  function setInfo(html) { $('#hud-info').innerHTML = html || '&nbsp;'; }

  function describeTile(x, y) {
    if (!Engine.inBounds(game, x, y)) return '';
    const vis = getVision();
    const t = Engine.terrainAt(game, x, y);
    const p = Engine.propAt(game, x, y);
    let owner = p && p.owner >= 0 ? ` <span class="chip" style="background:${ARMY[p.owner].color}">${ARMY[p.owner].name}</span>` : '';
    let s = `<b>${t.name}</b>${owner} <span class="dim">DEF ${'★'.repeat(t.def)}${t.def ? '' : '—'}</span>`;
    const u = Engine.unitAt(game, x, y);
    if (u && (!vis || vis.has(x + ',' + y) || u.owner === humanPOV())) {
      const ud = UNITS[u.type];
      const rng = ud.range[1] ? (ud.range[0] === ud.range[1] ? ud.range[1] : `${ud.range[0]}–${ud.range[1]}`) : '—';
      s = `<span class="chip" style="background:${ARMY[u.owner].color}">${ud.name}</span> HP ${Engine.displayHP(u)} · MOV ${ud.move} · RNG ${rng}` +
          (u.cargo.length ? ' · 📦' : '') + ' &nbsp;|&nbsp; ' + s;
    }
    return s;
  }

  /* ================= vision ================= */
  function getVision() {
    if (!game.fog) return null;
    if (visionDirty || !visionCache) {
      visionCache = Engine.computeVision(game, humanPOV());
      visionDirty = false;
    }
    return visionCache;
  }

  /* ================= banners / dialogs ================= */
  function banner(text, color, then) {
    const b = $('#banner');
    b.textContent = text;
    b.style.background = color || '#333';
    b.classList.remove('anim');
    void b.offsetWidth;
    b.classList.add('anim');
    Sound.sfx.turn();
    if (then) setTimeout(then, 900 / aiSpeed);
  }

  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.remove('anim');
    void t.offsetWidth;
    t.classList.add('anim');
  }

  function confirmBox(text, okLabel, cb) {
    const box = $('#confirm');
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = okLabel;
    box.classList.add('active');
    $('#confirm-ok').onclick = () => { box.classList.remove('active'); cb(true); };
    $('#confirm-cancel').onclick = () => { box.classList.remove('active'); cb(false); };
  }

  /* ================= action menu ================= */
  function openActionMenu(actions, screenX, screenY) {
    const menu = $('#action-menu');
    menu.innerHTML = '';
    const LABELS = { fire: '⚔️ Fire', capture: '🚩 Capture', wait: '✔️ Wait', drop: '📦 Drop', load: '📥 Load', join: '🔗 Join', cancel: '✖ Cancel' };
    for (const a of actions) {
      const b = document.createElement('button');
      b.textContent = LABELS[a] || a;
      b.onclick = () => { Sound.sfx.tap(); chooseAction(a); };
      menu.appendChild(b);
    }
    const c = document.createElement('button');
    c.textContent = LABELS.cancel;
    c.className = 'cancel';
    c.onclick = () => { Sound.sfx.cancel(); cancelToIdle(); };
    menu.appendChild(c);
    menu.classList.add('active');
    guardPopup(menu);
    positionPopup(menu, screenX, screenY);
  }

  /* Popups often open right under the finger; the browser then delivers a
     synthesized click at the same spot which would instantly press whatever
     button appeared there. Swallow pointer events briefly after opening. */
  function guardPopup(el) {
    el.style.pointerEvents = 'none';
    setTimeout(() => { el.style.pointerEvents = ''; }, 350);
  }

  function positionPopup(el, x, y) {
    const wrap = $('#screen-game').getBoundingClientRect();
    el.style.left = '0px'; el.style.top = '0px';
    const r = el.getBoundingClientRect();
    let left = x + 14, top = y - r.height / 2;
    if (left + r.width > wrap.width - 8) left = x - r.width - 14;
    if (left < 8) left = 8;
    top = Math.max(60, Math.min(wrap.height - r.height - 90, top));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  function closePopups() {
    $('#action-menu').classList.remove('active');
    $('#forecast').classList.remove('active');
    $('#build-menu').classList.remove('active');
  }

  /* ================= tap handling ================= */
  function tileCenterScreen(x, y) {
    const r = $('#canvas').getBoundingClientRect();
    const dpr = $('#canvas').width / r.width;
    const sx = ((x + 0.5) * Renderer.TILE - Renderer.cam.x) * Renderer.cam.zoom / dpr + r.left;
    const sy = ((y + 0.5) * Renderer.TILE - Renderer.cam.y) * Renderer.cam.zoom / dpr + r.top;
    return { x: sx, y: sy };
  }

  function onTap(sx, sy) {
    if (animating || game.winner !== null) return;
    const { x, y } = Renderer.screenToTile(sx, sy);
    if (!Engine.inBounds(game, x, y)) { cancelToIdle(); return; }
    cursor = { x, y };
    setInfo(describeTile(x, y));

    if (mode === 'ai' || mode === 'locked') return;

    if (mode === 'building') { Sound.sfx.cancel(); closePopups(); mode = 'idle'; return; }

    if (mode === 'menu') { Sound.sfx.cancel(); cancelToIdle(); return; }

    if (mode === 'targeting') {
      const t = targets.find(t => t.x === x && t.y === y);
      if (t) { showForecast(t); }
      else { Sound.sfx.cancel(); cancelAction(); }
      return;
    }

    if (mode === 'dropping') {
      const t = dropTiles.find(t => t.x === x && t.y === y);
      if (t) { executeDrop(t); }
      else { Sound.sfx.cancel(); cancelAction(); }
      return;
    }

    if (mode === 'selected') {
      const k = x + ',' + y;
      if (reachTiles.has(k)) {
        const kind = Engine.stopKind(game, sel, x, y);
        plannedDest = { x, y };
        plannedPath = Engine.buildPath(reach, x, y);
        const pos = tileCenterScreen(x, y);
        Sound.sfx.tap();
        if (kind === 'load') { mode = 'menu'; openActionMenu(['load'], pos.x, pos.y); return; }
        if (kind === 'join') { mode = 'menu'; openActionMenu(['join'], pos.x, pos.y); return; }
        const actions = Engine.possibleActions(game, sel, x, y, plannedPath);
        mode = 'menu';
        openActionMenu(actions, pos.x, pos.y);
        return;
      }
      Sound.sfx.cancel();
      cancelToIdle();
      // fall through to reselect
    }

    // idle: select something
    const u = Engine.unitAt(game, x, y);
    const vis = getVision();
    if (u && (!vis || vis.has(k2(x, y)) || u.owner === humanPOV())) {
      if (u.owner === game.turn && !u.acted && !isAITurn()) {
        selectUnit(u);
        return;
      }
      // enemy or acted unit: show its range
      showDanger(u);
      return;
    }
    // own base?
    const b = Engine.buildableAt(game, x, y);
    if (b && !isAITurn()) { openBuildMenu(x, y, b); return; }
    clearOverlays();
  }

  const k2 = (x, y) => x + ',' + y;

  function selectUnit(u) {
    sel = u;
    reach = Engine.reachable(game, u);
    reachTiles = new Set();
    for (const [k] of reach) {
      const [x, y] = k.split(',').map(Number);
      if (Engine.stopKind(game, u, x, y)) reachTiles.add(k);
    }
    mode = 'selected';
    dangerTiles = null;
    Sound.sfx.select();
  }

  function showDanger(u) {
    const r = Engine.reachable(game, u);
    const ud = UNITS[u.type];
    const set = new Set();
    if (ud.range[1] >= 1) {
      if (ud.indirect) {
        for (let dy = -ud.range[1]; dy <= ud.range[1]; dy++)
          for (let dx = -ud.range[1] + Math.abs(dy); dx <= ud.range[1] - Math.abs(dy); dx++) {
            if (Math.abs(dx) + Math.abs(dy) < ud.range[0]) continue;
            const x = u.x + dx, y = u.y + dy;
            if (Engine.inBounds(game, x, y)) set.add(k2(x, y));
          }
      } else {
        for (const [k] of r) {
          const [x, y] = k.split(',').map(Number);
          const occ = Engine.unitAt(game, x, y);
          if (occ && occ !== u) continue;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (Engine.inBounds(game, x + dx, y + dy)) set.add(k2(x + dx, y + dy));
          }
        }
      }
    }
    dangerTiles = set;
    sel = null; reach = null; reachTiles = null;
    mode = 'danger';
    Sound.sfx.tap();
    toast(`${UNITS[u.type].name} threat range`);
  }

  function clearOverlays() {
    sel = null; reach = null; reachTiles = null; plannedPath = null; plannedDest = null;
    targets = []; dropTiles = []; dangerTiles = null;
    closePopups();
  }

  function cancelToIdle() {
    clearOverlays();
    mode = 'idle';
  }

  /* undo the pending move and return to fresh selection */
  function cancelAction() {
    if (undoSnapshot) {
      game = Engine.deserialize(undoSnapshot);
      undoSnapshot = null;
      Renderer.animPos.clear();
      Renderer.invalidateMap();
      visionDirty = true;
    }
    cancelToIdle();
    updateHUD();
  }

  /* ================= executing actions ================= */
  async function chooseAction(action) {
    closePopups();
    const gen = gameGen;
    undoSnapshot = Engine.serialize(game);
    const path = plannedPath;
    const dest = plannedDest;
    mode = 'locked';

    if (action === 'load' || action === 'join') {
      // walk up to (not onto) the occupied destination so fog ambushes apply
      const walk = path.slice(0, -1);
      let trapped = false;
      if (walk.length > 1) {
        const mv = Engine.doMove(game, sel, walk).find(e => e.type === 'move');
        await animateMove(sel, mv.path);
        if (gen !== gameGen) return;
        trapped = mv.trapped;
      }
      visionDirty = true;
      if (trapped) {
        Renderer.addEffect({ type: 'text', x: sel.x, y: sel.y, text: 'Ambush!', color: 'rgba(255,90,90,ALPHA)' });
        Sound.sfx.boom();
        finishHumanAction();
        return;
      }
      const other = Engine.unitAt(game, dest.x, dest.y);
      if (action === 'load' && other) {
        Engine.doLoad(game, sel, other);
        sel.acted = true;
      } else if (action === 'join' && other) {
        Engine.doJoin(game, sel, other);
        Sound.sfx.heal();
      }
      finishHumanAction();
      return;
    }

    // regular: move first
    const evs = Engine.doMove(game, sel, path);
    const moveEv = evs.find(e => e.type === 'move');
    await animateMove(sel, moveEv.path);
    if (gen !== gameGen) return;
    visionDirty = true;
    if (moveEv.trapped) {
      Renderer.addEffect({ type: 'text', x: sel.x, y: sel.y, text: 'Ambush!', color: 'rgba(255,90,90,ALPHA)' });
      Sound.sfx.boom();
      finishHumanAction();
      return;
    }

    if (action === 'wait') {
      Engine.doWait(game, sel);
      finishHumanAction();
      return;
    }
    if (action === 'capture') {
      const evs2 = Engine.doCapture(game, sel);
      await playEvents(evs2);
      if (gen !== gameGen) return;
      finishHumanAction();
      return;
    }
    if (action === 'fire') {
      targets = Engine.attackTargets(game, sel, sel.x, sel.y, moveEv.path.length > 1);
      mode = 'targeting';
      toast('Choose a target');
      return;
    }
    if (action === 'drop') {
      dropTiles = Engine.dropTiles(game, sel);
      mode = 'dropping';
      toast('Choose a drop tile');
      return;
    }
  }

  function showForecast(target) {
    const f = Engine.forecast(game, sel, target);
    const box = $('#forecast');
    const tn = UNITS[target.type].name;
    const dhp = Engine.displayHP(target);
    const killLikely = f.dmg >= target.hp;
    $('#forecast-text').innerHTML =
      `<b>${UNITS[sel.type].name}</b> → <b>${tn}</b> (HP ${dhp})<br>` +
      `Damage: <b class="good">${Math.min(99, Math.round(f.dmg / 10))}–${Math.min(10, Math.ceil((f.dmg + 9) / 10))} HP</b>${killLikely ? ' 💥' : ''}<br>` +
      `Counter: <b class="${f.counter > 25 ? 'bad' : 'dim'}">${f.counter ? '~' + Math.round(f.counter / 10) + ' HP' : 'none'}</b>`;
    box.classList.add('active');
    guardPopup(box);
    const pos = tileCenterScreen(target.x, target.y);
    positionPopup(box, pos.x, pos.y);
    $('#forecast-ok').onclick = async () => {
      const gen = gameGen;
      box.classList.remove('active');
      mode = 'locked';
      const evs = Engine.doAttack(game, sel, target);
      undoSnapshot = null;
      await playEvents(evs);
      if (gen !== gameGen) return;
      finishHumanAction();
    };
    $('#forecast-cancel').onclick = () => { box.classList.remove('active'); Sound.sfx.cancel(); };
  }

  async function executeDrop(tile) {
    const gen = gameGen;
    mode = 'locked';
    const evs = Engine.doDrop(game, sel, tile.x, tile.y);
    undoSnapshot = null;
    await playEvents(evs);
    if (gen !== gameGen) return;
    finishHumanAction();
  }

  function finishHumanAction() {
    undoSnapshot = null;
    clearOverlays();
    visionDirty = true;
    updateHUD();
    if (game.winner !== null) { onGameOver(); return; }
    mode = 'idle';
    saveGame();
  }

  /* ================= build menu ================= */
  function openBuildMenu(x, y, list) {
    const menu = $('#build-menu');
    const funds = game.players[game.turn].funds;
    menu.innerHTML = `<div class="build-title">Build — G ${funds.toLocaleString()}</div>`;
    for (const id of UNIT_ORDER) {
      if (!list.includes(id)) continue;
      const u = UNITS[id];
      const row = document.createElement('button');
      row.className = 'build-row' + (u.cost > funds ? ' disabled' : '');
      const icon = document.createElement('canvas');
      icon.width = 40; icon.height = 40;
      const g = icon.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(Renderer.getSprite('U' + id + game.turn), 0, 0, 40, 40);
      row.appendChild(icon);
      const label = document.createElement('div');
      label.className = 'build-label';
      const rng = u.range[1] ? (u.range[0] === u.range[1] ? 'RNG ' + u.range[1] : `RNG ${u.range[0]}–${u.range[1]}`) : (u.carries ? 'Transport' : '');
      label.innerHTML = `<div>${u.name}</div><div class="row-sub">MOV ${u.move}${rng ? ' · ' + rng : ''}${u.capture ? ' · Captures' : ''}</div>`;
      row.appendChild(label);
      const cost = document.createElement('div');
      cost.className = 'build-cost';
      cost.textContent = u.cost.toLocaleString();
      row.appendChild(cost);
      if (u.cost <= funds) {
        row.onclick = () => {
          Sound.sfx.build();
          const nu = Engine.buildUnit(game, x, y, id);
          if (nu) {
            Renderer.addEffect({ type: 'spark', x, y });
            closePopups();
            mode = 'idle';
            updateHUD();
            saveGame();
          }
        };
      } else row.onclick = () => Sound.sfx.cancel();
      menu.appendChild(row);
    }
    const c = document.createElement('button');
    c.textContent = '✖ Cancel';
    c.className = 'cancel';
    c.onclick = () => { Sound.sfx.cancel(); closePopups(); mode = 'idle'; };
    menu.appendChild(c);
    menu.classList.add('active');
    guardPopup(menu);
    mode = 'building';
  }

  /* ================= animation of engine events ================= */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms / aiSpeed));

  async function animateMove(unit, path) {
    if (path.length < 2) return;
    const gen = gameGen;
    animating = true;
    animatingUnit = unit.id;
    Sound.sfx.move();
    const perTile = 110;
    try {
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i], b = path[i + 1];
        const steps = 6;
        for (let s = 1; s <= steps; s++) {
          Renderer.animPos.set(unit.id, { x: a.x + (b.x - a.x) * s / steps, y: a.y + (b.y - a.y) * s / steps });
          await sleep(perTile / steps);
          if (gen !== gameGen) return;
        }
      }
    } finally {
      Renderer.animPos.delete(unit.id);
      if (gen === gameGen) { animating = false; animatingUnit = null; }
    }
  }

  async function playEvents(events) {
    const gen = gameGen;
    animating = true;
    try {
      await playEventsInner(events, gen);
    } finally {
      if (gen === gameGen) animating = false;
    }
  }

  async function playEventsInner(events, gen) {
    for (const e of events) {
      if (gen !== gameGen || !game) return;
      switch (e.type) {
        case 'move': {
          const u = Engine.unitById(game, e.unit);
          if (u) {
            // walk from path start visually
            await animateMove(u, e.path);
            if (gen !== gameGen) return;
            if (e.trapped) {
              Renderer.addEffect({ type: 'text', x: u.x, y: u.y, text: 'Ambush!', color: 'rgba(255,90,90,ALPHA)' });
            }
          }
          break;
        }
        case 'attack': {
          const from = Engine.unitById(game, e.from);
          if (from) Renderer.addEffect({ type: 'muzzle', x: from.x, y: from.y });
          Sound.sfx.shot();
          await sleep(140);
          Renderer.addShake(4);
          Renderer.addEffect({ type: 'text', x: e.x, y: e.y, text: '-' + Math.max(1, Math.round(e.dmg / 10)), color: 'rgba(255,120,90,ALPHA)' });
          await sleep(260);
          break;
        }
        case 'die': {
          Sound.sfx.boom();
          Renderer.addShake(7);
          Renderer.addEffect({ type: 'explosion', x: e.x, y: e.y });
          await sleep(360);
          break;
        }
        case 'capturing': {
          Sound.sfx.capture();
          Renderer.addEffect({ type: 'text', x: e.x, y: e.y, text: e.left + ' left', color: 'rgba(255,220,110,ALPHA)' });
          await sleep(250);
          break;
        }
        case 'captured': {
          Sound.sfx.capture();
          Renderer.addEffect({ type: 'spark', x: e.x, y: e.y });
          Renderer.addEffect({ type: 'text', x: e.x, y: e.y, text: 'Captured!', color: 'rgba(255,230,120,ALPHA)' });
          Renderer.invalidateMap();
          visionDirty = true;
          await sleep(320);
          break;
        }
        case 'build': {
          Sound.sfx.build();
          Renderer.addEffect({ type: 'spark', x: e.x, y: e.y });
          await sleep(180);
          break;
        }
        case 'repair': {
          Renderer.addEffect({ type: 'text', x: e.x, y: e.y, text: '+' + (e.heal / 10 | 0), color: 'rgba(120,255,150,ALPHA)' });
          break;
        }
        case 'load': Sound.sfx.tap(); break;
        case 'drop': Sound.sfx.tap(); await sleep(150); break;
        case 'win': break;
        case 'day': break;
        case 'wait': break;
      }
    }
    animating = false;
  }

  /* ================= end turn & AI ================= */
  async function doEndTurn() {
    if (animating || isAITurn()) return;
    const gen = gameGen;
    // a pending move (Fire/Drop target not chosen yet) must be rolled back first
    if (mode === 'targeting' || mode === 'dropping') cancelAction();
    clearOverlays();
    mode = 'locked';
    const evs = Engine.endTurn(game);
    visionDirty = true;
    updateHUD();
    saveGame();
    // hotseat: pass-device curtain
    if (meta.mode === 'hotseat' && game.winner === null) {
      await showCurtain();
      if (gen !== gameGen) return;
    }
    banner(dayTitle(), teamColor(game.turn), async () => {
      if (gen !== gameGen || !game) return;
      await playEvents(evs.filter(e => e.type === 'repair'));
      if (gen !== gameGen || !game) return;
      updateHUD();
      if (isAITurn()) runAITurn();
      else mode = 'idle';
    });
  }

  function showCurtain() {
    return new Promise(res => {
      const c = $('#curtain');
      $('#curtain-text').textContent = `Pass the device to ${ARMY[game.turn].name}`;
      $('#curtain-btn').style.background = ARMY[game.turn].color;
      c.classList.add('active');
      $('#curtain-btn').onclick = () => { c.classList.remove('active'); res(); };
    });
  }

  async function runAITurn() {
    const gen = gameGen;
    mode = 'ai';
    updateHUD();
    while (game.winner === null && isAITurn()) {
      const r = AI.step(game);
      // focus camera on the acting unit
      const mv = r.events.find(e => e.type === 'move' || e.type === 'attack' || e.type === 'build' || e.type === 'capturing' || e.type === 'captured');
      if (mv) {
        const fx = mv.path ? mv.path[0].x : mv.x, fy = mv.path ? mv.path[0].y : mv.y;
        const vis = getVision();
        if (!vis || vis.has(k2(fx, fy)) || r.events.some(e => e.x !== undefined && vis.has(k2(e.x, e.y)))) {
          Renderer.focusTile(game, fx, fy);
        }
      }
      await playEvents(r.events);
      if (gen !== gameGen || !game) return;
      visionDirty = true;
      updateHUD();
      if (r.done) break;
      await sleep(120);
      if (gen !== gameGen || !game) return;
    }
    if (game.winner !== null) { onGameOver(); return; }
    const evs = Engine.endTurn(game);
    visionDirty = true;
    saveGame();
    banner(dayTitle(), teamColor(game.turn), async () => {
      if (gen !== gameGen || !game) return;
      await playEvents(evs.filter(e => e.type === 'repair'));
      if (gen !== gameGen || !game) return;
      updateHUD();
      if (isAITurn()) runAITurn();   // AI vs AI safety
      else mode = 'idle';
    });
  }

  /* ================= game over ================= */
  function onGameOver() {
    mode = 'over';
    const gen = gameGen;
    localStorage.removeItem(SAVE_KEY);
    const w = game.winner;
    const humanWon = meta.mode === 'hotseat' ? true : w === humanPOV();
    Sound.stopMusic();
    if (humanWon) Sound.sfx.win(); else Sound.sfx.lose();
    if (meta.mode === 'campaign' && humanWon) {
      const cur = parseInt(localStorage.getItem(PROGRESS_KEY) || '0', 10);
      localStorage.setItem(PROGRESS_KEY, String(Math.max(cur, meta.missionIdx + 1)));
    }
    setTimeout(() => {
      if (gen !== gameGen || !game) return;
      const box = $('#gameover');
      const title = meta.mode === 'hotseat'
        ? `${ARMY[w].name} wins!`
        : humanWon ? 'Victory!' : 'Defeat…';
      $('#go-title').textContent = title;
      $('#go-title').style.color = humanWon ? '#ffd24d' : '#ff7b6b';
      const p0 = game.players[0], p1 = game.players[1];
      $('#go-stats').innerHTML =
        `<div class="go-row"><span>Day</span><b>${game.day}</b></div>` +
        `<div class="go-row"><span>${ARMY[0].name} — built / lost / destroyed</span><b>${p0.built} / ${p0.lost} / ${p0.killed}</b></div>` +
        `<div class="go-row"><span>${ARMY[1].name} — built / lost / destroyed</span><b>${p1.built} / ${p1.lost} / ${p1.killed}</b></div>`;
      const nextBtn = $('#go-next');
      if (meta.mode === 'campaign' && humanWon && meta.missionIdx + 1 < CAMPAIGN.length) {
        nextBtn.style.display = '';
        nextBtn.onclick = () => { box.classList.remove('active'); startCampaign(meta.missionIdx + 1); };
      } else nextBtn.style.display = 'none';
      $('#go-retry').onclick = () => {
        box.classList.remove('active');
        if (meta.mode === 'campaign') startCampaign(meta.missionIdx);
        else { const m = MAPS.find(m => m.id === meta.mapId); game = Engine.makeGame(m, { fog: meta.fog, p2AI: meta.mode !== 'hotseat' }); beginGame(); }
      };
      $('#go-menu').onclick = () => { box.classList.remove('active'); quitToTitle(); };
      box.classList.add('active');
    }, 1100);
  }

  function quitToTitle() {
    gameGen++;
    stopLoop();
    Sound.playSong('menu');
    game = null;
    animating = false; animatingUnit = null; undoSnapshot = null;
    Renderer.animPos.clear();
    closePopups();
    buildMenus();
    show('screen-menu');
  }

  /* ================= render loop ================= */
  function startLoop() {
    stopLoop();
    lastT = performance.now();
    const frame = (t) => {
      const dt = Math.min(0.05, (t - lastT) / 1000);
      lastT = t;
      if (game) {
        Renderer.draw(game, {
          vision: getVision(),
          povPlayer: humanPOV(),
          selected: sel ? sel.id : null,
          reachTiles: mode === 'selected' ? reachTiles : null,
          path: (mode === 'selected' || mode === 'menu') ? plannedPath : null,
          targets: mode === 'targeting' ? targets : null,
          dropTiles: mode === 'dropping' ? dropTiles : null,
          dangerTiles: mode === 'danger' ? dangerTiles : null,
          cursor,
          animatingUnit,
        }, dt);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }
  function stopLoop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  /* ================= pointer input ================= */
  function setupInput() {
    const cv = $('#canvas');
    let pointers = new Map();
    let dragStart = null, dragged = false, pinchDist = 0;

    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) { dragStart = { x: e.clientX, y: e.clientY }; dragged = false; }
      else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    cv.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1 && dragStart) {
        const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
        if (Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) > 10) dragged = true;
        if (dragged) {
          const dpr = cv.width / cv.getBoundingClientRect().width;
          Renderer.pan(-dx * dpr, -dy * dpr);
          Renderer.clampCam(game);
        }
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0 && game) {
          Renderer.zoomAt(d / pinchDist, (a.x + b.x) / 2, (a.y + b.y) / 2);
          Renderer.clampCam(game);
        }
        pinchDist = d;
        dragged = true;
      }
    });
    const up = (e) => {
      if (pointers.has(e.pointerId)) pointers.delete(e.pointerId);
      if (pointers.size === 0) {
        if (!dragged && dragStart && game) onTap(e.clientX, e.clientY);
        dragStart = null;
        pinchDist = 0;
      }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!game) return;
      Renderer.zoomAt(e.deltaY < 0 ? 1.12 : 0.89, e.clientX, e.clientY);
      Renderer.clampCam(game);
    }, { passive: false });
  }

  /* ================= wire up buttons ================= */
  function setupUI() {
    $('#btn-play').onclick = () => { Sound.unlock(); Sound.sfx.select(); Sound.playSong('menu'); show('screen-menu'); };
    $('#btn-campaign').onclick = () => { Sound.sfx.select(); buildMenus(); show('screen-campaign'); };
    $('#btn-skirmish').onclick = () => { Sound.sfx.select(); buildMenus(); show('screen-maps'); };
    $('#btn-help').onclick = () => { Sound.sfx.select(); $('#help').classList.add('active'); };
    $('#help-close').onclick = () => { Sound.sfx.cancel(); $('#help').classList.remove('active'); };
    $('#btn-continue').onclick = () => { Sound.sfx.select(); continueGame(); };
    $$('.btn-back').forEach(b => b.onclick = () => { Sound.sfx.cancel(); show('screen-menu'); });

    $('#btn-endturn').onclick = () => {
      if (!game || isAITurn() || animating || game.winner !== null) return;
      Sound.sfx.tap();
      const idle = game.units.filter(u => u.owner === game.turn && !u.acted).length;
      if (idle > 0) confirmBox(`${idle} unit${idle > 1 ? 's' : ''} can still act. End turn?`, 'End Turn', ok => { if (ok) doEndTurn(); });
      else doEndTurn();
    };

    $('#btn-next').onclick = () => {
      if (!game || isAITurn() || animating || game.winner !== null) return;
      // roll back any half-committed move before jumping to another unit
      if (mode === 'targeting' || mode === 'dropping') cancelAction();
      const ready = game.units.filter(u => u.owner === game.turn && !u.acted);
      if (!ready.length) { toast('All units have acted'); return; }
      nextUnitIdx = (nextUnitIdx + 1) % ready.length;
      const u = ready[nextUnitIdx];
      cancelToIdle();
      Renderer.focusTile(game, u.x, u.y);
      selectUnit(u);
      cursor = { x: u.x, y: u.y };
      setInfo(describeTile(u.x, u.y));
    };

    $('#btn-menu').onclick = () => { Sound.sfx.tap(); $('#pause').classList.add('active'); syncPause(); };
    $('#pause-resume').onclick = () => { Sound.sfx.tap(); $('#pause').classList.remove('active'); };
    $('#pause-help').onclick = () => { Sound.sfx.tap(); $('#help').classList.add('active'); };
    $('#pause-sound').onclick = () => {
      Sound.setMuted(!Sound.isMuted());
      if (!Sound.isMuted()) { Sound.unlock(); Sound.playSong('battle'); } else Sound.stopMusic();
      syncPause();
    };
    $('#pause-retry').onclick = () => {
      $('#pause').classList.remove('active');
      confirmBox('Restart this battle from the beginning?', 'Restart', ok => {
        if (!ok) return;
        if (meta.mode === 'campaign') startCampaign(meta.missionIdx);
        else { const m = MAPS.find(m => m.id === meta.mapId); game = Engine.makeGame(m, { fog: meta.fog, p2AI: meta.mode !== 'hotseat' }); beginGame(); }
      });
    };
    $('#pause-quit').onclick = () => {
      $('#pause').classList.remove('active');
      confirmBox('Quit to the main menu? Progress is saved.', 'Quit', ok => { if (ok) quitToTitle(); });
    };
    $('#btn-ai-speed').onclick = () => {
      aiSpeed = aiSpeed === 1 ? 3 : 1;
      $('#btn-ai-speed').textContent = aiSpeed === 1 ? '⏩' : '▶️';
      Sound.sfx.tap();
    };
    window.addEventListener('resize', () => { Renderer.resize(); if (game) Renderer.clampCam(game); });
  }

  function syncPause() {
    $('#pause-sound').textContent = Sound.isMuted() ? '🔇 Sound: Off' : '🔊 Sound: On';
  }

  /* ================= boot ================= */
  /* debug/testing hook */
  window.__MW = {
    getGame: () => game,
    getMode: () => mode,
    isAnimating: () => animating,
  };

  window.addEventListener('load', () => {
    Renderer.init($('#canvas'));
    setupInput();
    setupUI();
    buildMenus();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  });
})();
