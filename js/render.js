/* Micro Wars — canvas renderer. All art is generated procedurally (no assets). */
'use strict';

const Renderer = (() => {
  const TILE = 48;             // base sprite resolution (px per tile at zoom 1)
  const PX = TILE / 16;        // pixel-art grid unit

  let canvas, ctx;
  let cam = { x: 0, y: 0, zoom: 1 };
  let camTarget = null;        // smooth pan target {x,y} in world px (centre)
  let mapLayer = null;         // cached terrain canvas
  let mapLayerDirty = true;
  let effects = [];
  const animPos = new Map();   // unitId -> {x,y} tile floats (animation override)
  let shake = 0;
  let time = 0;

  const NEUTRAL = { color: '#9aa0a6', dark: '#5f6368', light: '#cfd4da' };
  const teamCol = (owner) => owner < 0 ? NEUTRAL : ARMY[owner];

  /* ---------- tiny pixel-art painter ---------- */
  function mkCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function painter(c) {
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    return {
      g,
      r: (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x * PX, y * PX, w * PX, h * PX); },
      dot: (x, y, col) => { g.fillStyle = col; g.fillRect(x * PX, y * PX, PX, PX); },
    };
  }

  /* ---------- terrain sprites ---------- */
  const sprites = {};

  function grass(p, seed) {
    p.r(0, 0, 16, 16, '#7bb661');
    for (let i = 0; i < 14; i++) {
      const x = (i * 7 + seed * 3) % 16, y = (i * 11 + seed * 5) % 16;
      p.dot(x, y, (i % 3 === 0) ? '#8fc973' : '#6da854');
    }
  }

  function buildTerrainSprites() {
    // plains (4 variants)
    for (let v = 0; v < 4; v++) {
      const c = mkCanvas(TILE, TILE); const p = painter(c);
      grass(p, v);
      sprites['PLAIN' + v] = c;
    }
    // woods
    {
      const c = mkCanvas(TILE, TILE); const p = painter(c);
      grass(p, 1);
      const tree = (tx, ty) => {
        p.r(tx + 2, ty + 6, 2, 3, '#7a5230');
        p.r(tx, ty + 1, 6, 5, '#3e7a3a');
        p.r(tx + 1, ty, 4, 2, '#3e7a3a');
        p.r(tx + 1, ty + 1, 2, 2, '#579a52');
      };
      tree(2, 2); tree(8, 6); tree(9, 1);
      sprites.WOOD = c;
    }
    // mountain
    {
      const c = mkCanvas(TILE, TILE); const p = painter(c);
      grass(p, 2);
      p.r(2, 12, 12, 2, '#8d7757');
      for (let i = 0; i < 6; i++) p.r(3 + i, 12 - i * 2, 10 - i * 2, 2, i > 3 ? '#e8e4da' : '#a08b66');
      p.r(6, 3, 4, 2, '#f5f2ea');
      sprites.MOUNTAIN = c;
    }
    // sea (animated in draw; base here)
    {
      const c = mkCanvas(TILE, TILE); const p = painter(c);
      p.r(0, 0, 16, 16, '#3d7dc8');
      for (let i = 0; i < 5; i++) p.r((i * 5) % 14, (i * 7 + 2) % 15, 3, 1, '#5b97dd');
      sprites.SEA = c;
    }
    // shoal
    {
      const c = mkCanvas(TILE, TILE); const p = painter(c);
      p.r(0, 0, 16, 16, '#e7d698');
      p.r(0, 0, 16, 3, '#5b97dd');
      p.r(0, 3, 16, 1, '#bfe0f0');
      for (let i = 0; i < 8; i++) p.dot((i * 5 + 2) % 16, 5 + (i * 3) % 10, '#d4c184');
      sprites.SHOAL = c;
    }
    // river base (connections drawn dynamically)
    {
      const c = mkCanvas(TILE, TILE); const p = painter(c);
      grass(p, 3);
      sprites.RIVERBASE = c;
    }
    buildBuildingSprites();
    buildUnitSprites();
  }

  function buildingBase(p, col) {
    grass(p, 0);
  }

  function buildBuildingSprites() {
    const owners = [-1, 0, 1];
    for (const o of owners) {
      const t = teamCol(o);
      // CITY: house
      {
        const c = mkCanvas(TILE, TILE); const p = painter(c);
        buildingBase(p, t);
        p.r(3, 7, 10, 7, '#ddd6c8');
        p.r(2, 4, 12, 3, t.color);
        p.r(4, 2, 8, 2, t.color);
        p.r(5, 9, 2, 3, '#4a4a55');
        p.r(9, 9, 3, 2, '#9fc4e0');
        p.r(3, 13, 10, 1, '#b7ae9d');
        sprites['CITY' + o] = c;
      }
      // BASE: factory
      {
        const c = mkCanvas(TILE, TILE); const p = painter(c);
        buildingBase(p, t);
        p.r(2, 6, 12, 8, '#8f8f9a');
        p.r(2, 6, 12, 2, '#6f6f7a');
        p.r(3, 2, 3, 4, '#6f6f7a');
        p.r(4, 1, 1, 2, '#d9d9e0');
        p.r(5, 9, 6, 5, t.color);
        p.r(6, 10, 4, 4, t.dark);
        p.r(11, 8, 2, 2, '#f4e04d');
        sprites['BASE' + o] = c;
      }
      // AIRPORT
      {
        const c = mkCanvas(TILE, TILE); const p = painter(c);
        buildingBase(p, t);
        p.r(1, 9, 14, 6, '#77777f');
        p.r(2, 10, 12, 4, '#8a8a92');
        p.g.fillStyle = '#e8e8ee';
        p.r(7, 10, 2, 4, '#e8e8ee'); p.r(5, 11, 6, 2, '#e8e8ee'); // H pad-ish
        p.r(2, 3, 8, 5, t.color);
        p.r(3, 4, 6, 3, t.light);
        p.r(10, 1, 2, 7, '#6f6f7a');
        p.r(10, 1, 4, 2, t.color);
        sprites['AIRPORT' + o] = c;
      }
      // HQ
      {
        const c = mkCanvas(TILE, TILE); const p = painter(c);
        buildingBase(p, t);
        p.r(2, 5, 12, 9, t.color);
        p.r(3, 6, 10, 7, t.dark);
        p.r(5, 8, 6, 6, t.color);
        p.r(7, 10, 2, 4, '#2b2b33');
        p.r(3, 3, 10, 2, t.color);
        p.r(7, 0, 1, 4, '#e8e8ee');
        p.r(8, 0, 4, 2, '#f4e04d');
        sprites['HQ' + o] = c;
      }
    }
  }

  /* ---------- unit sprites ---------- */
  function buildUnitSprites() {
    for (let o = 0; o < 2; o++) {
      const t = ARMY[o];
      for (const id in UNITS) {
        const c = mkCanvas(TILE, TILE);
        const p = painter(c);
        drawUnitArt(p, id, t, o === 1);
        sprites['U' + id + o] = c;
        // greyed 'acted' version
        const g = mkCanvas(TILE, TILE);
        const gg = g.getContext('2d');
        gg.filter = 'grayscale(70%) brightness(0.62)';
        gg.drawImage(c, 0, 0);
        sprites['U' + id + o + 'g'] = g;
      }
    }
  }

  function drawUnitArt(p, id, t, flip) {
    const g = p.g;
    if (flip) { g.save(); g.translate(TILE, 0); g.scale(-1, 1); }
    const B = '#20242c'; // outline/dark
    switch (id) {
      case 'INF':
        p.r(6, 2, 4, 4, t.color);      // helmet
        p.r(6, 5, 4, 3, '#e8b98c');    // face
        p.r(5, 8, 6, 5, t.color);      // body
        p.r(4, 9, 8, 2, t.dark);
        p.r(10, 7, 4, 1, B);           // rifle
        p.r(5, 13, 2, 2, B); p.r(9, 13, 2, 2, B);
        break;
      case 'MECH':
        p.r(5, 2, 5, 4, t.color);
        p.r(6, 5, 4, 3, '#e8b98c');
        p.r(4, 8, 7, 5, t.color);
        p.r(3, 9, 9, 2, t.dark);
        p.r(9, 4, 5, 2, B); p.r(12, 3, 2, 4, '#555c66');  // bazooka
        p.r(4, 13, 2, 2, B); p.r(9, 13, 2, 2, B);
        break;
      case 'RECON':
        p.r(2, 6, 12, 5, t.color);
        p.r(3, 4, 6, 3, t.dark);
        p.r(4, 5, 3, 2, '#9fc4e0');
        p.r(2, 10, 3, 4, B); p.r(11, 10, 3, 4, B);
        p.r(3, 11, 1, 2, '#777'); p.r(12, 11, 1, 2, '#777');
        break;
      case 'TANK':
        p.r(2, 8, 12, 4, t.color);
        p.r(1, 11, 14, 3, B);
        p.r(2, 12, 2, 1, '#666'); p.r(7, 12, 2, 1, '#666'); p.r(12, 12, 2, 1, '#666');
        p.r(5, 5, 6, 4, t.dark);
        p.r(10, 6, 6, 2, '#555c66');   // barrel
        break;
      case 'MDTANK':
        p.r(1, 7, 14, 5, t.color);
        p.r(0, 11, 16, 4, B);
        p.r(1, 12, 3, 2, '#666'); p.r(6, 12, 3, 2, '#666'); p.r(11, 12, 3, 2, '#666');
        p.r(4, 3, 8, 5, t.dark);
        p.r(10, 4, 6, 1, '#555c66'); p.r(10, 6, 6, 1, '#555c66');
        break;
      case 'APC':
        p.r(2, 5, 12, 7, t.color);
        p.r(3, 6, 10, 2, t.light);
        p.r(1, 11, 14, 3, B);
        p.r(2, 12, 2, 2, '#666'); p.r(7, 12, 2, 2, '#666'); p.r(12, 12, 2, 2, '#666');
        break;
      case 'ARTY':
        p.r(2, 9, 12, 4, t.color);
        p.r(1, 12, 14, 2, B);
        p.r(5, 7, 5, 3, t.dark);
        g.fillStyle = '#555c66';
        for (let i = 0; i < 7; i++) p.r(8 + i, 7 - i, 2, 2, '#555c66'); // angled barrel
        break;
      case 'ROCKET':
        p.r(2, 9, 12, 4, t.color);
        p.r(1, 12, 14, 2, B);
        for (let i = 0; i < 5; i++) p.r(5 + i, 8 - i, 6, 2, t.dark);   // angled rack
        p.r(9, 2, 3, 3, '#e05c3a');
        break;
      case 'AA':
        p.r(2, 8, 12, 4, t.color);
        p.r(1, 11, 14, 3, B);
        p.r(5, 5, 6, 4, t.dark);
        p.r(7, 0, 1, 6, '#555c66'); p.r(9, 0, 1, 6, '#555c66');
        break;
      case 'FIGHTER':
        p.r(2, 7, 12, 3, t.color);
        p.r(12, 6, 4, 5, t.dark);      // nose
        p.r(4, 4, 4, 9, t.color);      // wings
        p.r(1, 5, 2, 7, t.dark);       // tail
        p.r(13, 7, 2, 3, '#9fc4e0');
        break;
      case 'BOMBER':
        p.r(1, 7, 14, 4, t.color);
        p.r(3, 2, 5, 14, t.dark);      // big wings
        p.r(13, 8, 3, 2, '#9fc4e0');
        p.r(0, 5, 2, 3, t.dark);
        break;
      case 'BCOPTER':
        p.r(3, 7, 9, 4, t.color);
        p.r(11, 8, 4, 2, t.dark);      // tail
        p.r(14, 6, 1, 5, t.dark);
        p.r(4, 8, 3, 2, '#9fc4e0');
        p.r(2, 4, 12, 1, '#555c66');   // rotor
        p.r(7, 5, 2, 2, B);
        p.r(4, 11, 8, 1, B);           // skids
        break;
      case 'TCOPTER':
        p.r(2, 6, 11, 6, t.color);
        p.r(3, 7, 4, 3, '#9fc4e0');
        p.r(12, 7, 4, 2, t.dark);
        p.r(1, 3, 13, 1, '#555c66');
        p.r(7, 4, 2, 2, B);
        p.r(3, 12, 9, 1, B);
        break;
    }
    if (flip) g.restore();
  }

  /* ---------- map layer (terrain cache) ---------- */
  function isWaterish(game, x, y) {
    if (!Engine.inBounds(game, x, y)) return true;
    const t = game.terrain[y][x];
    return t === 'SEA' || t === 'SHOAL' || t === 'RIVER' || t === 'BRIDGE';
  }
  function connectsRoad(game, x, y) {
    if (!Engine.inBounds(game, x, y)) return false;
    const t = game.terrain[y][x];
    return t === 'ROAD' || t === 'BRIDGE' || t === 'BASE' || t === 'HQ' || t === 'CITY' || t === 'AIRPORT';
  }
  function connectsRiver(game, x, y) {
    if (!Engine.inBounds(game, x, y)) return true;
    const t = game.terrain[y][x];
    return t === 'RIVER' || t === 'SEA' || t === 'BRIDGE';
  }

  function rebuildMapLayer(game) {
    mapLayer = mkCanvas(game.w * TILE, game.h * TILE);
    const g = mapLayer.getContext('2d');
    g.imageSmoothingEnabled = false;
    for (let y = 0; y < game.h; y++) {
      for (let x = 0; x < game.w; x++) {
        const t = game.terrain[y][x];
        const dx = x * TILE, dy = y * TILE;
        let img = null;
        if (t === 'PLAIN') img = sprites['PLAIN' + ((x * 7 + y * 13) % 4)];
        else if (t === 'WOOD') img = sprites.WOOD;
        else if (t === 'MOUNTAIN') img = sprites.MOUNTAIN;
        else if (t === 'SEA') img = sprites.SEA;
        else if (t === 'SHOAL') img = sprites.SEA;
        else if (t === 'RIVER' || t === 'ROAD' || t === 'BRIDGE') img = sprites['PLAIN' + ((x + y) % 4)];
        else {
          const p = Engine.propAt(game, x, y);
          img = sprites[t + (p ? p.owner : -1)];
        }
        g.drawImage(img, dx, dy);

        // road / river / bridge connections
        if (t === 'ROAD') drawConnected(g, game, x, y, connectsRoad, '#c2b280', '#a89968', 6);
        if (t === 'RIVER') drawConnected(g, game, x, y, connectsRiver, '#4b8fd6', '#6fb0e8', 6);
        if (t === 'BRIDGE') {
          // water underneath
          g.drawImage(sprites.SEA, dx, dy);
          const horiz = connectsRoad(game, x - 1, y) || connectsRoad(game, x + 1, y);
          g.fillStyle = '#a5793f';
          if (horiz) { g.fillRect(dx, dy + 4 * PX, TILE, 8 * PX); g.fillStyle = '#c9995a'; g.fillRect(dx, dy + 5 * PX, TILE, 6 * PX); }
          else { g.fillRect(dx + 4 * PX, dy, 8 * PX, TILE); g.fillStyle = '#c9995a'; g.fillRect(dx + 5 * PX, dy, 6 * PX, TILE); }
        }
        if (t === 'SHOAL') g.drawImage(sprites.SHOAL, dx, dy);
      }
    }
    // coastline foam on sea tiles adjacent to land
    g.fillStyle = 'rgba(220,240,255,0.7)';
    for (let y = 0; y < game.h; y++) {
      for (let x = 0; x < game.w; x++) {
        if (game.terrain[y][x] !== 'SEA') continue;
        const dx = x * TILE, dy = y * TILE;
        if (!isWaterish(game, x, y - 1)) g.fillRect(dx, dy, TILE, PX);
        if (!isWaterish(game, x, y + 1)) g.fillRect(dx, dy + TILE - PX, TILE, PX);
        if (!isWaterish(game, x - 1, y)) g.fillRect(dx, dy, PX, TILE);
        if (!isWaterish(game, x + 1, y)) g.fillRect(dx + TILE - PX, dy, PX, TILE);
      }
    }
    // subtle grid
    g.strokeStyle = 'rgba(0,0,0,0.08)';
    g.lineWidth = 1;
    for (let x = 0; x <= game.w; x++) { g.beginPath(); g.moveTo(x * TILE + 0.5, 0); g.lineTo(x * TILE + 0.5, game.h * TILE); g.stroke(); }
    for (let y = 0; y <= game.h; y++) { g.beginPath(); g.moveTo(0, y * TILE + 0.5); g.lineTo(game.w * TILE, y * TILE + 0.5); g.stroke(); }
    mapLayerDirty = false;
  }

  function drawConnected(g, game, x, y, test, colMain, colEdge, width) {
    const dx = x * TILE, dy = y * TILE;
    const wpx = width * PX, off = (16 - width) / 2 * PX;
    const n = test(game, x, y - 1), s = test(game, x, y + 1), w = test(game, x - 1, y), e = test(game, x + 1, y);
    g.fillStyle = colMain;
    g.fillRect(dx + off, dy + off, wpx, wpx);
    if (n) g.fillRect(dx + off, dy, wpx, off + wpx);
    if (s) g.fillRect(dx + off, dy + off, wpx, TILE - off);
    if (w) g.fillRect(dx, dy + off, off + wpx, wpx);
    if (e) g.fillRect(dx + off, dy + off, TILE - off, wpx);
    if (!n && !s && !w && !e) g.fillRect(dx + off, dy + off, wpx, wpx);
    g.fillStyle = colEdge;
    const c = 2 * PX;
    g.fillRect(dx + off + c, dy + off + c, wpx - 2 * c, wpx - 2 * c);
    if (n) g.fillRect(dx + off + c, dy, wpx - 2 * c, off + wpx);
    if (s) g.fillRect(dx + off + c, dy + off, wpx - 2 * c, TILE - off);
    if (w) g.fillRect(dx, dy + off + c, off + wpx, wpx - 2 * c);
    if (e) g.fillRect(dx + off, dy + off + c, TILE - off, wpx - 2 * c);
  }

  /* ---------- camera ---------- */
  function fitCamera(game) {
    const zw = canvas.width / (game.w * TILE);
    const zh = canvas.height / (game.h * TILE);
    cam.zoom = Math.min(zw, zh) * 0.96;
    cam.zoom = Math.max(cam.zoom, 0.35);
    cam.minZoom = Math.min(cam.zoom * 0.8, 0.4);
    cam.maxZoom = 2.4;
    cam.x = (game.w * TILE) / 2 - canvas.width / cam.zoom / 2;
    cam.y = (game.h * TILE) / 2 - canvas.height / cam.zoom / 2;
    clampCam(game);
  }

  function clampCam(game) {
    const vw = canvas.width / cam.zoom, vh = canvas.height / cam.zoom;
    const mw = game.w * TILE, mh = game.h * TILE;
    const mx = TILE * 1.5;
    if (mw < vw) cam.x = (mw - vw) / 2;
    else cam.x = Math.max(-mx, Math.min(mw - vw + mx, cam.x));
    if (mh < vh) cam.y = (mh - vh) / 2;
    else cam.y = Math.max(-mx, Math.min(mh - vh + mx, cam.y));
  }

  function focusTile(game, x, y, instant = false) {
    const tx = (x + 0.5) * TILE - canvas.width / cam.zoom / 2;
    const ty = (y + 0.5) * TILE - canvas.height / cam.zoom / 2;
    if (instant) { cam.x = tx; cam.y = ty; clampCam(game); }
    else camTarget = { x: tx, y: ty };
  }

  function screenToTile(sx, sy) {
    const r = canvas.getBoundingClientRect();
    const x = (sx - r.left) * (canvas.width / r.width) / cam.zoom + cam.x;
    const y = (sy - r.top) * (canvas.height / r.height) / cam.zoom + cam.y;
    return { x: Math.floor(x / TILE), y: Math.floor(y / TILE) };
  }

  /* ---------- effects ---------- */
  function addEffect(e) { effects.push({ ...e, t: 0 }); }
  function addShake(n) { shake = Math.max(shake, n); }

  /* ---------- main draw ---------- */
  function draw(game, view, dt) {
    time += dt;
    if (camTarget) {
      cam.x += (camTarget.x - cam.x) * Math.min(1, dt * 8);
      cam.y += (camTarget.y - cam.y) * Math.min(1, dt * 8);
      if (Math.abs(camTarget.x - cam.x) + Math.abs(camTarget.y - cam.y) < 2) camTarget = null;
      clampCam(game);
    }
    if (shake > 0) shake = Math.max(0, shake - dt * 30);

    ctx.fillStyle = '#1c2733';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (mapLayerDirty || !mapLayer) rebuildMapLayer(game);

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    const shx = shake ? (Math.random() - 0.5) * shake * 2 : 0;
    const shy = shake ? (Math.random() - 0.5) * shake * 2 : 0;
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x + shx, -cam.y + shy);

    ctx.drawImage(mapLayer, 0, 0);

    const vis = view.vision; // Set or null

    // fog dimming
    if (vis) {
      ctx.fillStyle = 'rgba(10,16,28,0.45)';
      for (let y = 0; y < game.h; y++)
        for (let x = 0; x < game.w; x++)
          if (!vis.has(x + ',' + y)) ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
    }

    // overlays: movement / attack / drop
    if (view.reachTiles) {
      for (const k of view.reachTiles) {
        const [x, y] = k.split(',').map(Number);
        pulseTile(x, y, 'rgba(70,160,255,0.38)', 'rgba(160,215,255,0.9)');
      }
    }
    if (view.dangerTiles) {
      for (const k of view.dangerTiles) {
        const [x, y] = k.split(',').map(Number);
        pulseTile(x, y, 'rgba(255,60,60,0.30)', 'rgba(255,120,120,0.8)');
      }
    }
    if (view.dropTiles) {
      for (const t of view.dropTiles) pulseTile(t.x, t.y, 'rgba(80,220,120,0.4)', 'rgba(160,255,190,0.9)');
    }

    // path arrow
    if (view.path && view.path.length > 1) {
      ctx.strokeStyle = 'rgba(255,235,120,0.95)';
      ctx.lineWidth = TILE * 0.18;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      view.path.forEach((p, i) => {
        const px = (p.x + 0.5) * TILE, py = (p.y + 0.5) * TILE;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
      const last = view.path[view.path.length - 1];
      ctx.fillStyle = 'rgba(255,235,120,0.95)';
      ctx.beginPath();
      ctx.arc((last.x + 0.5) * TILE, (last.y + 0.5) * TILE, TILE * 0.14, 0, Math.PI * 2);
      ctx.fill();
    }

    // capture progress badges on properties
    for (const k in game.props) {
      const p = game.props[k];
      if (p.cap < CAPTURE_POINTS && p.capper !== null) {
        const [x, y] = k.split(',').map(Number);
        if (vis && !vis.has(k)) continue;
        drawBadge(x * TILE + TILE - 14 * (TILE / 48), y * TILE + 2, String(p.cap), '#ffd24d');
      }
    }

    // units
    const sortedUnits = [...game.units].sort((a, b) => (a.y - b.y) || (AIR_UNITS.has(a.type) ? 1 : -1));
    for (const u of sortedUnits) {
      const pos = animPos.get(u.id) || u;
      if (vis && u.owner !== view.povPlayer && !vis.has(Math.round(pos.x) + ',' + Math.round(pos.y))) continue;
      drawUnit(game, u, pos.x, pos.y, view);
    }

    // attack target markers
    if (view.targets) {
      for (const t of view.targets) {
        const bounce = Math.sin(time * 6) * TILE * 0.06;
        crosshair((t.x + 0.5) * TILE, (t.y + 0.5) * TILE - bounce, TILE * 0.46);
      }
    }

    // cursor
    if (view.cursor) {
      corners(view.cursor.x * TILE, view.cursor.y * TILE, TILE, '#ffffff');
    }

    // effects
    effects = effects.filter(e => drawEffect(e, dt));

    ctx.restore();
  }

  function pulseTile(x, y, fill, edge) {
    ctx.fillStyle = fill;
    ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1.5;
    const inset = 1 + Math.sin(time * 4) * 0.8;
    ctx.strokeRect(x * TILE + inset, y * TILE + inset, TILE - inset * 2, TILE - inset * 2);
  }

  function corners(px, py, size, col) {
    const L = size * 0.28;
    ctx.strokeStyle = col;
    ctx.lineWidth = size * 0.09;
    ctx.lineCap = 'round';
    const o = size * 0.06 + Math.sin(time * 5) * size * 0.03;
    const pts = [
      [px - o, py - o, L, 0, 0, L], [px + size + o, py - o, -L, 0, 0, L],
      [px - o, py + size + o, L, 0, 0, -L], [px + size + o, py + size + o, -L, 0, 0, -L],
    ];
    for (const [cx, cy, dx1, dy1, dx2, dy2] of pts) {
      ctx.beginPath();
      ctx.moveTo(cx + dx1, cy + dy1); ctx.lineTo(cx, cy); ctx.lineTo(cx + dx2, cy + dy2);
      ctx.stroke();
    }
  }

  function crosshair(cx, cy, r) {
    ctx.strokeStyle = '#ff4b4b';
    ctx.lineWidth = r * 0.18;
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx - r * 0.45, cy);
    ctx.moveTo(cx + r, cy); ctx.lineTo(cx + r * 0.45, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy - r * 0.45);
    ctx.moveTo(cx, cy + r); ctx.lineTo(cx, cy + r * 0.45);
    ctx.stroke();
  }

  function drawUnit(game, u, tx, ty, view) {
    const px = tx * TILE, py = ty * TILE;
    let bob = 0;
    if (AIR_UNITS.has(u.type)) bob = Math.sin(time * 3 + u.id) * TILE * 0.05 - TILE * 0.08;
    else if (!u.acted && game.turn === u.owner && view.animatingUnit !== u.id) bob = Math.abs(Math.sin(time * 4 + u.id * 2)) * -TILE * 0.04;
    const img = sprites['U' + u.type + u.owner + (u.acted && game.turn === u.owner ? 'g' : '')];
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(px + TILE / 2, py + TILE * 0.88, TILE * 0.3, TILE * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.drawImage(img, px, py + bob);
    // selection ring
    if (view.selected === u.id) corners(px, py, TILE, '#ffe97a');
    // hp badge
    const dhp = Engine.displayHP(u);
    if (dhp < 10) drawBadge(px + TILE - 15 * (TILE / 48), py + bob + TILE - 16 * (TILE / 48), String(dhp), '#ffffff');
    // capture badge
    if (u.cappingAt) drawIcon(px + 1, py + bob + TILE - 15 * (TILE / 48), 'flag');
    // cargo badge
    if (u.cargo && u.cargo.length) drawIcon(px + 1, py + bob + 1, 'cargo');
  }

  function drawBadge(px, py, text, col) {
    const s = TILE / 48;
    ctx.fillStyle = 'rgba(10,12,18,0.85)';
    ctx.fillRect(px, py, 13 * s, 14 * s);
    ctx.fillStyle = col;
    ctx.font = `bold ${11 * s}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, px + 6.5 * s, py + 7.5 * s);
  }

  function drawIcon(px, py, kind) {
    const s = TILE / 48;
    if (kind === 'flag') {
      ctx.fillStyle = '#2b2b33';
      ctx.fillRect(px + 2 * s, py, 2 * s, 14 * s);
      ctx.fillStyle = '#ffd24d';
      ctx.fillRect(px + 4 * s, py, 8 * s, 6 * s);
    } else if (kind === 'cargo') {
      ctx.fillStyle = 'rgba(10,12,18,0.85)';
      ctx.fillRect(px, py, 12 * s, 12 * s);
      ctx.fillStyle = '#c9995a';
      ctx.fillRect(px + 2 * s, py + 2 * s, 8 * s, 8 * s);
      ctx.fillStyle = '#8a6534';
      ctx.fillRect(px + 2 * s, py + 5 * s, 8 * s, 2 * s);
    }
  }

  function drawEffect(e, dt) {
    e.t += dt;
    if (e.type === 'explosion') {
      const T = 0.5;
      if (e.t > T) return false;
      const k = e.t / T;
      const cx = (e.x + 0.5) * TILE, cy = (e.y + 0.5) * TILE;
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2 + e.x * 3;
        const d = k * TILE * 0.7;
        ctx.fillStyle = i % 2 ? `rgba(255,${180 - k * 150 | 0},40,${1 - k})` : `rgba(90,90,90,${1 - k})`;
        const r = TILE * 0.12 * (1 - k * 0.6);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(ang) * d, cy + Math.sin(ang) * d - k * TILE * 0.2, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = `rgba(255,220,120,${(1 - k) * 0.9})`;
      ctx.beginPath(); ctx.arc(cx, cy, TILE * 0.35 * (1 - k * 0.5), 0, Math.PI * 2); ctx.fill();
      return true;
    }
    if (e.type === 'text') {
      const T = 0.9;
      if (e.t > T) return false;
      const k = e.t / T;
      ctx.font = `bold ${TILE * 0.38}px "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(10,12,18,' + (1 - k) + ')';
      ctx.fillStyle = e.color.replace('ALPHA', String(1 - k));
      const ty = (e.y + 0.3) * TILE - k * TILE * 0.6;
      ctx.strokeText(e.text, (e.x + 0.5) * TILE, ty);
      ctx.fillText(e.text, (e.x + 0.5) * TILE, ty);
      return true;
    }
    if (e.type === 'muzzle') {
      const T = 0.15;
      if (e.t > T) return false;
      const k = e.t / T;
      ctx.fillStyle = `rgba(255,240,160,${1 - k})`;
      ctx.beginPath();
      ctx.arc((e.x + 0.5) * TILE, (e.y + 0.4) * TILE, TILE * 0.28 * (1 - k * 0.4), 0, Math.PI * 2);
      ctx.fill();
      return true;
    }
    if (e.type === 'spark') { // capture / heal sparkle
      const T = 0.7;
      if (e.t > T) return false;
      const k = e.t / T;
      ctx.fillStyle = `rgba(255,230,120,${1 - k})`;
      for (let i = 0; i < 5; i++) {
        const ang = i * 1.256 + k * 2;
        ctx.fillRect((e.x + 0.5) * TILE + Math.cos(ang) * k * TILE * 0.5 - 2,
                     (e.y + 0.4) * TILE + Math.sin(ang) * k * TILE * 0.5 - 2, 4, 4);
      }
      return true;
    }
    return false;
  }

  /* ---------- init / resize ---------- */
  function init(cv) {
    canvas = cv;
    ctx = canvas.getContext('2d');
    buildTerrainSprites();
    resize();
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
  }

  return {
    TILE, init, resize, draw,
    cam, fitCamera, clampCam, focusTile, screenToTile,
    addEffect, addShake,
    animPos,
    invalidateMap: () => { mapLayerDirty = true; },
    zoomAt: (factor, sx, sy) => {
      const r = canvas.getBoundingClientRect();
      const cx = (sx - r.left) * (canvas.width / r.width);
      const cy = (sy - r.top) * (canvas.height / r.height);
      const wx = cam.x + cx / cam.zoom;
      const wy = cam.y + cy / cam.zoom;
      cam.zoom = Math.max(cam.minZoom || 0.4, Math.min(cam.maxZoom || 2.4, cam.zoom * factor));
      cam.x = wx - cx / cam.zoom;
      cam.y = wy - cy / cam.zoom;
    },
    pan: (dx, dy) => { cam.x += dx / cam.zoom; cam.y += dy / cam.zoom; camTarget = null; },
    getSprite: (k) => sprites[k],
  };
})();
