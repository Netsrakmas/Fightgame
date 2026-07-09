/* Micro Wars — WebAudio sound effects + tiny chiptune loops. No assets needed. */
'use strict';

const Sound = (() => {
  let ctx = null;
  let muted = JSON.parse(localStorage.getItem('mw_muted') || 'false');
  let musicTimer = null;
  let musicGain = null;
  let currentSong = null;

  function ac() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      musicGain = ctx.createGain();
      musicGain.gain.value = 0.12;
      musicGain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function beep(freq, dur, type = 'square', vol = 0.15, slide = 0) {
    if (muted) return;
    try {
      const a = ac();
      const o = a.createOscillator();
      const g = a.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, a.currentTime);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), a.currentTime + dur);
      g.gain.setValueAtTime(vol, a.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
      o.connect(g); g.connect(a.destination);
      o.start(); o.stop(a.currentTime + dur);
    } catch (e) { /* audio unavailable */ }
  }

  function noise(dur, vol = 0.2, low = false) {
    if (muted) return;
    try {
      const a = ac();
      const buf = a.createBuffer(1, a.sampleRate * dur, a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const src = a.createBufferSource();
      src.buffer = buf;
      const g = a.createGain();
      g.gain.setValueAtTime(vol, a.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
      let node = src;
      if (low) {
        const f = a.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = 400;
        src.connect(f); node = f;
      }
      node.connect(g); g.connect(a.destination);
      src.start();
    } catch (e) { /* audio unavailable */ }
  }

  const sfx = {
    tap:     () => beep(660, 0.05, 'square', 0.08),
    select:  () => { beep(520, 0.06, 'square', 0.1); setTimeout(() => beep(780, 0.06, 'square', 0.1), 50); },
    cancel:  () => beep(300, 0.08, 'square', 0.1, -100),
    move:    () => beep(440, 0.1, 'triangle', 0.1, 220),
    shot:    () => { noise(0.15, 0.25); beep(180, 0.12, 'sawtooth', 0.15, -120); },
    boom:    () => { noise(0.4, 0.35, true); beep(90, 0.3, 'sawtooth', 0.2, -60); },
    capture: () => { beep(392, 0.09, 'square', 0.12); setTimeout(() => beep(523, 0.09, 'square', 0.12), 90); setTimeout(() => beep(659, 0.12, 'square', 0.12), 180); },
    build:   () => { beep(330, 0.07, 'square', 0.1); setTimeout(() => beep(440, 0.07, 'square', 0.1), 70); },
    coin:    () => { beep(988, 0.06, 'square', 0.1); setTimeout(() => beep(1319, 0.1, 'square', 0.1), 60); },
    turn:    () => { beep(523, 0.1, 'triangle', 0.15); setTimeout(() => beep(659, 0.1, 'triangle', 0.15), 110); setTimeout(() => beep(784, 0.15, 'triangle', 0.15), 220); },
    win:     () => { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, 0.2, 'square', 0.14), i * 150)); },
    lose:    () => { [392, 349, 311, 262].forEach((f, i) => setTimeout(() => beep(f, 0.25, 'sawtooth', 0.1), i * 180)); },
    heal:    () => { beep(587, 0.08, 'sine', 0.12); setTimeout(() => beep(880, 0.12, 'sine', 0.12), 80); },
  };

  /* Tiny looping songs: arrays of [semitone-from-A3 or null, beats] */
  const SONGS = {
    menu: { bpm: 96, bass: [0, 0, 5, 5, 3, 3, 5, 7], lead: [12, null, 15, 12, 17, 15, 12, 10, 12, null, 15, 17, 19, 17, 15, 12] },
    battle: { bpm: 132, bass: [0, 0, 0, 0, 3, 3, 3, 3, 5, 5, 5, 5, 3, 3, 7, 7], lead: [12, 12, null, 12, 15, null, 12, null, 17, 15, 12, null, 10, 12, null, null] },
  };

  function noteFreq(semi) { return 220 * Math.pow(2, semi / 12); }

  function playSong(name) {
    if (currentSong === name) return;
    stopMusic();
    currentSong = name;
    const song = SONGS[name];
    if (!song) return;
    let step = 0;
    const stepDur = 60 / song.bpm / 2;
    musicTimer = setInterval(() => {
      if (muted || document.hidden) { step++; return; }
      try {
        const a = ac();
        const bass = song.bass[step % song.bass.length];
        const lead = song.lead[step % song.lead.length];
        if (bass !== null && step % 2 === 0) tone(a, noteFreq(bass - 12), stepDur * 1.8, 'triangle', 0.5);
        if (lead !== null) tone(a, noteFreq(lead), stepDur * 0.9, 'square', 0.28);
      } catch (e) { /* ignore */ }
      step++;
    }, stepDur * 1000);
  }

  function tone(a, freq, dur, type, vol) {
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
    o.connect(g); g.connect(musicGain);
    o.start(); o.stop(a.currentTime + dur);
  }

  function stopMusic() {
    if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
    currentSong = null;
  }

  function setMuted(m) {
    muted = m;
    localStorage.setItem('mw_muted', JSON.stringify(m));
  }

  return { sfx, playSong, stopMusic, setMuted, isMuted: () => muted, unlock: () => { try { ac(); } catch (e) {} } };
})();
