(() => {
  "use strict";

  const STORAGE_KEY = "focus-pomodoro-state-v1";
  const CIRC = 2 * Math.PI * 150; // matches r=150 in the SVG ring

  const defaultSettings = {
    durations: { focus: 25, short: 5, long: 15 },
    longEvery: 4,
    autoStartBreaks: false,
    autoStartFocus: false,
    tickSound: false,
    notify: false,
    ambient: "none",
    muted: false,
  };

  const defaultStats = { totalCompleted: 0, dailyCounts: {} };

  // Real solar-system data: a = semi-major axis (AU), T = orbital period (Earth days)
  const PLANETS = [
    { name: "mercury", a: 0.387, T: 87.969 },
    { name: "venus",   a: 0.723, T: 224.701 },
    { name: "earth",   a: 1.000, T: 365.256 },
    { name: "mars",    a: 1.524, T: 686.980 },
    { name: "jupiter", a: 5.204, T: 4332.589 },
    { name: "saturn",  a: 9.583, T: 10759.22 },
    { name: "uranus",  a: 19.191, T: 30688.5 },
    { name: "neptune", a: 30.070, T: 60182.0 },
    { name: "pluto",   a: 39.482, T: 90560.0 },
  ];

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function saveState() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ settings, stats, note })
    );
  }

  const saved = loadState() || {};
  let settings = { ...defaultSettings, ...(saved.settings || {}) };
  settings.durations = { ...defaultSettings.durations, ...(saved.settings && saved.settings.durations) };
  let stats = { ...defaultStats, ...(saved.stats || {}) };
  let note = saved.note || "";

  const todayKey = () => new Date().toISOString().slice(0, 10);

  const MODES = {
    focus: { label: "Focus", colorVar: "--focus-1", colorDark: "--focus-2" },
    short: { label: "Short Break", colorVar: "--short-1", colorDark: "--short-2" },
    long: { label: "Long Break", colorVar: "--long-1", colorDark: "--long-2" },
  };

  let mode = "focus";
  let secondsLeft = settings.durations.focus * 60;
  let totalSeconds = secondsLeft;
  let running = false;
  let timerId = null;
  let sessionCount = 1;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const timeDisplay = $("timeDisplay");
  const ringProgress = $("ringProgress");
  const startPauseBtn = $("startPauseBtn");
  const playIcon = $("playIcon");
  const pauseIcon = $("pauseIcon");
  const resetBtn = $("resetBtn");
  const skipBtn = $("skipBtn");
  const modeTabs = document.querySelectorAll(".mode-tab");
  const todayCountEl = $("todayCount");
  const totalCountEl = $("totalCount");
  const solar = $("solar");

  const menuBtn = $("menuBtn");
  const closeDrawerBtn = $("closeDrawerBtn");
  const drawer = $("drawer");
  const drawerScrim = $("drawerScrim");
  const saveSettingsBtn = $("saveSettingsBtn");
  const resetStatsBtn = $("resetStatsBtn");
  const muteToggle = $("muteToggle");

  const focusDurInput = $("focusDur");
  const shortDurInput = $("shortDur");
  const longDurInput = $("longDur");
  const longEveryInput = $("longEvery");
  const autoStartBreaksInput = $("autoStartBreaks");
  const autoStartFocusInput = $("autoStartFocus");
  const tickSoundInput = $("tickSound");
  const notifyToggleInput = $("notifyToggle");
  const ambientOptions = $("ambientOptions");

  ringProgress.style.strokeDasharray = String(CIRC);

  // ---------- Solar-system simulation ----------
  // Distance: proportional to the LOG of the real semi-major axis, so all nine
  // bodies stay visible and spread out (a true linear AU scale would put Pluto
  // ~100x farther than Mercury — impossible to show on one screen).
  // Speed: every planet completes exactly one full orbit per minute (60s).
  const R_MIN = 158; // just outside the sun/ring
  const ORBIT_SECONDS = 60; // one full rotation per minute, for every planet
  const logMin = Math.log(PLANETS[0].a);
  const logMax = Math.log(PLANETS[PLANETS.length - 1].a);

  // Distinct starting angles so planets don't stack at 12 o'clock while paused
  const PHASE = {
    mercury: 0.05, venus: 0.62, earth: 0.28, mars: 0.85, jupiter: 0.45,
    saturn: 0.72, uranus: 0.15, neptune: 0.90, pluto: 0.38,
  };

  function currentRMax() {
    // Largest orbit must stay on screen vertically
    const halfMin = Math.min(window.innerWidth, window.innerHeight) / 2;
    return Math.max(R_MIN + 40, halfMin - 34);
  }

  function applyOrbits() {
    const rMax = currentRMax();
    PLANETS.forEach((p) => {
      const orbit = solar.querySelector(`.orbit[data-planet="${p.name}"]`);
      if (!orbit) return;
      const frac = (Math.log(p.a) - logMin) / (logMax - logMin);
      const radius = R_MIN + frac * (rMax - R_MIN);
      orbit.style.width = orbit.style.height = `${radius * 2}px`;
      orbit.style.animationDuration = `${ORBIT_SECONDS}s`;
      orbit.style.animationDelay = `-${(PHASE[p.name] || 0) * ORBIT_SECONDS}s`;
    });
  }

  // ---------- Audio ----------
  let audioCtx = null;
  function ctx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function playChime() {
    if (settings.muted) return;
    const ac = ctx();
    const now = ac.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + i * 0.14;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
      osc.connect(gain).connect(ac.destination);
      osc.start(start);
      osc.stop(start + 0.55);
    });
  }

  function playTick() {
    if (settings.muted || !settings.tickSound) return;
    const ac = ctx();
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "square";
    osc.frequency.value = 1000;
    gain.gain.setValueAtTime(0.05, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  // Ambient noise
  let ambientSource = null;
  let ambientGain = null;

  function makeNoiseBuffer(kind) {
    const ac = ctx();
    const bufferSize = ac.sampleRate * 2;
    const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
    const data = buffer.getChannelData(0);
    if (kind === "white" || kind === "rain") {
      let b0 = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        if (kind === "rain") {
          b0 = 0.98 * b0 + 0.02 * white;
          data[i] = b0 * 3 + white * 0.15;
        } else {
          data[i] = white * 0.6;
        }
      }
    } else if (kind === "brown") {
      let last = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      }
    }
    return buffer;
  }

  function stopAmbient() {
    if (ambientSource) {
      try { ambientSource.stop(); } catch {}
      ambientSource.disconnect();
      ambientSource = null;
    }
    if (ambientGain) {
      ambientGain.disconnect();
      ambientGain = null;
    }
  }

  function startAmbient(kind) {
    stopAmbient();
    if (kind === "none" || settings.muted) return;
    const ac = ctx();
    const buffer = makeNoiseBuffer(kind);
    const source = ac.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = ac.createGain();
    gain.gain.value = 0.22;
    if (kind === "rain") {
      const filter = ac.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 2200;
      source.connect(filter);
      filter.connect(gain);
    } else {
      source.connect(gain);
    }
    gain.connect(ac.destination);
    source.start();
    ambientSource = source;
    ambientGain = gain;
  }

  function refreshAmbient() {
    if (running && settings.ambient !== "none") startAmbient(settings.ambient);
    else stopAmbient();
  }

  // ---------- Notifications ----------
  function notify(title, bodyText) {
    if (!settings.notify) return;
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
      new Notification(title, { body: bodyText });
    }
  }

  // ---------- Rendering ----------
  function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  function applyModeColors() {
    const root = document.documentElement.style;
    const cfg = MODES[mode];
    root.setProperty("--accent", `var(${cfg.colorVar})`);
    root.setProperty("--accent-dark", `var(${cfg.colorDark})`);
    body.dataset.mode = mode;
  }

  function render() {
    timeDisplay.textContent = formatTime(secondsLeft);
    document.title = `${formatTime(secondsLeft)} · ${MODES[mode].label} — Focus`;

    const progress = totalSeconds > 0 ? (totalSeconds - secondsLeft) / totalSeconds : 0;
    ringProgress.style.strokeDashoffset = String(CIRC * (1 - progress));

    modeTabs.forEach((tab) => {
      const isActive = tab.dataset.mode === mode;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
    });

    playIcon.style.display = running ? "none" : "block";
    pauseIcon.style.display = running ? "block" : "none";

    todayCountEl.textContent = stats.dailyCounts[todayKey()] || 0;
    totalCountEl.textContent = stats.totalCompleted || 0;
  }

  function switchMode(newMode, { autoStarted = false } = {}) {
    mode = newMode;
    applyModeColors();
    totalSeconds = settings.durations[mode] * 60;
    secondsLeft = totalSeconds;
    stopTimer();
    render();
    const shouldAuto =
      (mode === "focus" && settings.autoStartFocus) ||
      (mode !== "focus" && settings.autoStartBreaks);
    if (autoStarted && shouldAuto) startTimer();
  }

  function stopTimer() {
    running = false;
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
    setOrbitsPaused(true);
    refreshAmbient();
  }

  function startTimer() {
    if (running) return;
    running = true;
    ctx();
    setOrbitsPaused(false);
    refreshAmbient();
    timerId = setInterval(tick, 1000);
    render();
  }

  function pauseTimer() {
    stopTimer();
    render();
  }

  // Planets only revolve while the timer is running (the simulation tracks focus time)
  function setOrbitsPaused(paused) {
    solar.querySelectorAll(".orbit").forEach((o) => {
      o.style.animationPlayState = paused ? "paused" : "running";
    });
  }

  function tick() {
    secondsLeft -= 1;
    playTick();
    if (secondsLeft <= 0) {
      completeSession();
      return;
    }
    render();
  }

  function completeSession() {
    stopTimer();
    playChime();
    if (mode === "focus") {
      const key = todayKey();
      stats.dailyCounts[key] = (stats.dailyCounts[key] || 0) + 1;
      stats.totalCompleted += 1;
      notify("Focus session complete", "Time for a break.");
      const next = sessionCount >= settings.longEvery ? "long" : "short";
      if (next === "long") sessionCount = 1;
      else sessionCount += 1;
      switchMode(next, { autoStarted: true });
    } else {
      notify("Break's over", "Ready to focus again?");
      switchMode("focus", { autoStarted: true });
    }
    saveState();
  }

  function resetTimer() {
    stopTimer();
    secondsLeft = settings.durations[mode] * 60;
    totalSeconds = secondsLeft;
    render();
  }

  function skipSession() {
    stopTimer();
    if (mode === "focus") {
      const next = sessionCount >= settings.longEvery ? "long" : "short";
      if (next === "long") sessionCount = 1;
      else sessionCount += 1;
      switchMode(next);
    } else {
      switchMode("focus");
    }
  }

  // ---------- Controls ----------
  startPauseBtn.addEventListener("click", () => {
    if (running) pauseTimer();
    else startTimer();
  });

  resetBtn.addEventListener("click", resetTimer);
  skipBtn.addEventListener("click", skipSession);

  modeTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      sessionCount = 1;
      switchMode(tab.dataset.mode);
      closeDrawer();
    });
  });

  document.addEventListener("keydown", (e) => {
    if (document.activeElement && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    if (e.code === "Space") {
      e.preventDefault();
      running ? pauseTimer() : startTimer();
    } else if (e.key === "r" || e.key === "R") {
      resetTimer();
    }
  });

  // ---------- Drawer ----------
  function openDrawer() {
    focusDurInput.value = settings.durations.focus;
    shortDurInput.value = settings.durations.short;
    longDurInput.value = settings.durations.long;
    longEveryInput.value = settings.longEvery;
    autoStartBreaksInput.checked = settings.autoStartBreaks;
    autoStartFocusInput.checked = settings.autoStartFocus;
    tickSoundInput.checked = settings.tickSound;
    notifyToggleInput.checked = settings.notify;
    muteToggle.checked = settings.muted;
    ambientOptions.querySelectorAll(".ambient-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.sound === settings.ambient);
    });
    render();
    drawer.classList.add("open");
    drawerScrim.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
  }

  function closeDrawer() {
    drawer.classList.remove("open");
    drawerScrim.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
  }

  menuBtn.addEventListener("click", openDrawer);
  closeDrawerBtn.addEventListener("click", closeDrawer);
  drawerScrim.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });

  ambientOptions.addEventListener("click", (e) => {
    const btn = e.target.closest(".ambient-btn");
    if (!btn) return;
    ambientOptions.querySelectorAll(".ambient-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    settings.ambient = btn.dataset.sound;
    refreshAmbient();
  });

  notifyToggleInput.addEventListener("change", () => {
    if (notifyToggleInput.checked && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().then((perm) => {
        if (perm !== "granted") notifyToggleInput.checked = false;
      });
    }
  });

  saveSettingsBtn.addEventListener("click", () => {
    settings.durations.focus = clampInt(focusDurInput.value, 1, 180, settings.durations.focus);
    settings.durations.short = clampInt(shortDurInput.value, 1, 60, settings.durations.short);
    settings.durations.long = clampInt(longDurInput.value, 1, 90, settings.durations.long);
    settings.longEvery = clampInt(longEveryInput.value, 2, 12, settings.longEvery);
    settings.autoStartBreaks = autoStartBreaksInput.checked;
    settings.autoStartFocus = autoStartFocusInput.checked;
    settings.tickSound = tickSoundInput.checked;
    settings.notify = notifyToggleInput.checked;

    if (!running) {
      totalSeconds = settings.durations[mode] * 60;
      secondsLeft = totalSeconds;
    }

    applyOrbits();
    saveState();
    render();
    closeDrawer();
  });

  resetStatsBtn.addEventListener("click", () => {
    if (!confirm("Reset all stats and today's count?")) return;
    stats = { totalCompleted: 0, dailyCounts: {} };
    saveState();
    render();
  });

  function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  // ---------- Mute ----------
  muteToggle.addEventListener("change", () => {
    settings.muted = muteToggle.checked;
    refreshAmbient();
    saveState();
  });

  // ---------- Starfield ----------
  function buildStars() {
    const stars = $("stars");
    if (!stars) return;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 130; i++) {
      const s = document.createElement("span");
      s.className = "star";
      const size = Math.random() < 0.15 ? 3 : Math.random() < 0.5 ? 2 : 1;
      s.style.width = s.style.height = `${size}px`;
      s.style.left = `${Math.random() * 100}%`;
      s.style.top = `${Math.random() * 100}%`;
      s.style.setProperty("--tw", `${2 + Math.random() * 5}s`);
      s.style.animationDelay = `${Math.random() * 5}s`;
      frag.appendChild(s);
    }
    stars.appendChild(frag);
  }

  // ---------- Init ----------
  buildStars();
  applyOrbits();
  setOrbitsPaused(true);
  applyModeColors();
  render();

  let resizeRAF = null;
  window.addEventListener("resize", () => {
    if (resizeRAF) cancelAnimationFrame(resizeRAF);
    resizeRAF = requestAnimationFrame(applyOrbits);
  });

  window.addEventListener("beforeunload", saveState);
})();
