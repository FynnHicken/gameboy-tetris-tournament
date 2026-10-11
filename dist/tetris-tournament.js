/**
 * Game Boy DMG Tetris Tournament Arena & Heuristic CPU Opponent Engine
 * Supports:
 * - Authentic 4-shade DMG LCD rendering (10x20 Player Board + Live Opponent Mini-Board)
 * - Synchronized Seeded PRNG (fair tournament Tetromino sequence for both players)
 * - 2-Player Link-Cable Garbage Line Attacks (Double=+1, Triple=+2, Tetris=+4)
 * - Smart Heuristic CPU AI (Easy / Normal / Hard) for odd-player tournament filling
 * - Live Spectator Split-Screen for watching active tournament matches
 * - 8-Bit Chiptune Music (Type-A Korobeiniki) & Retro SFX via Web Audio API
 */

(function() {
  const COLS = 10;
  const ROWS = 20;

  // Classic 4-shade Game Boy DMG Palette
  const DMG = {
    BG_LIGHT: '#9bbc0f',
    BG_MID:   '#8bac0f',
    INK_DARK: '#306230',
    INK_DEEP: '#0f380f',
    ALERT:    '#7a1c1c'
  };

  // Authentic Game Boy Tetromino definitions (4 rotations each)
  const TETROMINOES = {
    I: {
      id: 1,
      shade: 2,
      rotations: [
        [[0,1],[1,1],[2,1],[3,1]],
        [[2,0],[2,1],[2,2],[2,3]],
        [[0,2],[1,2],[2,2],[3,2]],
        [[1,0],[1,1],[1,2],[1,3]]
      ]
    },
    O: {
      id: 2,
      shade: 3,
      rotations: [
        [[1,0],[2,0],[1,1],[2,1]],
        [[1,0],[2,0],[1,1],[2,1]],
        [[1,0],[2,0],[1,1],[2,1]],
        [[1,0],[2,0],[1,1],[2,1]]
      ]
    },
    T: {
      id: 3,
      shade: 2,
      rotations: [
        [[1,0],[0,1],[1,1],[2,1]],
        [[1,0],[1,1],[2,1],[1,2]],
        [[0,1],[1,1],[2,1],[1,2]],
        [[1,0],[0,1],[1,1],[1,2]]
      ]
    },
    S: {
      id: 4,
      shade: 1,
      rotations: [
        [[1,0],[2,0],[0,1],[1,1]],
        [[1,0],[1,1],[2,1],[2,2]],
        [[1,1],[2,1],[0,2],[1,2]],
        [[0,0],[0,1],[1,1],[1,2]]
      ]
    },
    Z: {
      id: 5,
      shade: 3,
      rotations: [
        [[0,0],[1,0],[1,1],[2,1]],
        [[2,0],[1,1],[2,1],[1,2]],
        [[0,1],[1,1],[1,2],[2,2]],
        [[1,0],[0,1],[1,1],[0,2]]
      ]
    },
    J: {
      id: 6,
      shade: 1,
      rotations: [
        [[0,0],[0,1],[1,1],[2,1]],
        [[1,0],[2,0],[1,1],[1,2]],
        [[0,1],[1,1],[2,1],[2,2]],
        [[1,0],[1,1],[0,2],[1,2]]
      ]
    },
    L: {
      id: 7,
      shade: 3,
      rotations: [
        [[2,0],[0,1],[1,1],[2,1]],
        [[1,0],[1,1],[1,2],[2,2]],
        [[0,1],[1,1],[2,1],[0,2]],
        [[0,0],[1,0],[1,1],[1,2]]
      ]
    }
  };

  const PIECE_KEYS = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

  // Mulberry32 deterministic PRNG for synchronized tournament piece sequences
  function createSeededRng(seed) {
    let a = (seed >>> 0) || 123456789;
    return function() {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 8-Bit Chiptune Audio Engine (Type-A Korobeiniki + Game Boy SFX)
  class ChiptuneSoundEngine {
    constructor() {
      this.ctx = null;
      this.muted = localStorage.getItem('gb_tetris_muted') === '1';
      this.musicTimer = null;
      this.noteIndex = 0;

      // Korobeiniki (Tetris Type-A) melody [freqHz, durationBeats]
      this.melody = [
        [659.25, 1.0], [493.88, 0.5], [523.25, 0.5], [587.33, 1.0], [523.25, 0.5], [493.88, 0.5],
        [440.00, 1.0], [440.00, 0.5], [523.25, 0.5], [659.25, 1.0], [587.33, 0.5], [523.25, 0.5],
        [493.88, 1.5], [523.25, 0.5], [587.33, 1.0], [659.25, 1.0],
        [523.25, 1.0], [440.00, 1.0], [440.00, 1.5], [0, 0.5],
        [587.33, 1.5], [698.46, 0.5], [880.00, 1.0], [783.99, 0.5], [698.46, 0.5],
        [659.25, 1.5], [523.25, 0.5], [659.25, 1.0], [587.33, 0.5], [523.25, 0.5],
        [493.88, 1.0], [493.88, 0.5], [523.25, 0.5], [587.33, 1.0], [659.25, 1.0],
        [523.25, 1.0], [440.00, 1.0], [440.00, 1.5], [0, 0.5]
      ];
    }

    ensureContext() {
      if (this.muted) return null;
      try {
        if (!this.ctx) {
          this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.ctx.state === 'suspended') {
          this.ctx.resume();
        }
        return this.ctx;
      } catch (e) {
        return null;
      }
    }

    beep(freq, type = 'square', duration = 0.06, gainVal = 0.045) {
      const ctx = this.ensureContext();
      if (!ctx || !freq) return;
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        gain.gain.setValueAtTime(gainVal, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + duration);
      } catch (e) {}
    }

    playMove() { this.beep(330, 'square', 0.025, 0.03); }
    playRotate() { this.beep(520, 'square', 0.04, 0.035); }
    playLock() { this.beep(160, 'triangle', 0.05, 0.05); }
    playLineClear(lines) {
      if (lines >= 4) {
        [523, 659, 784, 1046].forEach((f, idx) => {
          setTimeout(() => this.beep(f, 'square', 0.09, 0.055), idx * 55);
        });
      } else {
        [440, 659].forEach((f, idx) => {
          setTimeout(() => this.beep(f, 'square', 0.07, 0.045), idx * 50);
        });
      }
    }
    playGarbageIncoming() {
      [220, 175].forEach((f, idx) => {
        setTimeout(() => this.beep(f, 'sawtooth', 0.08, 0.05), idx * 60);
      });
    }
    playWin() {
      [523, 659, 784, 1046, 1318].forEach((f, idx) => {
        setTimeout(() => this.beep(f, 'square', 0.12, 0.05), idx * 80);
      });
    }
    playLose() {
      [392, 349, 311, 261].forEach((f, idx) => {
        setTimeout(() => this.beep(f, 'sawtooth', 0.14, 0.045), idx * 95);
      });
    }

    startMusic(tempoMultiplier = 1.0) {
      this.stopMusic();
      if (this.muted) return;
      this.noteIndex = 0;
      const stepNote = () => {
        if (this.muted || !this.musicActive) return;
        const [freq, beats] = this.melody[this.noteIndex % this.melody.length];
        this.noteIndex++;
        const beatMs = Math.max(95, 195 / tempoMultiplier);
        const durSec = (beats * beatMs * 0.82) / 1000;
        if (freq > 0) {
          this.beep(freq, 'square', durSec, 0.022);
        }
        this.musicTimer = setTimeout(stepNote, beats * beatMs);
      };
      this.musicActive = true;
      stepNote();
    }

    stopMusic() {
      this.musicActive = false;
      if (this.musicTimer) {
        clearTimeout(this.musicTimer);
        this.musicTimer = null;
      }
    }

    toggleMute() {
      this.muted = !this.muted;
      localStorage.setItem('gb_tetris_muted', this.muted ? '1' : '0');
      if (this.muted) this.stopMusic();
      return this.muted;
    }
  }

  // ==========================================================================
  // 🧠 HEURISTIC CPU BOT ENGINE (Evaluates board state & plays in real time)
  // ==========================================================================
  function createEmptyBoard() {
    const grid = [];
    for (let r = 0; r < ROWS; r++) {
      grid.push(new Uint8Array(COLS));
    }
    return grid;
  }

  function cloneBoard(grid) {
    return grid.map(row => new Uint8Array(row));
  }

  function collides(grid, typeKey, rotIdx, px, py) {
    const cells = TETROMINOES[typeKey].rotations[rotIdx & 3];
    for (let i = 0; i < cells.length; i++) {
      const cx = px + cells[i][0];
      const cy = py + cells[i][1];
      if (cx < 0 || cx >= COLS || cy >= ROWS) return true;
      if (cy >= 0 && grid[cy][cx] !== 0) return true;
    }
    return false;
  }

  function lockPieceOnBoard(grid, typeKey, rotIdx, px, py) {
    const cells = TETROMINOES[typeKey].rotations[rotIdx & 3];
    const id = TETROMINOES[typeKey].id;
    for (let i = 0; i < cells.length; i++) {
      const cx = px + cells[i][0];
      const cy = py + cells[i][1];
      if (cy >= 0 && cy < ROWS && cx >= 0 && cx < COLS) {
        grid[cy][cx] = id;
      }
    }
  }

  function clearCompletedLines(grid) {
    let cleared = 0;
    for (let r = ROWS - 1; r >= 0; r--) {
      let full = true;
      for (let c = 0; c < COLS; c++) {
        if (grid[r][c] === 0) {
          full = false;
          break;
        }
      }
      if (full) {
        grid.splice(r, 1);
        grid.unshift(new Uint8Array(COLS));
        cleared++;
        r++;
      }
    }
    return cleared;
  }

  function insertGarbageLines(grid, count, holeCol) {
    const col = (typeof holeCol === 'number' && holeCol >= 0 && holeCol < COLS)
      ? holeCol
      : Math.floor(Math.random() * COLS);
    for (let i = 0; i < count; i++) {
      grid.shift();
      const garbageRow = new Uint8Array(COLS);
      for (let c = 0; c < COLS; c++) {
        garbageRow[c] = (c === col) ? 0 : 8; // 8 = Garbage shade
      }
      grid.push(garbageRow);
    }
  }

  function computeGarbageToSend(clearedLines, comboCount) {
    let base = 0;
    if (clearedLines === 2) base = 1;
    else if (clearedLines === 3) base = 2;
    else if (clearedLines >= 4) base = 4;
    if (base > 0 && comboCount > 1) {
      base += 1;
    }
    return base;
  }

  /**
   * Find best target rotation & X position for the CPU opponent
   */
  function findBestCpuPlacement(grid, typeKey, difficulty) {
    let bestScore = -Infinity;
    let bestMove = { rot: 0, x: 3 };

    // Add slight human imperfection on easy/normal
    const noiseAmp = difficulty === 'easy' ? 3.2 : (difficulty === 'normal' ? 0.75 : 0.05);

    for (let rot = 0; rot < 4; rot++) {
      for (let x = -2; x < COLS; x++) {
        if (collides(grid, typeKey, rot, x, 0)) continue;
        let y = 0;
        while (!collides(grid, typeKey, rot, x, y + 1)) {
          y++;
        }

        const sim = cloneBoard(grid);
        lockPieceOnBoard(sim, typeKey, rot, x, y);
        const cleared = clearCompletedLines(sim);

        // Compute heuristic metrics: column heights, aggregate height, holes, bumpiness
        const heights = new Array(COLS).fill(0);
        let holes = 0;

        for (let c = 0; c < COLS; c++) {
          let foundTop = false;
          for (let r = 0; r < ROWS; r++) {
            if (sim[r][c] !== 0) {
              if (!foundTop) {
                heights[c] = ROWS - r;
                foundTop = true;
              }
            } else if (foundTop) {
              holes++;
            }
          }
        }

        let aggHeight = 0;
        let bumpiness = 0;
        let maxHeight = 0;
        for (let c = 0; c < COLS; c++) {
          aggHeight += heights[c];
          if (heights[c] > maxHeight) maxHeight = heights[c];
          if (c > 0) bumpiness += Math.abs(heights[c] - heights[c - 1]);
        }

        // Reward multi-line clears strongly (for sending garbage lines!)
        const lineBonus = cleared === 4 ? 5.5 : (cleared === 3 ? 2.8 : (cleared === 2 ? 1.7 : cleared * 0.75));
        const score =
          (lineBonus * 1.2) -
          (0.51 * aggHeight) -
          (0.85 * holes) -
          (0.21 * bumpiness) -
          (maxHeight > 15 ? (maxHeight - 15) * 1.1 : 0) +
          ((Math.random() - 0.5) * noiseAmp);

        if (score > bestScore) {
          bestScore = score;
          bestMove = { rot, x };
        }
      }
    }

    return bestMove;
  }

  function serializeBoard(grid, activePiece) {
    const temp = cloneBoard(grid);
    if (activePiece && activePiece.type) {
      lockPieceOnBoard(temp, activePiece.type, activePiece.rot, activePiece.x, activePiece.y);
    }
    let out = '';
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        out += temp[r][c].toString(10);
      }
    }
    return out;
  }

  // ==========================================================================
  // 🕹️ MAIN GAME BOY DMG TETRIS TOURNAMENT ARENA CONTROLLER
  // ==========================================================================
  class GbTetrisTournamentArena {
    constructor() {
      this.sound = new ChiptuneSoundEngine();
      this.canvas = null;
      this.ctx = null;
      this.overlayEl = null;

      this.isVisible = false;
      this.isSpectating = false;
      this.spectateMatch = null;
      this.spectateBoards = {}; // playerId -> { board, score, lines, level }

      // Active Match Context
      this.activeMatch = null; // Tournament match object or local practice match
      this.myPlayerId = null;
      this.mySide = 'p1'; // 'p1' or 'p2'
      this.opponent = null; // { id, name, avatar, color, isCpu, difficulty }

      // Player State
      this.grid = createEmptyBoard();
      this.rng = createSeededRng(Date.now());
      this.bag = [];
      this.currentPiece = null;
      this.nextType = 'T';
      this.score = 0;
      this.lines = 0;
      this.level = 1;
      this.combo = 0;
      this.pendingGarbage = [];
      this.gameOver = false;
      this.roundBannerText = null;

      // Opponent State (Human via WS or Local CPU AI)
      this.oppGridStr = '0'.repeat(ROWS * COLS);
      this.oppScore = 0;
      this.oppLines = 0;
      this.oppLevel = 1;

      // CPU AI State (when opponent.isCpu is true)
      this.cpuState = null;

      // Timing
      this.lastFrameTime = 0;
      this.dropAccumulator = 0;
      this.cpuStepAccumulator = 0;
      this.lastBoardSyncAt = 0;
      this.animFrameId = null;

      // Callbacks hooked by custom-ui.js
      this.onSendGarbage = null;
      this.onBroadcastBoard = null;
      this.onReportRoundWin = null;

      this.bindControls();
    }

    nextPieceFromRng(rngFn, bagArr) {
      if (bagArr.length === 0) {
        const fresh = [...PIECE_KEYS];
        for (let i = fresh.length - 1; i > 0; i--) {
          const j = Math.floor(rngFn() * (i + 1));
          const tmp = fresh[i];
          fresh[i] = fresh[j];
          fresh[j] = tmp;
        }
        bagArr.push(...fresh);
      }
      return bagArr.shift();
    }

    ensureScreenOverlay() {
      const leftCol = document.getElementById('left-console-col');
      if (!leftCol) return false;

      let shell = document.getElementById('gb-tournament-console-shell');
      if (!shell) {
        shell = document.createElement('div');
        shell.id = 'gb-tournament-console-shell';
        shell.className = 'standby-gb-shell tournament-gb-shell';
        shell.style.display = 'none';
        shell.innerHTML = `
          <div class="standby-gb-bezel" style="padding:18px 16px 14px 16px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <span id="gb-lcd-match-badge" style="font-family:'Press Start 2P', monospace; font-size:8.5px; color:#48c78e;">🏆 TETRIS TURNIER</span>
              <div style="display:flex; gap:5px;">
                <button type="button" id="gb-tetris-mute-btn" class="gb-mini-top-btn" title="Ton an/aus">${this.sound.muted ? '🔇' : '🔊'}</button>
                <button type="button" id="gb-tetris-exit-btn" class="gb-mini-top-btn" title="Zurück zum Emulator">✕ ROM</button>
              </div>
            </div>
            <div class="gb-tournament-lcd-frame">
              <canvas id="gb-tournament-canvas" width="320" height="288"></canvas>
            </div>
          </div>

          <!-- Interactive Touch & Click Game Boy Controls -->
          <div class="gb-interactive-controls">
            <div class="gb-dpad-cluster">
              <button type="button" class="gb-pad-btn up" data-gb-act="rotate" title="Drehen (W / Pfeil hoch)">▲</button>
              <button type="button" class="gb-pad-btn left" data-gb-act="left" title="Links (A / Pfeil links)">◀</button>
              <div class="gb-pad-center"></div>
              <button type="button" class="gb-pad-btn right" data-gb-act="right" title="Rechts (D / Pfeil rechts)">▶</button>
              <button type="button" class="gb-pad-btn down" data-gb-act="down" title="Schneller fallen (S / Pfeil runter)">▼</button>
            </div>

            <div class="gb-ab-cluster">
              <div class="gb-ab-wrap">
                <button type="button" class="gb-round-btn btn-b" data-gb-act="drop" title="Hard Drop (K / Leertaste)">B</button>
                <span class="gb-btn-lbl">DROP</span>
              </div>
              <div class="gb-ab-wrap">
                <button type="button" class="gb-round-btn btn-a" data-gb-act="rotate" title="Drehen (J / X / Pfeil hoch)">A</button>
                <span class="gb-btn-lbl">ROTATE</span>
              </div>
            </div>
          </div>
        `;
        leftCol.prepend(shell);

        this.canvas = shell.querySelector('#gb-tournament-canvas');
        this.ctx = this.canvas.getContext('2d');

        const muteBtn = shell.querySelector('#gb-tetris-mute-btn');
        if (muteBtn) {
          muteBtn.onclick = (e) => {
            e.stopPropagation();
            const isMuted = this.sound.toggleMute();
            muteBtn.textContent = isMuted ? '🔇' : '🔊';
            if (!isMuted && this.isVisible && !this.gameOver && !this.isSpectating) {
              this.sound.startMusic(1.0);
            }
          };
        }

        const exitBtn = shell.querySelector('#gb-tetris-exit-btn');
        if (exitBtn) {
          exitBtn.onclick = (e) => {
            e.stopPropagation();
            this.hide();
          };
        }

        shell.querySelectorAll('[data-gb-act]').forEach(btn => {
          const trigger = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const act = btn.getAttribute('data-gb-act');
            this.handleAction(act);
          };
          btn.addEventListener('pointerdown', trigger);
        });
      }

      this.overlayEl = shell;
      return true;
    }

    show() {
      if (!this.ensureScreenOverlay()) return;
      this.isVisible = true;
      this.overlayEl.style.display = 'block';

      // Hide underlying standby or React Game Boy shell while tournament screen is active
      const standby = document.getElementById('start-game-overlay');
      if (standby) standby.style.display = 'none';
      const rootEl = document.getElementById('root');
      if (rootEl) rootEl.style.display = 'none';

      if (!this.animFrameId) {
        this.lastFrameTime = performance.now();
        const loop = (now) => {
          if (!this.isVisible) {
            this.animFrameId = null;
            return;
          }
          const dt = Math.min(100, now - this.lastFrameTime);
          this.lastFrameTime = now;
          this.update(dt, now);
          this.render();
          this.animFrameId = requestAnimationFrame(loop);
        };
        this.animFrameId = requestAnimationFrame(loop);
      }
    }

    hide() {
      this.isVisible = false;
      this.sound.stopMusic();
      if (this.overlayEl) {
        this.overlayEl.style.display = 'none';
      }
      const rootEl = document.getElementById('root');
      if (rootEl) rootEl.style.display = '';
      const standby = document.getElementById('start-game-overlay');
      if (standby) standby.style.display = '';
    }

    startMatch(matchObj, myPlayerId) {
      this.isSpectating = false;
      this.spectateMatch = null;
      this.activeMatch = matchObj;
      this.myPlayerId = myPlayerId;

      const isP1 = (matchObj.p1 && matchObj.p1.id === myPlayerId);
      this.mySide = isP1 ? 'p1' : 'p2';
      this.me = isP1 ? matchObj.p1 : matchObj.p2;
      this.opponent = isP1 ? matchObj.p2 : matchObj.p1;

      this.resetRoundBoard(matchObj.seed || Date.now());
      this.show();

      const badge = document.getElementById('gb-lcd-match-badge');
      if (badge) {
        badge.textContent = `${matchObj.roundName || 'MATCH'}: VS ${(this.opponent?.name || 'CPU').slice(0, 12).toUpperCase()}`;
      }
      this.sound.startMusic(1.0);
    }

    startSpectating(matchObj) {
      this.isSpectating = true;
      this.spectateMatch = matchObj;
      this.activeMatch = matchObj;
      this.sound.stopMusic();
      this.show();

      const badge = document.getElementById('gb-lcd-match-badge');
      if (badge) {
        badge.textContent = `👁️ LIVE: ${(matchObj.p1?.name || 'P1').slice(0, 8)} VS ${(matchObj.p2?.name || 'P2').slice(0, 8)}`;
      }
    }

    resetRoundBoard(seed) {
      this.grid = createEmptyBoard();
      this.rng = createSeededRng(seed);
      this.bag = [];
      this.score = 0;
      this.lines = 0;
      this.level = 1;
      this.combo = 0;
      this.pendingGarbage = [];
      this.gameOver = false;
      this.roundBannerText = null;
      this.dropAccumulator = 0;

      this.oppGridStr = '0'.repeat(ROWS * COLS);
      this.oppScore = 0;
      this.oppLines = 0;
      this.oppLevel = 1;

      this.nextType = this.nextPieceFromRng(this.rng, this.bag);
      this.spawnNextPiece();

      // If opponent is a CPU, initialize the CPU's board & AI state with the same seed!
      if (this.opponent && this.opponent.isCpu) {
        const cpuRng = createSeededRng(seed);
        const cpuBag = [];
        const firstType = this.nextPieceFromRng(cpuRng, cpuBag);
        const nextType = this.nextPieceFromRng(cpuRng, cpuBag);
        const cpuGrid = createEmptyBoard();
        const target = findBestCpuPlacement(cpuGrid, firstType, this.opponent.difficulty || 'normal');

        this.cpuState = {
          grid: cpuGrid,
          rng: cpuRng,
          bag: cpuBag,
          piece: { type: firstType, rot: 0, x: 3, y: 0 },
          nextType,
          target,
          score: 0,
          lines: 0,
          level: 1,
          combo: 0,
          pendingGarbage: [],
          gameOver: false
        };
      } else {
        this.cpuState = null;
      }
    }

    spawnNextPiece() {
      const type = this.nextType;
      this.nextType = this.nextPieceFromRng(this.rng, this.bag);
      this.currentPiece = {
        type,
        rot: 0,
        x: 3,
        y: 0
      };
      if (collides(this.grid, type, 0, 3, 0)) {
        this.handleTopOut('self');
      }
    }

    receiveGarbage(lines, holeCol) {
      if (this.gameOver || this.isSpectating) return;
      this.pendingGarbage.push({ lines, holeCol });
      this.sound.playGarbageIncoming();
    }

    receiveRemoteBoardState(msg) {
      if (!msg) return;
      this.spectateBoards[msg.playerId] = {
        board: msg.board || '0'.repeat(ROWS * COLS),
        score: msg.score || 0,
        lines: msg.lines || 0,
        level: msg.level || 1
      };
      if (this.opponent && msg.playerId === this.opponent.id) {
        this.oppGridStr = msg.board || this.oppGridStr;
        this.oppScore = msg.score || 0;
        this.oppLines = msg.lines || 0;
        this.oppLevel = msg.level || 1;
      }
    }

    onHeartRoundTransition(winnerName, wins1, wins2, nextSeed) {
      if (!this.activeMatch) return;
      this.activeMatch.wins1 = wins1;
      this.activeMatch.wins2 = wins2;
      this.gameOver = true;
      this.sound.stopMusic();
      this.roundBannerText = `HERZ FÜR ${winnerName.toUpperCase()}!\nSTAND: ${wins1} : ${wins2}\nNÄCHSTE RUNDE...`;

      setTimeout(() => {
        if (this.activeMatch && this.activeMatch.status === 'active') {
          this.activeMatch.seed = nextSeed;
          this.resetRoundBoard(nextSeed);
          this.sound.startMusic(1.0);
        }
      }, 2400);
    }

    onMatchFinished(winner) {
      this.gameOver = true;
      this.sound.stopMusic();
      const didIWin = (this.me && winner && winner.id === this.me.id);
      if (didIWin) this.sound.playWin();
      else this.sound.playLose();
      this.roundBannerText = didIWin
        ? `🏆 SIEG!\nDU BIST WEITER!`
        : `💥 NIEDERLAGE!\nSIEGER: ${(winner?.name || 'GEGNER').slice(0, 12)}`;
    }

    handleTopOut(whoToppedOut) {
      if (this.gameOver) return;
      this.gameOver = true;
      this.sound.stopMusic();

      if (!this.activeMatch) return;
      const winner = (whoToppedOut === 'self') ? this.opponent : this.me;
      if (!winner) return;

      const s1 = this.mySide === 'p1' ? this.score : this.oppScore;
      const s2 = this.mySide === 'p2' ? this.score : this.oppScore;
      const l1 = this.mySide === 'p1' ? this.lines : this.oppLines;
      const l2 = this.mySide === 'p2' ? this.lines : this.oppLines;

      if (this.onReportRoundWin) {
        this.onReportRoundWin({
          matchId: this.activeMatch.id,
          winnerId: winner.id,
          score1: s1,
          score2: s2,
          lines1: l1,
          lines2: l2
        });
      }
    }

    handleAction(action) {
      if (!this.isVisible || this.isSpectating || this.gameOver || !this.currentPiece) return;
      const p = this.currentPiece;

      if (action === 'left') {
        if (!collides(this.grid, p.type, p.rot, p.x - 1, p.y)) {
          p.x--;
          this.sound.playMove();
        }
      } else if (action === 'right') {
        if (!collides(this.grid, p.type, p.rot, p.x + 1, p.y)) {
          p.x++;
          this.sound.playMove();
        }
      } else if (action === 'down') {
        if (!collides(this.grid, p.type, p.rot, p.x, p.y + 1)) {
          p.y++;
          this.score += 1;
        } else {
          this.settleCurrentPiece();
        }
      } else if (action === 'rotate') {
        const nextRot = (p.rot + 1) & 3;
        // Basic wall kick offsets
        const kicks = [0, -1, 1, -2, 2];
        for (const dx of kicks) {
          if (!collides(this.grid, p.type, nextRot, p.x + dx, p.y)) {
            p.rot = nextRot;
            p.x += dx;
            this.sound.playRotate();
            break;
          }
        }
      } else if (action === 'drop') {
        let dropped = 0;
        while (!collides(this.grid, p.type, p.rot, p.x, p.y + 1)) {
          p.y++;
          dropped++;
        }
        this.score += dropped * 2;
        this.settleCurrentPiece();
      }
    }

    settleCurrentPiece() {
      const p = this.currentPiece;
      if (!p) return;
      lockPieceOnBoard(this.grid, p.type, p.rot, p.x, p.y);
      this.sound.playLock();

      const cleared = clearCompletedLines(this.grid);
      if (cleared > 0) {
        this.combo++;
        this.lines += cleared;
        const pts = [0, 40, 100, 300, 1200][cleared] || 1200;
        this.score += pts * this.level;
        this.level = Math.min(15, 1 + Math.floor(this.lines / 8));
        this.sound.playLineClear(cleared);

        const garbage = computeGarbageToSend(cleared, this.combo);
        if (garbage > 0) {
          // Cancel pending incoming garbage first!
          let remainingAttack = garbage;
          while (remainingAttack > 0 && this.pendingGarbage.length > 0) {
            if (this.pendingGarbage[0].lines <= remainingAttack) {
              remainingAttack -= this.pendingGarbage[0].lines;
              this.pendingGarbage.shift();
            } else {
              this.pendingGarbage[0].lines -= remainingAttack;
              remainingAttack = 0;
            }
          }

          if (remainingAttack > 0) {
            const holeCol = Math.floor(Math.random() * COLS);
            if (this.opponent && this.opponent.isCpu && this.cpuState) {
              this.cpuState.pendingGarbage.push({ lines: remainingAttack, holeCol });
            } else if (this.onSendGarbage && this.activeMatch) {
              this.onSendGarbage({
                matchId: this.activeMatch.id,
                targetPlayerId: this.opponent ? this.opponent.id : null,
                lines: remainingAttack,
                holeCol
              });
            }
          }
        }
      } else {
        this.combo = 0;
        // Apply any queued garbage lines when a piece locks without clearing lines
        if (this.pendingGarbage.length > 0) {
          const batch = this.pendingGarbage.shift();
          insertGarbageLines(this.grid, batch.lines, batch.holeCol);
        }
      }

      this.spawnNextPiece();
    }

    updateCpuOpponent(dt, now) {
      const cpu = this.cpuState;
      if (!cpu || cpu.gameOver || this.gameOver) return;

      const diff = (this.opponent && this.opponent.difficulty) || 'normal';
      const stepInterval = diff === 'hard' ? 135 : (diff === 'easy' ? 370 : 220);

      this.cpuStepAccumulator += dt;
      if (this.cpuStepAccumulator < stepInterval) return;
      this.cpuStepAccumulator = 0;

      const p = cpu.piece;
      const target = cpu.target;

      if (p.rot !== target.rot) {
        const nextRot = (p.rot + 1) & 3;
        if (!collides(cpu.grid, p.type, nextRot, p.x, p.y)) {
          p.rot = nextRot;
        } else {
          target.rot = p.rot;
        }
      } else if (p.x < target.x && !collides(cpu.grid, p.type, p.rot, p.x + 1, p.y)) {
        p.x++;
      } else if (p.x > target.x && !collides(cpu.grid, p.type, p.rot, p.x - 1, p.y)) {
        p.x--;
      } else {
        // Move down faster once aligned with target column
        const dropSteps = diff === 'hard' ? 3 : 2;
        for (let s = 0; s < dropSteps; s++) {
          if (!collides(cpu.grid, p.type, p.rot, p.x, p.y + 1)) {
            p.y++;
          } else {
            // Lock CPU piece
            lockPieceOnBoard(cpu.grid, p.type, p.rot, p.x, p.y);
            const cleared = clearCompletedLines(cpu.grid);
            if (cleared > 0) {
              cpu.combo++;
              cpu.lines += cleared;
              const pts = [0, 40, 100, 300, 1200][cleared] || 1200;
              cpu.score += pts * cpu.level;
              cpu.level = Math.min(15, 1 + Math.floor(cpu.lines / 8));

              const garbage = computeGarbageToSend(cleared, cpu.combo);
              if (garbage > 0) {
                this.receiveGarbage(garbage, Math.floor(Math.random() * COLS));
              }
            } else {
              cpu.combo = 0;
              if (cpu.pendingGarbage.length > 0) {
                const batch = cpu.pendingGarbage.shift();
                insertGarbageLines(cpu.grid, batch.lines, batch.holeCol);
              }
            }

            // Spawn next CPU piece
            const nextType = cpu.nextType;
            cpu.nextType = this.nextPieceFromRng(cpu.rng, cpu.bag);
            cpu.piece = { type: nextType, rot: 0, x: 3, y: 0 };
            if (collides(cpu.grid, nextType, 0, 3, 0)) {
              cpu.gameOver = true;
              this.handleTopOut('cpu');
              return;
            }
            cpu.target = findBestCpuPlacement(cpu.grid, nextType, diff);
            break;
          }
        }
      }

      this.oppGridStr = serializeBoard(cpu.grid, cpu.piece);
      this.oppScore = cpu.score;
      this.oppLines = cpu.lines;
      this.oppLevel = cpu.level;
    }

    update(dt, now) {
      if (this.isSpectating || this.gameOver) return;

      // Gravity drop speed based on level
      const gravityInterval = Math.max(115, 760 - (this.level - 1) * 48);
      this.dropAccumulator += dt;
      if (this.dropAccumulator >= gravityInterval) {
        this.dropAccumulator = 0;
        if (this.currentPiece) {
          if (!collides(this.grid, this.currentPiece.type, this.currentPiece.rot, this.currentPiece.x, this.currentPiece.y + 1)) {
            this.currentPiece.y++;
          } else {
            this.settleCurrentPiece();
          }
        }
      }

      // Drive CPU opponent if playing vs CPU
      if (this.opponent && this.opponent.isCpu) {
        this.updateCpuOpponent(dt, now);
      }

      // Broadcast board state every 250ms for spectators & opponent mini-view
      if (now - this.lastBoardSyncAt > 250 && this.onBroadcastBoard && this.activeMatch) {
        this.lastBoardSyncAt = now;
        this.onBroadcastBoard({
          matchId: this.activeMatch.id,
          playerId: this.myPlayerId,
          board: serializeBoard(this.grid, this.currentPiece),
          score: this.score,
          lines: this.lines,
          level: this.level,
          nextType: this.nextType
        });
        // If playing vs CPU, also broadcast CPU board so spectators can watch Human vs CPU live!
        if (this.opponent && this.opponent.isCpu) {
          this.onBroadcastBoard({
            matchId: this.activeMatch.id,
            playerId: this.opponent.id,
            board: this.oppGridStr,
            score: this.oppScore,
            lines: this.oppLines,
            level: this.oppLevel
          });
        }
      }
    }

    drawDmgBlock(ctx, x, y, size, val) {
      if (val === 0) return;
      ctx.fillStyle = DMG.INK_DEEP;
      ctx.fillRect(x, y, size, size);

      if (val === 8) {
        // Garbage block pattern
        ctx.fillStyle = DMG.BG_MID;
        ctx.fillRect(x + 2, y + 2, size - 4, size - 4);
      } else {
        ctx.fillStyle = (val % 2 === 0) ? DMG.INK_DARK : DMG.BG_LIGHT;
        ctx.fillRect(x + 1, y + 1, size - 2, size - 2);
        ctx.fillStyle = DMG.INK_DEEP;
        ctx.fillRect(x + 3, y + 3, size - 6, size - 6);
      }
    }

    renderSpectatorView(ctx) {
      const m = this.spectateMatch;
      if (!m) return;

      const b1 = this.spectateBoards[m.p1?.id] || { board: '0'.repeat(200), score: m.score1 || 0, lines: m.lines1 || 0 };
      const b2 = this.spectateBoards[m.p2?.id] || { board: '0'.repeat(200), score: m.score2 || 0, lines: m.lines2 || 0 };

      ctx.fillStyle = DMG.INK_DEEP;
      ctx.font = 'bold 9px "Press Start 2P", monospace';
      ctx.fillText(`👁️ ZUSCHAUER-MODUS (${m.roundName || 'MATCH'})`, 12, 16);

      const drawMiniBoard = (ox, oy, player, state, wins) => {
        const cell = 10;
        ctx.fillStyle = DMG.INK_DEEP;
        ctx.fillRect(ox - 2, oy - 2, COLS * cell + 4, ROWS * cell + 4);
        ctx.fillStyle = DMG.BG_LIGHT;
        ctx.fillRect(ox, oy, COLS * cell, ROWS * cell);

        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            const v = parseInt(state.board.charAt(r * COLS + c) || '0', 10);
            if (v > 0) {
              this.drawDmgBlock(ctx, ox + c * cell, oy + r * cell, cell, v);
            }
          }
        }

        ctx.fillStyle = DMG.INK_DEEP;
        ctx.font = 'bold 8px "Press Start 2P", monospace';
        ctx.fillText((player?.name || 'P').slice(0, 10), ox, oy + ROWS * cell + 14);
        ctx.fillText(`♥x${wins} | L:${state.lines}`, ox, oy + ROWS * cell + 26);
      };

      drawMiniBoard(22, 30, m.p1, b1, m.wins1 || 0);
      drawMiniBoard(188, 30, m.p2, b2, m.wins2 || 0);
    }

    render() {
      const ctx = this.ctx;
      if (!ctx) return;

      // Clear DMG Olive Background
      ctx.fillStyle = DMG.BG_LIGHT;
      ctx.fillRect(0, 0, 320, 288);

      // Subtle scanline grid texture
      ctx.fillStyle = 'rgba(15, 56, 15, 0.05)';
      for (let y = 0; y < 288; y += 2) {
        ctx.fillRect(0, y, 320, 1);
      }

      if (this.isSpectating) {
        this.renderSpectatorView(ctx);
        return;
      }

      // 1. Draw Main Player 10x20 Well (Left: x=14, y=22, cell=12px -> 120x240)
      const ox = 14;
      const oy = 22;
      const cell = 12;

      // Outer border of 10x20 field
      ctx.fillStyle = DMG.INK_DEEP;
      ctx.fillRect(ox - 3, oy - 3, COLS * cell + 6, ROWS * cell + 6);
      ctx.fillStyle = DMG.BG_MID;
      ctx.fillRect(ox, oy, COLS * cell, ROWS * cell);

      // Subtle grid dots
      ctx.fillStyle = 'rgba(15, 56, 15, 0.16)';
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          ctx.fillRect(ox + c * cell + 5, oy + r * cell + 5, 2, 2);
        }
      }

      // Locked cells
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (this.grid[r][c] !== 0) {
            this.drawDmgBlock(ctx, ox + c * cell, oy + r * cell, cell, this.grid[r][c]);
          }
        }
      }

      // Ghost piece + Active Piece
      if (this.currentPiece && !this.gameOver) {
        const p = this.currentPiece;
        let ghostY = p.y;
        while (!collides(this.grid, p.type, p.rot, p.x, ghostY + 1)) {
          ghostY++;
        }
        const cells = TETROMINOES[p.type].rotations[p.rot & 3];
        if (ghostY > p.y) {
          ctx.strokeStyle = DMG.INK_DARK;
          ctx.lineWidth = 1;
          for (let i = 0; i < cells.length; i++) {
            const gx = ox + (p.x + cells[i][0]) * cell;
            const gy = oy + (ghostY + cells[i][1]) * cell;
            ctx.strokeRect(gx + 1.5, gy + 1.5, cell - 3, cell - 3);
          }
        }
        const id = TETROMINOES[p.type].id;
        for (let i = 0; i < cells.length; i++) {
          const cx = p.x + cells[i][0];
          const cy = p.y + cells[i][1];
          if (cy >= 0) {
            this.drawDmgBlock(ctx, ox + cx * cell, oy + cy * cell, cell, id);
          }
        }
      }

      // Incoming Garbage Warning Meter (vertical bar beside well)
      const totalQueuedGarbage = this.pendingGarbage.reduce((acc, g) => acc + g.lines, 0);
      ctx.fillStyle = DMG.INK_DEEP;
      ctx.fillRect(ox + COLS * cell + 5, oy, 6, ROWS * cell);
      if (totalQueuedGarbage > 0) {
        const barH = Math.min(ROWS * cell, totalQueuedGarbage * cell);
        ctx.fillStyle = DMG.INK_DARK;
        ctx.fillRect(ox + COLS * cell + 6, oy + ROWS * cell - barH, 4, barH);
      }

      // Top Header (Mario / Luigi Hearts Score)
      const myWins = this.activeMatch ? (this.mySide === 'p1' ? this.activeMatch.wins1 : this.activeMatch.wins2) : 0;
      const oppWins = this.activeMatch ? (this.mySide === 'p1' ? this.activeMatch.wins2 : this.activeMatch.wins1) : 0;
      const needed = (this.activeMatch && this.activeMatch.winsNeeded) || 2;
      const myHearts = '♥'.repeat(myWins) + '♡'.repeat(Math.max(0, needed - myWins));
      const oppHearts = '♥'.repeat(oppWins) + '♡'.repeat(Math.max(0, needed - oppWins));

      ctx.fillStyle = DMG.INK_DEEP;
      ctx.font = 'bold 8px "Press Start 2P", monospace';
      ctx.fillText(`DU ${myHearts}`, ox, 14);
      ctx.fillText(`VS ${oppHearts}`, 152, 14);

      // Right Column Info Panel (x=150..308)
      const rx = 150;

      // Next Piece Box + Stats
      ctx.fillStyle = DMG.INK_DEEP;
      ctx.strokeStyle = DMG.INK_DEEP;
      ctx.lineWidth = 2;
      ctx.strokeRect(rx, 22, 68, 52);
      ctx.font = 'bold 7px "Press Start 2P", monospace';
      ctx.fillText('NEXT', rx + 6, 33);

      if (this.nextType && TETROMINOES[this.nextType]) {
        const nCells = TETROMINOES[this.nextType].rotations[0];
        const nid = TETROMINOES[this.nextType].id;
        for (let i = 0; i < nCells.length; i++) {
          this.drawDmgBlock(ctx, rx + 14 + nCells[i][0] * 10, 38 + nCells[i][1] * 10, 10, nid);
        }
      }

      // Score & Lines Box
      ctx.strokeRect(rx + 74, 22, 82, 52);
      ctx.fillText(`PTS:${this.score}`, rx + 78, 36);
      ctx.fillText(`LIN:${this.lines}`, rx + 78, 50);
      ctx.fillText(`LVL:${this.level}`, rx + 78, 64);

      // Live Opponent Mini-Board (x=150, y=84, cell=8px -> 80x160)
      const mox = 152;
      const moy = 96;
      const mcell = 8;

      ctx.fillStyle = DMG.INK_DEEP;
      ctx.font = 'bold 7px "Press Start 2P", monospace';
      const oppLabel = this.opponent
        ? `${this.opponent.isCpu ? '🤖' : '🎮'} ${this.opponent.name.slice(0, 13)}`
        : '🤖 CPU-GEGNER';
      ctx.fillText(oppLabel, mox, 90);

      ctx.fillRect(mox - 2, moy - 2, COLS * mcell + 4, ROWS * mcell + 4);
      ctx.fillStyle = DMG.BG_MID;
      ctx.fillRect(mox, moy, COLS * mcell, ROWS * mcell);

      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const val = parseInt(this.oppGridStr.charAt(r * COLS + c) || '0', 10);
          if (val > 0) {
            this.drawDmgBlock(ctx, mox + c * mcell, moy + r * mcell, mcell, val);
          }
        }
      }

      // Opponent Stats next to mini-board
      ctx.fillStyle = DMG.INK_DEEP;
      ctx.font = 'bold 7px "Press Start 2P", monospace';
      ctx.fillText('GEGNER', mox + 88, moy + 14);
      ctx.fillText(`${this.oppLines} LIN`, mox + 88, moy + 30);
      ctx.fillText(`${this.oppScore}P`, mox + 88, moy + 46);
      if (totalQueuedGarbage > 0) {
        ctx.fillText(`⚠️ +${totalQueuedGarbage}`, mox + 88, moy + 70);
      }

      // Round / Victory Banner Overlay
      if (this.roundBannerText) {
        ctx.fillStyle = 'rgba(15, 56, 15, 0.88)';
        ctx.fillRect(16, 98, 288, 86);
        ctx.strokeStyle = DMG.BG_LIGHT;
        ctx.lineWidth = 3;
        ctx.strokeRect(20, 102, 280, 78);

        ctx.fillStyle = DMG.BG_LIGHT;
        ctx.font = 'bold 9.5px "Press Start 2P", monospace';
        const lines = this.roundBannerText.split('\n');
        lines.forEach((line, idx) => {
          ctx.fillText(line, 32, 126 + idx * 20);
        });
      }
    }

    bindControls() {
      window.addEventListener('keydown', (e) => {
        if (!this.isVisible || this.isSpectating || this.gameOver) return;
        const activeTag = document.activeElement && document.activeElement.tagName;
        if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return;

        const key = e.key.toLowerCase();
        if (key === 'arrowleft' || key === 'a') {
          e.preventDefault();
          this.handleAction('left');
        } else if (key === 'arrowright' || key === 'd') {
          e.preventDefault();
          this.handleAction('right');
        } else if (key === 'arrowdown' || key === 's') {
          e.preventDefault();
          this.handleAction('down');
        } else if (key === 'arrowup' || key === 'w' || key === 'j' || key === 'x' || key === 'z') {
          e.preventDefault();
          this.handleAction('rotate');
        } else if (key === ' ' || key === 'k' || key === 'b') {
          e.preventDefault();
          this.handleAction('drop');
        }
      });
    }
  }

  window.gbTetrisArena = new GbTetrisTournamentArena();
})();
