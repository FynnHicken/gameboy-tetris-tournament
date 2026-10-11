/**
 * Game Boy Online Multiplayer - Retro UI, Treffen-inspired Party-Hub,
 * Auto Link-Cable, Live Chat, Persistence & Battery Save Engine
 */

(function() {
  const CODE_ALPHABET = 'abcdefghijklmnpqrstuvwxyz0123456789';

  const AVATAR_POOL = [
    { avatar: '🐶', color: '#6366f1' },
    { avatar: '🦊', color: '#f97316' },
    { avatar: '🐱', color: '#06b6d4' },
    { avatar: '🐼', color: '#ec4899' },
    { avatar: '🐸', color: '#10b981' },
    { avatar: '🐰', color: '#8b5cf6' },
    { avatar: '🦁', color: '#eab308' },
    { avatar: '🦄', color: '#f43f5e' },
    { avatar: '🐧', color: '#3b82f6' },
    { avatar: '🐻', color: '#d97706' }
  ];

  const ALL_AVATARS = [
    '🐶', '🦊', '🐱', '🐼', '🐸', '🐰',
    '🦁', '🦄', '🐧', '🐻', '🐵', '🐙',
    '🚀', '👑', '👻', '⚡', '🔥', '🎮'
  ];

  function generateRoomCode(len = 4) {
    let out = '';
    for (let i = 0; i < len; i++) {
      out += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
    }
    return out;
  }

  function normalizeRoomCode(code) {
    return (code || '').trim().toLowerCase().replace(/o/g, '0').replace(/[^a-z0-9]/g, '');
  }

  // Persistent Player Identity
  let playerId = localStorage.getItem('gb_player_id');
  if (!playerId) {
    playerId = 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    localStorage.setItem('gb_player_id', playerId);
  }

  const randomPreset = AVATAR_POOL[Math.floor(Math.random() * AVATAR_POOL.length)];
  let playerName = localStorage.getItem('gb_player_name') || ('Spieler_' + Math.floor(100 + Math.random() * 900));
  let playerAvatar = localStorage.getItem('gb_player_avatar') || randomPreset.avatar;
  let playerColor = localStorage.getItem('gb_player_color') || randomPreset.color;

  // Determine initial Room Code from URL (?room= or ?code=), or generate one automatically like Treffen
  const initUrlParams = new URLSearchParams(window.location.search);
  let initialRoom = normalizeRoomCode(initUrlParams.get('room') || initUrlParams.get('code') || '');
  if (!initialRoom) {
    initialRoom = generateRoomCode(4);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set('room', initialRoom);
      window.history.replaceState({ room: initialRoom }, '', u.toString());
    } catch (e) {}
  }

  let currentRoom = initialRoom;
  let currentRomName = localStorage.getItem('gb_last_rom_name') || null;
  let isGameInitialized = false;

  // Party & Link-Cable State
  let chatWs = null;
  let chatReconnectTimer = null;
  let linkWs = null;
  let linkReconnectTimer = null;
  let linkConnectedChannel = null;
  let activeLinkMatchId = null;
  let isLinkPaired = false;
  let isCpuBotLinkActive = false;
  let linkPeerCount = 0;
  let workletSerialHooked = false;

  const partyState = {
    isHost: false,
    hostId: null,
    selectedRom: null,
    players: [],
    tournament: {
      status: 'lobby',
      mode: 'builtin',
      fillMode: 'odd_plus_one',
      cpuDifficulty: 'normal',
      bestOf: 3,
      customCpus: [],
      participants: [],
      currentRound: 0,
      rounds: [],
      champion: null
    }
  };

  let lastAutoStartedMatchKey = null;

  // Sound generator using Web Audio API (Retro 8-bit Synth)
  function playRetroBlip(freq = 440, type = 'square', duration = 0.08) {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch (e) {}
  }

  function showToast(text) {
    let toast = document.getElementById('party-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'party-toast';
      toast.className = 'party-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2600);
  }

  // --- IndexedDB Persistence for active ROM bytes ---
  const DB_NAME = 'gb_session_persistence';
  const DB_VERSION = 1;

  function openPersistenceDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('session')) {
          db.createObjectStore('session');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveSessionRom(name, arrayBuffer) {
    try {
      currentRomName = name;
      localStorage.setItem('gb_last_rom_name', name);
      const db = await openPersistenceDb();
      const tx = db.transaction('session', 'readwrite');
      tx.objectStore('session').put({ name, buffer: arrayBuffer, timestamp: Date.now() }, 'active_rom');
      updateRomDisplay();
      refreshSaveManagerList();
      sendPartyUpdate();
    } catch (e) {
      console.warn('Failed to cache ROM in IndexedDB:', e);
    }
  }

  async function getSessionRom() {
    try {
      const db = await openPersistenceDb();
      return new Promise((resolve) => {
        const tx = db.transaction('session', 'readonly');
        const req = tx.objectStore('session').get('active_rom');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  async function clearSessionRom() {
    try {
      currentRomName = null;
      localStorage.removeItem('gb_last_rom_name');
      const db = await openPersistenceDb();
      const tx = db.transaction('session', 'readwrite');
      tx.objectStore('session').delete('active_rom');
      updateRomDisplay();
      sendPartyUpdate();
    } catch (e) {}
  }

  // --- .sav Battery Save Management & Checksum Validation Engine ---
  function openGebehDb() {
    return new Promise((resolve) => {
      const req = indexedDB.open('gebeh', 2);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('saves')) {
          db.createObjectStore('saves');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }

  async function forceSaveFlush() {
    try {
      if (window.__gbWorkletNode && window.__gbWorkletNode.port) {
        window.__gbWorkletNode.port.postMessage({ type: 'requestSave' });
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }

  function inspectSaveBytes(bytes) {
    if (!bytes || bytes.length === 0) return { valid: false, reason: 'Keine Daten' };

    let nonZeroCount = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 0) {
        nonZeroCount++;
        if (nonZeroCount > 30) break;
      }
    }
    if (nonZeroCount === 0) {
      return {
        valid: false,
        isEmpty: true,
        reason: 'Spielstand ist noch leer (0x00). Führe im Spiel START ➔ SICHERN aus!'
      };
    }

    const g1PartyCount = bytes[0x2F2C];
    const g1PartyTerm = bytes[0x2F2C + 1 + g1PartyCount];
    const g1BoxCount = bytes[0x30C0];
    const g1BoxTerm = bytes[0x30C0 + 1 + g1BoxCount];

    if (bytes.length === 32768 && g1PartyCount <= 6 && g1PartyTerm === 0xFF && g1BoxCount <= 20 && g1BoxTerm === 0xFF) {
      let sum = 0;
      for (let i = 0x2598; i < 0x3523; i++) {
        sum = (sum + bytes[i]) & 0xFF;
      }
      const calcChk = (~sum) & 0xFF;
      const storedChk = bytes[0x3523];
      const chkOk = (calcChk === storedChk);

      let trainer = '';
      for (let i = 0x2598; i < 0x2598 + 11; i++) {
        const b = bytes[i];
        if (b === 0x50) break;
        if (b >= 0x80 && b <= 0x99) trainer += String.fromCharCode(65 + b - 0x80);
        else if (b >= 0xA0 && b <= 0xB9) trainer += String.fromCharCode(97 + b - 0xA0);
        else if (b >= 0xF6 && b <= 0xFF) trainer += String.fromCharCode(48 + b - 0xF6);
        else trainer += '?';
      }

      let badges = 0;
      const badgeByte = bytes[0x2602];
      for (let bit = 0; bit < 8; bit++) {
        if ((badgeByte >> bit) & 1) badges++;
      }

      return {
        valid: true,
        gen: 1,
        title: 'POKEMON RED',
        trainer: trainer.trim() || 'ROT',
        partyCount: g1PartyCount,
        badges,
        chkOk,
        checksumReady: chkOk,
        size: bytes.length,
        summary: `Trainer: ${trainer.trim() || 'ROT'} | ${g1PartyCount} Pokémon | ${badges} Orden`
      };
    }

    const g2PartyCount = bytes[0x288A];
    const g2PartyTerm = bytes[0x288A + 1 + g2PartyCount];
    const g2BoxCount = bytes[0x2D6C];
    const g2BoxTerm = bytes[0x2D6C + 1 + g2BoxCount];

    if ((bytes.length === 32768 || bytes.length === 65536) && g2PartyCount <= 6 && g2PartyTerm === 0xFF && g2BoxCount <= 20 && g2BoxTerm === 0xFF) {
      let trainer = '';
      for (let i = 0x200B; i < 0x200B + 11; i++) {
        const b = bytes[i];
        if (b === 0x50) break;
        if (b >= 0x80 && b <= 0x99) trainer += String.fromCharCode(65 + b - 0x80);
        else if (b >= 0xA0 && b <= 0xB9) trainer += String.fromCharCode(97 + b - 0xA0);
        else if (b >= 0xF6 && b <= 0xFF) trainer += String.fromCharCode(48 + b - 0xF6);
        else trainer += '?';
      }

      return {
        valid: true,
        gen: 2,
        title: 'POKEMON_GLDAAUD',
        trainer: trainer.trim() || 'GOLD',
        partyCount: g2PartyCount,
        checksumReady: true,
        size: bytes.length,
        summary: `Trainer: ${trainer.trim() || 'GOLD'} | ${g2PartyCount} Pokémon`
      };
    }

    return {
      valid: true,
      size: bytes.length,
      checksumReady: false,
      summary: `Standard Game Boy Spielstand (${bytes.length} Bytes)`
    };
  }

  async function getGebehSaveTitles() {
    try {
      const db = await openGebehDb();
      if (!db || !db.objectStoreNames.contains('saves')) return [];
      return new Promise((resolve) => {
        const tx = db.transaction('saves', 'readonly');
        const req = tx.objectStore('saves').getAllKeys();
        req.onsuccess = () => {
          const keys = (req.result || []).filter(k => typeof k === 'string' && !k.endsWith('_EXTRA'));
          resolve(keys);
        };
        req.onerror = () => resolve([]);
      });
    } catch (e) {
      return [];
    }
  }

  async function exportSave(title) {
    try {
      await forceSaveFlush();

      const db = await openGebehDb();
      if (!db) return;
      const tx = db.transaction('saves', 'readonly');
      const req = tx.objectStore('saves').get(title);
      req.onsuccess = () => {
        const data = req.result;
        if (!data) {
          alert('Kein Spielstand für "' + title + '" gefunden!');
          return;
        }

        const raw = (data instanceof Uint8Array) ? data : new Uint8Array(data);
        let bytes = raw;
        if (bytes.length < 32768) {
          const padded = new Uint8Array(32768);
          padded.set(bytes);
          bytes = padded;
        } else if (bytes.length > 32768 && bytes.length < 65536) {
          bytes = bytes.slice(0, 32768);
        }

        const info = inspectSaveBytes(bytes);

        if (info.isEmpty) {
          const proceed = confirm(
            `⚠️ ACHTUNG: Der Spielstand für "${title}" ist noch ungespeichert (32 KB leere Nullen)!\n\n` +
            `Diese Datei enthält noch keinen aktiven Spielstand, weil im Spiel noch nicht gespeichert wurde.\n\n` +
            `👉 So sicherst du deinen Spielstand richtig:\n` +
            `1. Drücke im Spiel START [Taste Enter]\n` +
            `2. Gehe auf "SICHERN" und bestätige mit JA [Taste A]\n` +
            `3. Klicke im Menü auf "🔄 Emulator sichern (Sync)"\n` +
            `4. Lade die .sav-Datei danach erneut herunter!\n\n` +
            `Möchtest du die leere Datei trotzdem herunterladen?`
          );
          if (!proceed) return;
        }

        const cleanName = title.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_') + '.sav';
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = cleanName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        playRetroBlip(750, 'triangle', 0.1);

        if (info.checksumReady) {
          showToast(`✅ "${cleanName}" exportiert (32 KB SRAM)`);
        }
      };
    } catch (e) {
      alert('Fehler beim Exportieren: ' + e.message);
    }
  }

  async function importSave(title, file) {
    try {
      let buffer = new Uint8Array(await file.arrayBuffer());
      if (buffer.length === 32812) {
        buffer = buffer.slice(0, 32768);
      } else if (buffer.length < 32768) {
        const padded = new Uint8Array(32768);
        padded.set(buffer);
        buffer = padded;
      }

      const info = inspectSaveBytes(buffer);
      const db = await openGebehDb();
      if (!db) return;
      const tx = db.transaction('saves', 'readwrite');
      tx.objectStore('saves').put(buffer, title);
      tx.oncomplete = () => {
        alert(`Spielstand für "${title}" erfolgreich importiert!\n\n${info.summary || (buffer.length + ' Bytes')}\nStatus: ${info.checksumReady ? 'Verifiziert ✅' : 'OK'}\n\nStarte das Spiel neu (oder wähle die ROM im Menü), um ihn zu spielen.`);
        playRetroBlip(880, 'square', 0.12);
        refreshSaveManagerList();
      };
    } catch (e) {
      alert('Fehler beim Importieren: ' + e.message);
    }
  }

  async function refreshSaveManagerList() {
    const list = document.getElementById('save-manager-content');
    if (!list) return;

    const titles = await getGebehSaveTitles();
    if (titles.length === 0) {
      list.innerHTML = `<div style="font-size:12px; color:#64748b; font-style:italic; padding:4px 0;">Noch keine Spielstände im Browser gesichert. Drücke im Spiel START &rarr; SICHERN.</div>`;
      return;
    }

    const db = await openGebehDb();
    if (!db) return;

    let itemsHtml = '';
    for (const title of titles) {
      let info = null;
      try {
        const raw = await new Promise(r => {
          const req = db.transaction('saves', 'readonly').objectStore('saves').get(title);
          req.onsuccess = () => r(req.result);
          req.onerror = () => r(null);
        });
        if (raw) info = inspectSaveBytes(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
      } catch (e) {}

      const isReady = info && info.checksumReady;
      const isEmpty = info && info.isEmpty;

      itemsHtml += `
        <div style="background:#11151f; border:1px solid ${isReady ? '#166534' : isEmpty ? '#854d0e' : '#283040'}; border-radius:6px; padding:7px 10px; margin-bottom:6px;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-size:12.5px; font-weight:700; color:#cbd5e1;">🎮 ${escapeHtml(title)}</span>
              ${isReady ? '<span style="font-size:10px; background:#166534; color:#bbf7d0; padding:1px 5px; border-radius:3px; font-weight:700;">Verifiziert ✅</span>' : ''}
              ${isEmpty ? '<span style="font-size:10px; background:#854d0e; color:#fef08a; padding:1px 5px; border-radius:3px; font-weight:700;">Leer (0 KB) ⚠️</span>' : ''}
            </div>
            <button class="retro-btn" style="padding:4px 9px; font-size:11px; ${isReady ? 'background:#16a34a;' : ''}" onclick="window.gbExportSave('${escapeHtml(title)}')">⬇️ .sav (32 KB)</button>
          </div>
          ${info ? `
            <div style="font-size:11px; color:${isReady ? '#86efac' : isEmpty ? '#fde047' : '#94a3b8'}; margin-top:3px; line-height:1.3;">
              ${isEmpty ? '⚠️ Im Spiel noch ungespeichert (0x00 Nullen). Führe im Spiel <em>START &rarr; SICHERN</em> aus!' : escapeHtml(info.summary || '')}
            </div>
          ` : ''}
        </div>
      `;
    }

    list.innerHTML = itemsHtml;
  }

  window.gbExportSave = exportSave;

  // --- Prevent Accidental Page Reload / Navigation ---
  window.addEventListener('beforeunload', (e) => {
    if (currentRomName || isGameInitialized) {
      try {
        if (window.__gbWorkletNode && window.__gbWorkletNode.port) {
          window.__gbWorkletNode.port.postMessage({ type: 'requestSave' });
        }
      } catch (err) {}
      e.preventDefault();
      e.returnValue = 'Ein Spiel oder eine Multiplayer-Session läuft noch!';
      return e.returnValue;
    }
  });

  // Update ROM info badge in sidebar
  function updateRomDisplay() {
    const label = document.getElementById('active-rom-label');
    if (label) {
      if (currentRomName) {
        label.innerHTML = `Aktiv: <strong style="color:#48c78e;">${escapeHtml(currentRomName)}</strong> <button id="btn-clear-rom" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:11px; margin-left:6px;" title="Gespeichertes Spiel leeren">✖ Leeren</button>`;
        const clearBtn = document.getElementById('btn-clear-rom');
        if (clearBtn) {
          clearBtn.onclick = async () => {
            if (confirm('Gespeichertes Spiel aus dem Browser-Speicher entfernen?')) {
              await clearSessionRom();
              playRetroBlip(300, 'square', 0.1);
            }
          };
        }
      } else {
        label.innerHTML = `Kein Spiel geladen – wähle oben eine ROM oder starte das integrierte Turnier-Tetris!`;
      }
    }
  }

  // --- Direct Auto-Link-Cable Engine + Dual-WASM CPU Bot Renderer ---
  function renderBotFrameToMiniCanvas(uint16Buf) {
    const canvas = document.getElementById('emulator-cpu-mini-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(160, 144);
    const data = img.data;
    for (let i = 0; i < uint16Buf.length; i++) {
      const val = uint16Buf[i];
      const idx = i * 4;
      const r = val & 31;
      const g = (val >> 5) & 31;
      const b = (val >> 10) & 31;
      data[idx] = (r << 3) | (r >> 2);
      data[idx + 1] = (g << 3) | (g >> 2);
      data[idx + 2] = (b << 3) | (b >> 2);
      data[idx + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function ensureWorkletSerialHook() {
    if (workletSerialHooked) return true;
    if (!window.__gbWorkletNode || !window.__gbWorkletNode.port) return false;

    workletSerialHooked = true;
    window.__gbWorkletNode.port.addEventListener('message', (e) => {
      if (!e.data) return;
      if (e.data.type === 'serial' && e.data.buffer) {
        if (!isCpuBotLinkActive && linkWs && linkWs.readyState === WebSocket.OPEN && isLinkPaired) {
          try {
            linkWs.send(e.data.buffer);
          } catch (err) {}
        }
      } else if (e.data.type === 'botFrame' && e.data.buffer) {
        renderBotFrameToMiniCanvas(e.data.buffer);
      } else if (e.data.type === 'cpuBotStatus') {
        isCpuBotLinkActive = !!e.data.active;
        updateLinkCableUI();
      }
    });
    return true;
  }

  function setWorkletCpuBotMode(enabled, difficulty = 'normal') {
    isCpuBotLinkActive = !!enabled;
    if (window.__gbWorkletNode && window.__gbWorkletNode.port) {
      ensureWorkletSerialHook();
      window.__gbWorkletNode.port.postMessage({
        type: 'setCpuBot',
        enabled: !!enabled,
        difficulty
      });
    }
    updateLinkCableUI();
  }

  function connectDirectLinkCable(forceReconnect = false, matchIdOverride = null) {
    if (!currentRoom) return;
    if (!window.__gbWorkletNode || !window.__gbWorkletNode.port) return;

    ensureWorkletSerialHook();

    if (matchIdOverride !== null) {
      activeLinkMatchId = matchIdOverride;
    }

    const channelKey = activeLinkMatchId ? `${currentRoom}__${activeLinkMatchId}` : currentRoom;

    if (!forceReconnect && linkWs && (linkWs.readyState === WebSocket.OPEN || linkWs.readyState === WebSocket.CONNECTING) && linkConnectedChannel === channelKey) {
      return;
    }

    if (linkWs) {
      try { linkWs.close(); } catch (e) {}
      linkWs = null;
    }

    linkConnectedChannel = channelKey;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const matchQuery = activeLinkMatchId ? `&matchId=${encodeURIComponent(activeLinkMatchId)}` : '';
    const wsUrl = `${proto}//${window.location.host}/ws?room=${encodeURIComponent(currentRoom)}${matchQuery}&direct=1&playerId=${encodeURIComponent(playerId)}`;

    try {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      linkWs = ws;

      ws.onopen = () => {
        sendPartyUpdate();
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          if (!isCpuBotLinkActive && event.data.byteLength > 0 && window.__gbWorkletNode && window.__gbWorkletNode.port) {
            window.__gbWorkletNode.port.postMessage(
              { type: 'serial', buffer: new Uint8Array(event.data) },
              [event.data]
            );
          }
        } else if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'LINK_PAIRED') {
              const wasPaired = isLinkPaired;
              isLinkPaired = true;
              linkPeerCount = msg.peers || 2;
              if (window.__gbWorkletNode && window.__gbWorkletNode.port) {
                window.__gbWorkletNode.port.postMessage({ type: 'serialConnected' });
              }
              updateLinkCableUI();
              if (!wasPaired) {
                playRetroBlip(660, 'triangle', 0.08);
                setTimeout(() => playRetroBlip(880, 'triangle', 0.12), 90);
                showToast(`🔗 Link-Kabel verbunden! (${activeLinkMatchId ? 'Turnier-Match' : '2/2 Spieler bereit'})`);
              }
            } else if (msg.type === 'LINK_WAITING') {
              isLinkPaired = false;
              linkPeerCount = msg.peers || 1;
              if (!isCpuBotLinkActive && window.__gbWorkletNode && window.__gbWorkletNode.port) {
                window.__gbWorkletNode.port.postMessage({ type: 'serialDisconnected' });
              }
              updateLinkCableUI();
            }
          } catch (e) {}
        }
      };

      ws.onclose = () => {
        if (linkWs === ws) {
          isLinkPaired = false;
          if (!isCpuBotLinkActive && window.__gbWorkletNode && window.__gbWorkletNode.port) {
            try { window.__gbWorkletNode.port.postMessage({ type: 'serialDisconnected' }); } catch (e) {}
          }
          updateLinkCableUI();
          clearTimeout(linkReconnectTimer);
          linkReconnectTimer = setTimeout(() => connectDirectLinkCable(true, activeLinkMatchId), 2500);
        }
      };
    } catch (e) {}
  }

  function updateLinkCableUI() {
    const topDot = document.getElementById('top-status-dot');
    const topText = document.getElementById('top-status-text');
    const banner = document.getElementById('link-cable-banner');
    const bannerText = document.getElementById('link-cable-banner-text');

    const emuReady = !!(window.__gbWorkletNode && window.__gbWorkletNode.port);

    if (isCpuBotLinkActive && emuReady) {
      if (topDot) topDot.className = 'status-dot connected';
      if (topText) topText.textContent = 'Link-Kabel: 🤖 CPU-Bot';
      if (banner) banner.className = 'link-cable-banner paired';
      if (bannerText) bannerText.innerHTML = '🤖 <strong>Dual-WASM Link-Kabel aktiv!</strong> (Dein Game Boy ist direkt mit dem CPU-Gegner gekoppelt)';
    } else if (isLinkPaired && emuReady) {
      if (topDot) topDot.className = 'status-dot connected';
      if (topText) topText.textContent = activeLinkMatchId ? 'Turnier-Link aktiv ⚔️' : 'Link-Kabel aktiv 🐣🐔';
      if (banner) banner.className = 'link-cable-banner paired';
      if (bannerText) bannerText.innerHTML = `🟢 <strong>Link-Kabel verbunden!</strong> (${activeLinkMatchId ? 'Turnier-Match gekoppelt' : 'Beide Game Boys gekoppelt'})`;
    } else if (!emuReady) {
      if (topDot) topDot.className = 'status-dot waiting';
      if (topText) topText.textContent = `Party: ${currentRoom} (Bereit)`;
      if (banner) banner.className = 'link-cable-banner waiting';
      if (bannerText) bannerText.innerHTML = '🕹️ Starte links den <strong>Game Boy</strong> oder direkt unten ein <strong>🏆 Tetris-Turnier</strong>!';
    } else {
      if (topDot) topDot.className = 'status-dot waiting';
      if (topText) topText.textContent = `Warte auf 2. Game Boy (${currentRoom})...`;
      if (banner) banner.className = 'link-cable-banner waiting';
      if (bannerText) bannerText.innerHTML = `🔌 <strong>Link-Kabel bereit</strong> – Warte auf Mitspieler in Raum <code>${escapeHtml(currentRoom)}</code>...`;
    }
  }

  // --- Party-Hub & Live Roster UI Updates (inspired by Treffen) ---
  function updateHeaderProfileUI() {
    const avatarEl = document.getElementById('header-user-avatar');
    const nameEl = document.getElementById('header-user-name');
    const roleEl = document.getElementById('header-user-role');
    const roomEl = document.getElementById('header-room-code');
    const nameInput = document.getElementById('player-name-input');

    if (avatarEl) {
      avatarEl.textContent = playerAvatar;
      avatarEl.style.borderColor = playerColor;
      avatarEl.style.background = `${playerColor}26`;
    }
    if (nameEl) nameEl.textContent = playerName;
    if (roleEl) {
      if (partyState.isHost) {
        roleEl.textContent = '👑 Party-Host';
        roleEl.className = 'user-badge-role is-host';
      } else {
        roleEl.textContent = '🎮 Mitspieler';
        roleEl.className = 'user-badge-role';
      }
    }
    if (roomEl) roomEl.textContent = currentRoom;
    if (nameInput && document.activeElement !== nameInput) {
      nameInput.value = playerName;
    }
  }

  function renderPartyRoster() {
    const grid = document.getElementById('party-roster-grid');
    const countBadge = document.getElementById('party-count-badge');
    const launchBtn = document.getElementById('btn-party-launch-rom');
    if (!grid) return;

    const players = partyState.players || [];
    const count = players.length || 1;
    if (countBadge) {
      countBadge.textContent = count === 1 ? '1 Spieler online' : `${count} Spieler online`;
    }

    if (launchBtn) {
      if (partyState.isHost) {
        launchBtn.textContent = '🚀 Für Party starten';
        launchBtn.title = 'Startet das gewählte Spiel synchron für alle im Raum';
      } else {
        launchBtn.textContent = '🎮 Für mich laden';
        launchBtn.title = 'Lädt das gewählte Spiel in deinen Emulator';
      }
    }

    if (players.length === 0) {
      grid.innerHTML = `
        <div class="party-player-card is-host">
          <div class="party-player-avatar" style="background:${playerColor}22; border:2px solid ${playerColor};">
            ${playerAvatar}
            <span class="online-dot"></span>
          </div>
          <div class="party-player-info">
            <span class="party-player-name">${escapeHtml(playerName)} 👑 <small style="opacity:0.7;">(Du)</small></span>
            <span class="party-player-sub">${currentRomName ? '🎮 ' + escapeHtml(currentRomName) : '✅ Bereit in Lobby'}</span>
          </div>
        </div>
      `;
      return;
    }

    let html = '';
    players.forEach(p => {
      const isMe = p.id === playerId;
      const col = p.color || '#48c78e';
      const subText = p.rom
        ? `🎮 ${escapeHtml(p.rom)} ${p.emulatorReady ? '• 🔗 Aktiv' : ''}`
        : (p.emulatorReady ? '🕹️ Emulator bereit' : '✅ In der Lobby');

      html += `
        <div class="party-player-card ${p.isHost ? 'is-host' : ''}">
          <div class="party-player-avatar" style="background:${escapeHtml(col)}22; border:2px solid ${escapeHtml(col)};">
            ${escapeHtml(p.avatar || '🎮')}
            <span class="online-dot"></span>
          </div>
          <div class="party-player-info">
            <span class="party-player-name">
              ${escapeHtml(p.name)} ${p.isHost ? '👑' : ''} ${isMe ? '<small style="opacity:0.75; font-weight:600;">(Du)</small>' : ''}
            </span>
            <span class="party-player-sub">${subText}</span>
          </div>
          ${(partyState.isHost && !isMe) ? `
            <button class="transfer-host-btn" data-transfer-id="${escapeHtml(p.id)}" data-transfer-name="${escapeHtml(p.name)}" title="${escapeHtml(p.name)} zum Party-Host machen">
              👑 Host
            </button>
          ` : ''}
        </div>
      `;
    });

    grid.innerHTML = html;

    grid.querySelectorAll('.transfer-host-btn').forEach(btn => {
      btn.onclick = () => {
        const targetId = btn.getAttribute('data-transfer-id');
        const targetName = btn.getAttribute('data-transfer-name');
        if (targetId && confirm(`Möchtest du die Party-Host-Rolle (👑) an "${targetName}" übergeben?`)) {
          if (chatWs && chatWs.readyState === WebSocket.OPEN) {
            chatWs.send(JSON.stringify({
              type: 'TRANSFER_HOST',
              targetPlayerId: targetId
            }));
          }
        }
      };
    });
  }

  // ==========================================================================
  // 🏆 8-PLAYER TETRIS TOURNAMENT & CPU AUTO-FILL UI CONTROLLER
  // ==========================================================================
  const PREVIEW_CPU_NAMES = [
    { name: 'R.O.B. 89 (CPU)', avatar: '🤖', color: '#38bdf8' },
    { name: 'DMG-01 Bot (CPU)', avatar: '👾', color: '#a855f7' },
    { name: 'Tetromino Rex (CPU)', avatar: '🦖', color: '#f97316' },
    { name: 'Alexey AI (CPU)', avatar: '🧠', color: '#ec4899' },
    { name: 'Pixel Byte (CPU)', avatar: '⚡', color: '#eab308' },
    { name: 'Link-Master (CPU)', avatar: '🔌', color: '#10b981' },
    { name: 'Korobeiniki (CPU)', avatar: '🎵', color: '#f43f5e' }
  ];

  function getMyActiveTournamentMatch() {
    const t = partyState.tournament;
    if (!t || t.status !== 'active' || !Array.isArray(t.rounds)) return null;
    const curRound = t.rounds[t.currentRound] || [];
    return curRound.find(m =>
      m.status === 'active' &&
      ((m.p1 && m.p1.id === playerId) || (m.p2 && m.p2.id === playerId))
    ) || null;
  }

  function wireArenaCallbacks() {
    if (!window.gbTetrisArena || window.gbTetrisArena._callbacksWired) return;
    window.gbTetrisArena._callbacksWired = true;

    window.gbTetrisArena.onSendGarbage = ({ matchId, targetPlayerId, lines, holeCol }) => {
      if (chatWs && chatWs.readyState === WebSocket.OPEN) {
        chatWs.send(JSON.stringify({
          type: 'TOURNAMENT_GARBAGE_ATTACK',
          matchId,
          fromPlayerId: playerId,
          targetPlayerId,
          lines,
          holeCol
        }));
      }
    };

    window.gbTetrisArena.onBroadcastBoard = (stateObj) => {
      if (chatWs && chatWs.readyState === WebSocket.OPEN) {
        chatWs.send(JSON.stringify({
          type: 'TOURNAMENT_BOARD_UPDATE',
          ...stateObj
        }));
      }
    };

    window.gbTetrisArena.onReportRoundWin = ({ matchId, winnerId, score1, score2, lines1, lines2 }) => {
      if (matchId === 'solo_practice') {
        const won = (winnerId === playerId);
        window.gbTetrisArena.onMatchFinished(won ? { id: playerId, name: playerName } : { id: 'cpu_practice', name: 'R.O.B. 89 (CPU)' });
        return;
      }
      if (chatWs && chatWs.readyState === WebSocket.OPEN) {
        chatWs.send(JSON.stringify({
          type: 'TOURNAMENT_REPORT_WIN',
          matchId,
          winnerId,
          score1,
          score2,
          lines1,
          lines2
        }));
      }
    };
  }

  function launchPracticeVsCpu() {
    wireArenaCallbacks();
    if (!window.gbTetrisArena) return;
    const diff = (partyState.tournament && partyState.tournament.cpuDifficulty) || 'normal';
    const practiceMatch = {
      id: 'solo_practice',
      roundName: 'TRAINING',
      bestOf: 1,
      winsNeeded: 1,
      wins1: 0,
      wins2: 0,
      status: 'active',
      seed: Math.floor(100000 + Math.random() * 900000),
      p1: { id: playerId, name: playerName, avatar: playerAvatar, color: playerColor, isCpu: false },
      p2: { id: 'cpu_practice', name: 'R.O.B. 89 (CPU)', avatar: '🤖', color: '#38bdf8', isCpu: true, difficulty: diff }
    };
    window.gbTetrisArena.startMatch(practiceMatch, playerId);
    playRetroBlip(660, 'square', 0.08);
    showToast('🕹️ Solo-Training gegen 🤖 R.O.B. 89 gestartet!');
  }

  function syncTournamentMatchExecution(autoLaunch = false) {
    wireArenaCallbacks();
    const t = partyState.tournament;
    if (!t || t.status !== 'active') {
      if (activeLinkMatchId) {
        activeLinkMatchId = null;
        setWorkletCpuBotMode(false);
        connectDirectLinkCable(true, '');
      }
      return;
    }

    const myMatch = getMyActiveTournamentMatch();
    if (!myMatch) {
      setWorkletCpuBotMode(false);
      return;
    }

    const isP1 = (myMatch.p1 && myMatch.p1.id === playerId);
    const opponent = isP1 ? myMatch.p2 : myMatch.p1;
    const matchKey = `${t.id}_${myMatch.id}`;

    if (t.mode === 'builtin') {
      setWorkletCpuBotMode(false);
      if (autoLaunch || lastAutoStartedMatchKey !== matchKey) {
        lastAutoStartedMatchKey = matchKey;
        if (window.gbTetrisArena) {
          window.gbTetrisArena.startMatch(myMatch, playerId);
          showToast(`⚔️ ${myMatch.roundName}: Du spielst gegen ${opponent.avatar} ${opponent.name}!`);
        }
      }
    } else if (t.mode === 'emulator') {
      if (window.gbTetrisArena && window.gbTetrisArena.isVisible) {
        window.gbTetrisArena.hide();
      }
      if (opponent && opponent.isCpu) {
        // Activate Dual-WASM Link-Cable CPU Bot inside AudioWorklet!
        setWorkletCpuBotMode(true, opponent.difficulty || t.cpuDifficulty || 'normal');
        if (lastAutoStartedMatchKey !== matchKey) {
          lastAutoStartedMatchKey = matchKey;
          showToast(`🤖 Emulator Link-Kabel mit ${opponent.name} gekoppelt!`);
        }
      } else {
        // Connect to isolated per-match Link-Cable WebSocket channel!
        setWorkletCpuBotMode(false);
        if (activeLinkMatchId !== myMatch.id) {
          connectDirectLinkCable(true, myMatch.id);
        }
      }
    }
  }

  function renderTournamentPanel() {
    const container = document.getElementById('tournament-panel-body');
    const statusBadge = document.getElementById('tournament-status-badge');
    if (!container) return;

    const t = partyState.tournament || {
      status: 'lobby',
      mode: 'builtin',
      fillMode: 'odd_plus_one',
      cpuDifficulty: 'normal',
      bestOf: 3,
      customCpus: [],
      participants: [],
      currentRound: 0,
      rounds: [],
      champion: null
    };

    const humans = (partyState.players && partyState.players.length > 0)
      ? partyState.players.slice(0, 8)
      : [{ id: playerId, name: playerName, avatar: playerAvatar, color: playerColor, isCpu: false }];

    if (statusBadge) {
      if (t.status === 'active') {
        const curR = (t.rounds && t.rounds[t.currentRound]) || [];
        const rTitle = (curR[0] && curR[0].roundName) || `Runde ${t.currentRound + 1}`;
        statusBadge.textContent = `⚔️ ${rTitle} läuft`;
        statusBadge.className = 'couch-badge tournament-live-badge';
      } else if (t.status === 'completed' && t.champion) {
        statusBadge.textContent = `🏆 Sieger: ${t.champion.name}`;
        statusBadge.className = 'couch-badge tournament-champ-badge';
      } else {
        statusBadge.textContent = `Max. 8 Spieler + 🤖 Auto-CPU`;
        statusBadge.className = 'couch-badge';
      }
    }

    // --- 1. LOBBY / SETUP VIEW ---
    if (t.status === 'lobby') {
      const customCpus = (t.customCpus || []).slice(0, Math.max(0, 8 - humans.length));
      const baseList = [
        ...humans.map(h => ({ ...h, isCpu: false })),
        ...customCpus.map(c => ({ ...c, isCpu: true, isCustom: true }))
      ];

      let targetCount = baseList.length;
      if (t.fillMode === 'bracket_full') {
        if (targetCount <= 2) targetCount = (targetCount === 1 ? 4 : 2);
        else if (targetCount <= 4) targetCount = 4;
        else targetCount = 8;
      } else {
        if (targetCount < 2) targetCount = 2;
        else if (targetCount % 2 === 1) targetCount += 1;
      }
      targetCount = Math.min(8, targetCount);

      const previewSlots = [];
      let autoCpuCounter = 0;
      for (let i = 0; i < 8; i++) {
        if (i < baseList.length) {
          previewSlots.push({ slot: i + 1, type: baseList[i].isCpu ? 'custom_cpu' : 'human', data: baseList[i] });
        } else if (i < targetCount) {
          const botPreset = PREVIEW_CPU_NAMES[(customCpus.length + autoCpuCounter) % PREVIEW_CPU_NAMES.length];
          autoCpuCounter++;
          previewSlots.push({
            slot: i + 1,
            type: 'auto_cpu',
            data: { name: botPreset.name, avatar: botPreset.avatar, color: botPreset.color, isCpu: true }
          });
        } else {
          previewSlots.push({ slot: i + 1, type: 'empty', data: null });
        }
      }

      const slotsHtml = previewSlots.map(s => {
        if (s.type === 'human') {
          return `
            <div class="tourney-slot-chip human">
              <span class="slot-num">#${s.slot}</span>
              <span class="slot-ava">${escapeHtml(s.data.avatar || '🎮')}</span>
              <span class="slot-name">${escapeHtml(s.data.name)}</span>
            </div>
          `;
        }
        if (s.type === 'custom_cpu' || s.type === 'auto_cpu') {
          return `
            <div class="tourney-slot-chip cpu ${s.type === 'auto_cpu' ? 'auto-fill' : ''}">
              <span class="slot-num">#${s.slot}</span>
              <span class="slot-ava">${escapeHtml(s.data.avatar || '🤖')}</span>
              <span class="slot-name">${escapeHtml(s.data.name)}</span>
              <span class="slot-tag">${s.type === 'auto_cpu' ? 'AUTO-CPU' : 'BOT'}</span>
            </div>
          `;
        }
        return `
          <div class="tourney-slot-chip empty">
            <span class="slot-num">#${s.slot}</span>
            <span class="slot-name">Freier Platz</span>
          </div>
        `;
      }).join('');

      const oddWarningText = (baseList.length % 2 === 1)
        ? `⚡ <strong>Ungerade Teilnehmerzahl (${baseList.length}):</strong> Wird beim Start automatisch mit <strong>+${targetCount - baseList.length} CPU-Gegner</strong> auf <strong>${targetCount} Spieler</strong> aufgefüllt!`
        : `✅ <strong>${targetCount} Teilnehmer bereit</strong> (${humans.length} Mensch${humans.length === 1 ? '' : 'en'}, ${targetCount - humans.length} CPU${targetCount - humans.length === 1 ? '' : 's'}) – ${targetCount / 2} Paarungen in Runde 1.`;

      container.innerHTML = `
        <div class="tourney-info-banner">
          ${oddWarningText}
        </div>

        <!-- 8-Slot Participant Preview Grid -->
        <div class="tourney-slots-grid">
          ${slotsHtml}
        </div>

        <!-- Tournament Settings Grid -->
        <div class="tourney-config-grid">
          <div class="tourney-config-item">
            <label>🕹️ Spiel-Engine:</label>
            <select id="tourney-mode-select" class="tourney-select">
              <option value="builtin" ${t.mode === 'builtin' ? 'selected' : ''}>🕹️ Integriertes DMG Tetris (Ohne ROM + Auto-Sieger)</option>
              <option value="emulator" ${t.mode === 'emulator' ? 'selected' : ''}>🔗 Emulator Link-Kabel (tetris.gb + WASM-Bot)</option>
            </select>
          </div>

          <div class="tourney-config-item">
            <label>🤖 CPU-Auffüllung:</label>
            <select id="tourney-fill-select" class="tourney-select">
              <option value="odd_plus_one" ${t.fillMode === 'odd_plus_one' ? 'selected' : ''}>⚖️ Ungerade Anzahl mit +1 CPU auffüllen</option>
              <option value="bracket_full" ${t.fillMode === 'bracket_full' ? 'selected' : ''}>🏆 Auf vollen 4er / 8er Baum mit CPUs auffüllen</option>
            </select>
          </div>

          <div class="tourney-config-item">
            <label>🧠 CPU-Stärke:</label>
            <select id="tourney-diff-select" class="tourney-select">
              <option value="easy" ${t.cpuDifficulty === 'easy' ? 'selected' : ''}>🟢 Leicht (Einsteiger)</option>
              <option value="normal" ${t.cpuDifficulty === 'normal' ? 'selected' : ''}>🟡 Normal (Klassisch)</option>
              <option value="hard" ${t.cpuDifficulty === 'hard' ? 'selected' : ''}>🔴 Stark (Tetris-Meister)</option>
            </select>
          </div>

          <div class="tourney-config-item">
            <label>❤️ Match-Format:</label>
            <select id="tourney-bestof-select" class="tourney-select">
              <option value="3" ${t.bestOf === 3 ? 'selected' : ''}>♥♥ Best of 3 (2 Herzen zum Sieg)</option>
              <option value="1" ${t.bestOf === 1 ? 'selected' : ''}>♥ Best of 1 (1 K.O.-Runde)</option>
            </select>
          </div>
        </div>

        <!-- Action Buttons Row -->
        <div class="tourney-actions-row">
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <button type="button" class="retro-btn retro-btn-secondary" id="btn-tourney-add-cpu" style="padding:7px 11px; font-size:11.5px;" ${baseList.length >= 8 ? 'disabled' : ''}>
              + 🤖 CPU hinzufügen
            </button>
            ${customCpus.length > 0 ? `
              <button type="button" class="retro-btn retro-btn-secondary" id="btn-tourney-rem-cpu" style="padding:7px 10px; font-size:11.5px;">
                - 🤖 CPU (${customCpus.length})
              </button>
            ` : ''}
            <button type="button" class="retro-btn retro-btn-secondary" id="btn-tourney-practice" style="padding:7px 11px; font-size:11.5px; border-color:#38bdf8; color:#7dd3fc;">
              🎮 Training vs CPU
            </button>
          </div>

          <button type="button" class="retro-btn tourney-start-cta" id="btn-tourney-start">
            🏆 Turnier starten (${targetCount}er Feld)
          </button>
        </div>
      `;

      const sendConfig = () => {
        if (!chatWs || chatWs.readyState !== WebSocket.OPEN) return;
        const modeVal = document.getElementById('tourney-mode-select')?.value || 'builtin';
        const fillVal = document.getElementById('tourney-fill-select')?.value || 'odd_plus_one';
        const diffVal = document.getElementById('tourney-diff-select')?.value || 'normal';
        const bestOfVal = parseInt(document.getElementById('tourney-bestof-select')?.value || '3', 10);
        chatWs.send(JSON.stringify({
          type: 'TOURNAMENT_CONFIG',
          mode: modeVal,
          fillMode: fillVal,
          cpuDifficulty: diffVal,
          bestOf: bestOfVal
        }));
      };

      ['tourney-mode-select', 'tourney-fill-select', 'tourney-diff-select', 'tourney-bestof-select'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.onchange = sendConfig;
      });

      const addCpuBtn = document.getElementById('btn-tourney-add-cpu');
      if (addCpuBtn) {
        addCpuBtn.onclick = () => {
          playRetroBlip(580, 'square', 0.05);
          if (chatWs && chatWs.readyState === WebSocket.OPEN) {
            chatWs.send(JSON.stringify({ type: 'TOURNAMENT_ADD_CPU' }));
          }
        };
      }

      const remCpuBtn = document.getElementById('btn-tourney-rem-cpu');
      if (remCpuBtn) {
        remCpuBtn.onclick = () => {
          playRetroBlip(420, 'square', 0.05);
          if (chatWs && chatWs.readyState === WebSocket.OPEN) {
            chatWs.send(JSON.stringify({ type: 'TOURNAMENT_REMOVE_CPU' }));
          }
        };
      }

      const practiceBtn = document.getElementById('btn-tourney-practice');
      if (practiceBtn) {
        practiceBtn.onclick = launchPracticeVsCpu;
      }

      const startBtn = document.getElementById('btn-tourney-start');
      if (startBtn) {
        startBtn.onclick = () => {
          playRetroBlip(660, 'triangle', 0.09);
          setTimeout(() => playRetroBlip(880, 'triangle', 0.14), 90);
          if (chatWs && chatWs.readyState === WebSocket.OPEN) {
            chatWs.send(JSON.stringify({
              type: 'TOURNAMENT_START',
              mode: document.getElementById('tourney-mode-select')?.value || t.mode,
              fillMode: document.getElementById('tourney-fill-select')?.value || t.fillMode,
              cpuDifficulty: document.getElementById('tourney-diff-select')?.value || t.cpuDifficulty,
              bestOf: parseInt(document.getElementById('tourney-bestof-select')?.value || t.bestOf, 10)
            }));
          }
        };
      }
      return;
    }

    // --- 2. ACTIVE OR COMPLETED TOURNAMENT BRACKET VIEW ---
    const myMatch = getMyActiveTournamentMatch();
    let activeMatchCalloutHtml = '';

    if (t.status === 'completed' && t.champion) {
      activeMatchCalloutHtml = `
        <div class="tourney-champion-banner">
          <div class="champ-trophy">🏆</div>
          <div class="champ-info">
            <div class="champ-label">TETRIS-TURNIERSIEGER</div>
            <div class="champ-name">${escapeHtml(t.champion.avatar || '👑')} ${escapeHtml(t.champion.name)}</div>
          </div>
          <button type="button" class="retro-btn" id="btn-tourney-reset" style="padding:8px 14px; font-size:12px;">
            🔄 Neues Turnier
          </button>
        </div>
      `;
    } else if (myMatch) {
      const isP1 = (myMatch.p1 && myMatch.p1.id === playerId);
      const meObj = isP1 ? myMatch.p1 : myMatch.p2;
      const oppObj = isP1 ? myMatch.p2 : myMatch.p1;
      const myWins = isP1 ? myMatch.wins1 : myMatch.wins2;
      const oppWins = isP1 ? myMatch.wins2 : myMatch.wins1;

      activeMatchCalloutHtml = `
        <div class="tourney-my-match-box">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:8px;">
            <div>
              <span class="my-match-pill">⚔️ DEIN AKTIVES MATCH (${escapeHtml(myMatch.roundName)})</span>
              <div style="font-size:13.5px; font-weight:800; color:#f8fafc; margin-top:4px;">
                ${escapeHtml(meObj.avatar)} ${escapeHtml(meObj.name)}
                <span style="color:#48c78e; margin:0 6px;">${myWins} : ${oppWins}</span>
                ${escapeHtml(oppObj.avatar)} ${escapeHtml(oppObj.name)}
              </div>
            </div>

            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              ${t.mode === 'builtin' ? `
                <button type="button" class="retro-btn" id="btn-open-my-tetris-match" style="padding:7px 12px; font-size:12px;">
                  🕹️ Auf Game Boy spielen
                </button>
              ` : `
                <button type="button" class="retro-btn" id="btn-claim-emu-win" style="padding:6px 10px; font-size:11.5px; background:#16a34a;" title="Punkt/Herz für dich melden">
                  🏆 +1 Herz (Ich)
                </button>
                <button type="button" class="retro-btn retro-btn-secondary" id="btn-claim-emu-loss" style="padding:6px 10px; font-size:11.5px;" title="Punkt/Herz für Gegner melden">
                  💥 +1 Herz (${escapeHtml(oppObj.name.slice(0, 10))})
                </button>
              `}
            </div>
          </div>

          ${(t.mode === 'emulator' && oppObj && oppObj.isCpu) ? `
            <div class="emu-cpu-preview-row">
              <canvas id="emulator-cpu-mini-canvas" width="160" height="144" class="emu-cpu-mini-lcd"></canvas>
              <div style="font-size:11.5px; color:#cbd5e1; line-height:1.4;">
                <strong>🤖 Dual-WASM CPU-Game-Boy aktiv (${escapeHtml(oppObj.name)})</strong><br>
                Dieser zweite Game Boy läuft im Hintergrund und ist per virtuellem Link-Kabel direkt mit deinem Emulator verbunden!
              </div>
            </div>
          ` : ''}
        </div>
      `;
    }

    // Build visual K.O. Bracket Columns for all generated rounds
    const rounds = t.rounds || [];
    const bracketColsHtml = rounds.map((roundMatches, rIdx) => {
      const roundTitle = (roundMatches[0] && roundMatches[0].roundName) || `Runde ${rIdx + 1}`;
      const isCurrent = (rIdx === t.currentRound && t.status === 'active');

      const matchesHtml = roundMatches.map(m => {
        const p1Won = (m.status === 'completed' && m.winnerId === m.p1.id);
        const p2Won = (m.status === 'completed' && m.winnerId === m.p2.id);
        const isMyMatch = (m.p1.id === playerId || m.p2.id === playerId);

        const hearts1 = '♥'.repeat(m.wins1 || 0) + '♡'.repeat(Math.max(0, (m.winsNeeded || 2) - (m.wins1 || 0)));
        const hearts2 = '♥'.repeat(m.wins2 || 0) + '♡'.repeat(Math.max(0, (m.winsNeeded || 2) - (m.wins2 || 0)));

        return `
          <div class="bracket-match-card ${m.status === 'active' ? 'is-live' : 'is-done'} ${isMyMatch ? 'is-mine' : ''}">
            <div class="bracket-match-header">
              <span>Match #${m.matchIndex + 1}</span>
              ${m.status === 'active' ? `
                <button type="button" class="bracket-spectate-btn" data-spectate-round="${rIdx}" data-spectate-match="${m.id}">
                  ${isMyMatch && t.mode === 'builtin' ? '🕹️ Spielen' : '👁️ Live'}
                </button>
              ` : `<span style="color:#48c78e;">✅ Beendet</span>`}
            </div>

            <div class="bracket-player-row ${p1Won ? 'winner' : (p2Won ? 'loser' : '')}">
              <span class="bp-name">
                ${escapeHtml(m.p1.avatar || '🎮')} ${escapeHtml(m.p1.name)}
                ${m.p1.isCpu ? '<span class="cpu-mini-tag">CPU</span>' : ''}
              </span>
              <span class="bp-score">${hearts1}</span>
            </div>

            <div class="bracket-player-row ${p2Won ? 'winner' : (p1Won ? 'loser' : '')}">
              <span class="bp-name">
                ${escapeHtml(m.p2.avatar || '🎮')} ${escapeHtml(m.p2.name)}
                ${m.p2.isCpu ? '<span class="cpu-mini-tag">CPU</span>' : ''}
              </span>
              <span class="bp-score">${hearts2}</span>
            </div>
          </div>
        `;
      }).join('');

      return `
        <div class="bracket-round-col ${isCurrent ? 'current-round' : ''}">
          <div class="bracket-round-title">${escapeHtml(roundTitle)}</div>
          <div class="bracket-matches-list">
            ${matchesHtml}
          </div>
        </div>
      `;
    }).join('');

    container.innerHTML = `
      ${activeMatchCalloutHtml}
      <div class="tourney-bracket-scroll">
        ${bracketColsHtml}
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px; padding-top:10px; border-top:1px solid #283040;">
        <span style="font-size:11px; color:#94a3b8;">
          Modus: <strong>${t.mode === 'builtin' ? '🕹️ Integriertes DMG Tetris' : '🔗 Emulator Link-Kabel'}</strong> • ${t.participants ? t.participants.length : 0} Teilnehmer
        </span>
        <button type="button" class="retro-btn retro-btn-secondary" id="btn-tourney-reset-bottom" style="padding:5px 10px; font-size:11px;">
          🔄 Turnier neu starten
        </button>
      </div>
    `;

    const playMyBtn = document.getElementById('btn-open-my-tetris-match');
    if (playMyBtn && myMatch) {
      playMyBtn.onclick = () => {
        wireArenaCallbacks();
        if (window.gbTetrisArena) {
          window.gbTetrisArena.startMatch(myMatch, playerId);
        }
      };
    }

    const claimWinBtn = document.getElementById('btn-claim-emu-win');
    if (claimWinBtn && myMatch) {
      claimWinBtn.onclick = () => {
        if (chatWs && chatWs.readyState === WebSocket.OPEN) {
          chatWs.send(JSON.stringify({
            type: 'TOURNAMENT_REPORT_WIN',
            matchId: myMatch.id,
            winnerId: playerId
          }));
        }
      };
    }

    const claimLossBtn = document.getElementById('btn-claim-emu-loss');
    if (claimLossBtn && myMatch) {
      const opp = (myMatch.p1.id === playerId) ? myMatch.p2 : myMatch.p1;
      claimLossBtn.onclick = () => {
        if (chatWs && chatWs.readyState === WebSocket.OPEN && opp) {
          chatWs.send(JSON.stringify({
            type: 'TOURNAMENT_REPORT_WIN',
            matchId: myMatch.id,
            winnerId: opp.id
          }));
        }
      };
    }

    const doResetTourney = () => {
      if (confirm('Möchtest du das aktuelle Turnier wirklich zurücksetzen?')) {
        if (window.gbTetrisArena && window.gbTetrisArena.isVisible) {
          window.gbTetrisArena.hide();
        }
        setWorkletCpuBotMode(false);
        if (chatWs && chatWs.readyState === WebSocket.OPEN) {
          chatWs.send(JSON.stringify({ type: 'TOURNAMENT_RESET' }));
        }
      }
    };

    const resetBtn1 = document.getElementById('btn-tourney-reset');
    if (resetBtn1) resetBtn1.onclick = doResetTourney;
    const resetBtn2 = document.getElementById('btn-tourney-reset-bottom');
    if (resetBtn2) resetBtn2.onclick = doResetTourney;

    container.querySelectorAll('.bracket-spectate-btn').forEach(btn => {
      btn.onclick = () => {
        const rIdx = parseInt(btn.getAttribute('data-spectate-round'), 10);
        const mId = btn.getAttribute('data-spectate-match');
        const roundArr = (t.rounds && t.rounds[rIdx]) || [];
        const found = roundArr.find(x => x.id === mId);
        if (!found) return;
        wireArenaCallbacks();
        if (found.p1.id === playerId || found.p2.id === playerId) {
          if (t.mode === 'builtin' && window.gbTetrisArena) {
            window.gbTetrisArena.startMatch(found, playerId);
          }
        } else if (window.gbTetrisArena) {
          window.gbTetrisArena.startSpectating(found);
          showToast(`👁️ Du schaust jetzt ${found.p1.name} vs. ${found.p2.name} zu!`);
        }
      };
    });
  }

  function sendPartyUpdate() {
    if (!chatWs || chatWs.readyState !== WebSocket.OPEN) return;
    const emuReady = !!(window.__gbWorkletNode && window.__gbWorkletNode.port);
    chatWs.send(JSON.stringify({
      type: 'UPDATE_USER',
      user: {
        id: playerId,
        name: playerName,
        avatar: playerAvatar,
        color: playerColor,
        rom: currentRomName,
        emulatorReady: emuReady,
        isReady: true
      }
    }));
  }

  // Switch to any room code cleanly (syncs URL, Party-Couch, Chat & Auto-Link-Cable)
  function switchRoom(newCode) {
    const clean = normalizeRoomCode(newCode);
    if (!clean) return;

    currentRoom = clean;
    activeLinkMatchId = null;
    localStorage.setItem('gb_last_room', clean);

    try {
      const u = new URL(window.location.href);
      u.searchParams.set('room', clean);
      window.history.replaceState({ room: clean }, '', u.toString());
    } catch (e) {}

    updateHeaderProfileUI();
    connectChat(clean, true);
    connectDirectLinkCable(true, '');
    updateLinkCableUI();
    showToast(`🎉 Raum gewechselt: ${clean}`);
  }

  async function loadServerRomByName(romName, showNotification = true) {
    if (!romName) return;
    try {
      const select = document.getElementById('sidebar-rom-select');
      if (select) select.value = romName;

      const resp = await fetch(`/api/roms/${encodeURIComponent(romName)}`);
      if (!resp.ok) throw new Error('ROM nicht gefunden');
      const blob = await resp.blob();
      const buffer = await blob.arrayBuffer();
      await saveSessionRom(romName, buffer);
      await feedRomToEmulator(buffer, romName);
      playRetroBlip(880, 'triangle', 0.12);
      if (showNotification) {
        showToast(`🎮 "${romName}" geladen!`);
      }
    } catch (e) {
      alert('Fehler beim Laden der ROM: ' + e.message);
    }
  }

  // Initialize UI layout
  function initLayout() {
    if (!document.getElementById('retro-header')) {
      const header = document.createElement('header');
      header.id = 'retro-header';
      header.className = 'retro-top-bar';
      header.innerHTML = `
        <div class="header-left-group">
          <div class="retro-logo">
            <span class="retro-logo-icon">🏆</span>
            <span class="retro-logo-text">GAME BOY TETRIS TURNIER</span>
          </div>

          <!-- Treffen-inspired Room Pill -->
          <div class="room-pill" title="Aktueller 4-stelliger Party- & Link-Kabel-Code">
            <span class="status-dot connected" id="live-party-dot" title="Party-Server verbunden"></span>
            <div class="room-pill-code-box" id="header-room-code-box" title="Klicken zum Kopieren des Einladungslinks">
              <span class="room-pill-label">Code:</span>
              <span class="room-pill-code" id="header-room-code">${escapeHtml(currentRoom)}</span>
            </div>
            <div class="room-pill-actions">
              <button class="pill-icon-btn" id="pill-copy-btn" title="Einladungslink kopieren">📋</button>
              <button class="pill-icon-btn" id="pill-qr-btn" title="QR-Code für Freunde anzeigen">📱</button>
              <button class="pill-icon-btn" id="pill-switch-room-btn" title="Freundescode eingeben / Raum wechseln">✏️</button>
              <button class="pill-icon-btn" id="pill-new-room-btn" title="Neuen 4-stelligen Raum-Code würfeln">🎲</button>
            </div>
          </div>
        </div>

        <div class="retro-top-badges">
          <div class="room-status-badge" id="top-status-badge">
            <span class="status-dot waiting" id="top-status-dot"></span>
            <span id="top-status-text">Link-Kabel bereit</span>
          </div>

          <div class="user-profile-badge" id="header-user-badge" title="Spieler-Profil & Avatar anpassen">
            <div class="user-avatar-circle" id="header-user-avatar">${escapeHtml(playerAvatar)}</div>
            <div class="user-badge-info">
              <span class="user-badge-name" id="header-user-name">${escapeHtml(playerName)}</span>
              <span class="user-badge-role is-host" id="header-user-role">👑 Party-Host</span>
            </div>
          </div>
        </div>
      `;
      document.body.prepend(header);
    }

    const root = document.getElementById('root');
    if (root && !document.getElementById('main-retro-layout')) {
      const mainLayout = document.createElement('div');
      mainLayout.id = 'main-retro-layout';
      mainLayout.className = 'main-layout';

      const leftCol = document.createElement('div');
      leftCol.id = 'left-console-col';
      leftCol.className = 'console-column';

      const rightCol = document.createElement('div');
      rightCol.id = 'right-dashboard-col';
      rightCol.className = 'dashboard-panel';
      rightCol.innerHTML = `
        <!-- 🏆 8-Player Tetris Tournament & CPU Auto-Fill Card -->
        <div class="retro-card tournament-main-card">
          <div class="couch-header-row">
            <div class="retro-card-title" style="margin-bottom:0; color:#fbbf24;">
              <span>🏆</span> Tetris-Turnier (bis 8 Spieler)
              <span class="couch-badge" id="tournament-status-badge">Max. 8 Spieler + 🤖 Auto-CPU</span>
            </div>
          </div>
          <div id="tournament-panel-body"></div>
        </div>

        <!-- Treffen-inspired Party-Couch & Matchmaking Card -->
        <div class="retro-card">
          <div class="couch-header-row">
            <div class="retro-card-title" style="margin-bottom:0;">
              <span>🛋️</span> Party-Couch <span class="couch-badge" id="party-count-badge">1 Spieler online</span>
            </div>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <button class="retro-btn" id="btn-copy-invite" style="padding:5px 10px; font-size:11.5px;">📋 Einladen</button>
              <button class="retro-btn retro-btn-secondary" id="btn-open-room-modal" style="padding:5px 10px; font-size:11.5px;">🔑 Code eingeben</button>
              <button class="retro-btn retro-btn-secondary" id="btn-open-settings" style="padding:5px 9px; font-size:11.5px;" title="Erweiterte Emulator-Einstellungen">⚙️</button>
            </div>
          </div>

          <!-- Auto Link-Cable Status Banner -->
          <div class="link-cable-banner waiting" id="link-cable-banner">
            <span id="link-cable-banner-text">🔌 <strong>Link-Kabel bereit</strong> – Verbindet automatisch, sobald 2 Spieler im Raum sind!</span>
            <button class="retro-btn retro-btn-secondary" id="btn-reconnect-link" style="padding:4px 8px; font-size:10.5px; white-space:nowrap;" title="Link-Kabel neu synchronisieren">🔄 Sync</button>
          </div>

          <!-- Live Player Roster -->
          <div class="player-roster-grid" id="party-roster-grid"></div>

          <!-- Synchronized ROM Selector & Party Launch -->
          <div class="rom-selector-row">
            <span style="font-size:12.5px; font-weight:700; white-space:nowrap;">🎮 Spiel:</span>
            <select class="rom-select-box" id="sidebar-rom-select">
              <option value="">-- Server-ROM wählen --</option>
            </select>
            <button class="retro-btn" id="btn-party-launch-rom" style="padding:8px 12px; font-size:12px; white-space:nowrap;">
              🚀 Für Party starten
            </button>
          </div>
          <div id="active-rom-label" style="font-size:11.5px; color:#94a3b8; margin-top:8px;"></div>
        </div>

        <!-- Spielstand (.sav) Manager Card -->
        <div class="retro-card">
          <details id="admin-save-panel">
            <summary class="retro-card-title" style="cursor:pointer; list-style:none; margin-bottom:0;">
              <span>💾</span> Spielstand (.sav) Manager ▾
            </summary>
            <div style="padding-top:12px;">
              <div style="font-size:12px; color:#94a3b8; margin-bottom:10px; line-height:1.4;">
                Exportiert und importiert echte <strong>32 KB Battery-SRAM .sav</strong> Spielstände. (Immer erst im Spiel <em>START &rarr; SICHERN</em> ausführen!)
              </div>
              <div id="save-manager-content" style="margin-bottom:12px;"></div>
              <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                <button id="btn-force-save-sync" class="retro-btn" style="font-size:11px; padding:6px 10px; background:#2563eb;" title="Synchronisiert den Emulator-RAM sofort in den Browser">
                  🔄 Emulator sichern (Sync)
                </button>
                <label class="retro-btn retro-btn-secondary" style="cursor:pointer; display:inline-flex; align-items:center; gap:4px; font-size:11px; padding:6px 10px;">
                  ⬆️ .sav importieren
                  <input type="file" id="input-import-sav-file" accept=".sav,.bin" style="display:none;">
                </label>
                <button id="btn-load-demo-save" class="retro-btn retro-btn-secondary" style="font-size:11px; padding:6px 9px; border-color:#eab308; color:#fde047;" title="Lädt einen vorgefertigten Pokémon Rot Starter-Spielstand">
                  ⭐ Starter-Spielstand
                </button>
              </div>
            </div>
          </details>
        </div>

        <!-- Live Chat Card -->
        <div class="retro-card chat-container">
          <div class="chat-header-bar">
            <div class="retro-card-title" style="margin-bottom:0;"><span>💬</span> Party-Chat</div>
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-size:11px; color:#94a3b8;">Name:</span>
              <input type="text" id="player-name-input" value="${escapeHtml(playerName)}" style="background:#0f131a; border:1px solid #334155; color:#fff; border-radius:4px; padding:2px 6px; font-size:12px; width:110px;">
            </div>
          </div>
          <div class="chat-messages" id="chat-messages-list">
            <div class="chat-msg system">
              <div class="chat-bubble">Willkommen in Raum <strong>${escapeHtml(currentRoom)}</strong>! Teile den Link oder Code mit deinen Mitspielern (bis zu 8 Spieler im Turnier!).</div>
            </div>
          </div>
          <div class="quick-reactions">
            <button class="reaction-btn" data-msg="🎮 Bereit fürs Turnier!">🎮 Bereit!</button>
            <button class="reaction-btn" data-msg="🏆 Startet das Turnier!">🏆 Turnier!</button>
            <button class="reaction-btn" data-msg="⚡ Tetris-Attacke!">⚡ Tetris!</button>
            <button class="reaction-btn" data-msg="👏 Gutes Spiel!">👏 GG!</button>
            <button class="reaction-btn" data-msg="🔥 Noch eine Runde!">🔥 Revanche!</button>
            <button class="reaction-btn" data-msg="⏰ Moment...">⏰ Moment...</button>
          </div>
          <div class="chat-input-row">
            <input type="text" class="chat-input-box" id="chat-input" placeholder="Nachricht an deine Party...">
            <button class="chat-send-btn" id="chat-send-btn">Senden</button>
          </div>
        </div>

        <!-- Tastatur Steuerung Legend -->
        <div class="retro-card">
          <div class="retro-card-title"><span>⌨️</span> Tastatur-Steuerung</div>
          <div class="controls-legend">
            <div class="key-badge-card"><span class="key-cap">⬅️⬆️⬇️➡️</span><span class="key-desc">D-Pad / Move</span></div>
            <div class="key-badge-card"><span class="key-cap">A / J / W</span><span class="key-desc">Drehen (A)</span></div>
            <div class="key-badge-card"><span class="key-cap">B / K / Space</span><span class="key-desc">Hard Drop (B)</span></div>
            <div class="key-badge-card"><span class="key-cap">Enter</span><span class="key-desc">Start</span></div>
            <div class="key-badge-card"><span class="key-cap">Backspace</span><span class="key-desc">Select</span></div>
          </div>
        </div>
      `;

      leftCol.appendChild(root);
      mainLayout.appendChild(leftCol);
      mainLayout.appendChild(rightCol);
      document.body.appendChild(mainLayout);

      injectModals();
      wireEvents();
      updateHeaderProfileUI();
      renderPartyRoster();
      renderTournamentPanel();
      updateRomDisplay();
      refreshSaveManagerList();
      connectChat(currentRoom);
    }
  }

  function injectModals() {
    if (document.getElementById('party-qr-modal')) return;

    const modalsWrapper = document.createElement('div');
    modalsWrapper.innerHTML = `
      <!-- 1. QR-Code & Invite Modal -->
      <div class="party-modal-backdrop" id="party-qr-modal">
        <div class="party-modal-card" style="text-align:center;">
          <button class="party-modal-close" data-close-modal="party-qr-modal">✕</button>
          <div style="font-size:32px; margin-bottom:6px;">📱</div>
          <h3 style="margin:0 0 6px 0; font-size:18px; color:#f8fafc;">Freunde zum Turnier einladen</h3>
          <p style="margin:0 0 14px 0; font-size:13px; color:#94a3b8;">Scanne den QR-Code oder teile den 4-stelligen Freundescode (bis 8 Spieler):</p>
          <div style="background:#10141d; border:1.5px solid #2e3646; border-radius:12px; padding:10px; display:inline-block; margin-bottom:12px;">
            <img id="party-qr-img" src="" alt="QR Code" style="width:170px; height:170px; border-radius:8px; display:block;">
          </div>
          <div style="margin-bottom:14px;">
            <span style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">PARTY- & TURNIER-CODE</span>
            <span id="party-qr-code-text" style="font-family:'Press Start 2P', monospace; font-size:20px; color:#48c78e; letter-spacing:3px;">${escapeHtml(currentRoom)}</span>
          </div>
          <div style="display:flex; gap:8px;">
            <input type="text" id="party-qr-url-input" readonly style="flex:1; background:#10141d; border:1px solid #334155; color:#cbd5e1; border-radius:8px; padding:8px 10px; font-size:12px;">
            <button class="retro-btn" id="party-qr-copy-btn">📋 Kopieren</button>
          </div>
        </div>
      </div>

      <!-- 2. Switch Room / Enter Friend Code Modal -->
      <div class="party-modal-backdrop" id="party-room-modal">
        <div class="party-modal-card">
          <button class="party-modal-close" data-close-modal="party-room-modal">✕</button>
          <div style="font-size:28px; margin-bottom:6px;">🔑</div>
          <h3 style="margin:0 0 6px 0; font-size:18px; color:#f8fafc;">Raum wechseln / Freundescode</h3>
          <p style="margin:0 0 14px 0; font-size:13px; color:#94a3b8;">Gib den 4-stelligen Code deines Freundes ein (Kleinbuchstaben & Zahlen, ohne 'o'):</p>
          <div style="display:flex; gap:8px; margin-bottom:14px;">
            <input type="text" id="party-room-input" maxlength="8" placeholder="z.B. k7p4" style="flex:1; background:#10141d; border:1.5px solid #334155; color:#48c78e; border-radius:10px; padding:10px 14px; font-family:'Press Start 2P', monospace; font-size:14px; text-transform:lowercase; outline:none;">
            <button class="retro-btn" id="party-room-join-btn">Beitreten</button>
          </div>
          <div style="border-top:1px solid #283040; padding-top:12px; display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:12px; color:#94a3b8;">Oder neuen Raum erstellen:</span>
            <button class="retro-btn retro-btn-secondary" id="party-room-random-btn" style="font-size:12px; padding:7px 12px;">🎲 Neuer 4er-Code</button>
          </div>
        </div>
      </div>

      <!-- 3. Player Profile & Avatar Picker Modal -->
      <div class="party-modal-backdrop" id="party-profile-modal">
        <div class="party-modal-card">
          <button class="party-modal-close" data-close-modal="party-profile-modal">✕</button>
          <div style="font-size:28px; margin-bottom:6px;">✏️</div>
          <h3 style="margin:0 0 4px 0; font-size:18px; color:#f8fafc;">Dein Spieler-Profil</h3>
          <p style="margin:0 0 14px 0; font-size:12.5px; color:#94a3b8;">Wähle deinen Namen und deinen Avatar für die Party-Couch:</p>
          <div style="margin-bottom:14px;">
            <label style="font-size:12px; font-weight:700; color:#cbd5e1; display:block; margin-bottom:6px;">Dein Name:</label>
            <input type="text" id="party-profile-name-input" maxlength="18" value="${escapeHtml(playerName)}" style="width:100%; background:#10141d; border:1.5px solid #334155; color:#fff; border-radius:10px; padding:9px 12px; font-size:14px; font-weight:700; outline:none;">
          </div>
          <div style="margin-bottom:18px;">
            <label style="font-size:12px; font-weight:700; color:#cbd5e1; display:block; margin-bottom:6px;">Wähle deinen Avatar:</label>
            <div class="avatar-picker-grid" id="party-avatar-grid"></div>
          </div>
          <div style="display:flex; justify-content:flex-end; gap:8px;">
            <button class="retro-btn retro-btn-secondary" data-close-modal="party-profile-modal">Abbrechen</button>
            <button class="retro-btn" id="party-profile-save-btn">💾 Profil speichern</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modalsWrapper);
  }

  function openQrModal() {
    const modal = document.getElementById('party-qr-modal');
    if (!modal) return;
    const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(currentRoom)}`;
    const qrImg = document.getElementById('party-qr-img');
    const codeText = document.getElementById('party-qr-code-text');
    const urlInput = document.getElementById('party-qr-url-input');
    if (qrImg) qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(inviteUrl)}`;
    if (codeText) codeText.textContent = currentRoom;
    if (urlInput) urlInput.value = inviteUrl;
    modal.classList.add('open');
  }

  function openRoomModal() {
    const modal = document.getElementById('party-room-modal');
    const input = document.getElementById('party-room-input');
    if (!modal) return;
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 100);
    }
    modal.classList.add('open');
  }

  let selectedTempAvatar = playerAvatar;
  function openProfileModal() {
    const modal = document.getElementById('party-profile-modal');
    const nameInput = document.getElementById('party-profile-name-input');
    const grid = document.getElementById('party-avatar-grid');
    if (!modal) return;

    selectedTempAvatar = playerAvatar;
    if (nameInput) nameInput.value = playerName;

    if (grid) {
      grid.innerHTML = '';
      ALL_AVATARS.forEach(emoji => {
        const div = document.createElement('div');
        div.className = `avatar-pick-item ${emoji === selectedTempAvatar ? 'selected' : ''}`;
        div.textContent = emoji;
        div.onclick = () => {
          grid.querySelectorAll('.avatar-pick-item').forEach(el => el.classList.remove('selected'));
          div.classList.add('selected');
          selectedTempAvatar = emoji;
        };
        grid.appendChild(div);
      });
    }

    modal.classList.add('open');
  }

  // Connect to Party-Hub, Live Chat & Tournament WebSocket (/chat)
  function connectChat(roomName, force = false) {
    if (!roomName) return;
    const cleanRoom = normalizeRoomCode(roomName) || 'lobby';
    if (!force && chatWs && chatWs.readyState === WebSocket.OPEN && currentRoom === cleanRoom) return;

    if (chatWs) {
      try { chatWs.close(); } catch (e) {}
      chatWs = null;
    }

    currentRoom = cleanRoom;
    localStorage.setItem('gb_last_room', cleanRoom);
    updateHeaderProfileUI();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const chatUrl = `${protocol}//${window.location.host}/chat?room=${encodeURIComponent(cleanRoom)}&name=${encodeURIComponent(playerName)}&avatar=${encodeURIComponent(playerAvatar)}&color=${encodeURIComponent(playerColor)}&playerId=${encodeURIComponent(playerId)}`;

    try {
      const ws = new WebSocket(chatUrl);
      chatWs = ws;

      ws.onopen = () => {
        const liveDot = document.getElementById('live-party-dot');
        if (liveDot) liveDot.className = 'status-dot connected';
        sendPartyUpdate();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (!msg || !msg.type) return;

          if (msg.type === 'ROSTER_SYNC') {
            partyState.players = Array.isArray(msg.players) ? msg.players : [];
            partyState.hostId = msg.hostId || null;
            partyState.isHost = (partyState.hostId === playerId);
            if (msg.selectedRom && !partyState.selectedRom) {
              partyState.selectedRom = msg.selectedRom;
            }
            if (msg.tournament) {
              partyState.tournament = msg.tournament;
            }
            updateHeaderProfileUI();
            renderPartyRoster();
            renderTournamentPanel();
            return;
          }

          if (msg.type === 'TOURNAMENT_SYNC') {
            if (msg.tournament) {
              partyState.tournament = msg.tournament;
              renderTournamentPanel();
              syncTournamentMatchExecution(false);
            }
            return;
          }

          if (msg.type === 'TOURNAMENT_STARTED' || msg.type === 'TOURNAMENT_ROUND_STARTED') {
            if (msg.tournament) {
              partyState.tournament = msg.tournament;
              renderTournamentPanel();
              syncTournamentMatchExecution(true);
            }
            return;
          }

          if (msg.type === 'TOURNAMENT_GARBAGE_INCOMING') {
            const myMatch = getMyActiveTournamentMatch();
            if (myMatch && msg.matchId === myMatch.id && msg.fromPlayerId !== playerId) {
              if (!msg.targetPlayerId || msg.targetPlayerId === playerId) {
                if (window.gbTetrisArena) {
                  window.gbTetrisArena.receiveGarbage(msg.lines || 1, msg.holeCol);
                }
              }
            }
            return;
          }

          if (msg.type === 'TOURNAMENT_BOARD_STATE') {
            if (window.gbTetrisArena) {
              window.gbTetrisArena.receiveRemoteBoardState(msg);
            }
            return;
          }

          if (msg.type === 'TOURNAMENT_HEART_WON') {
            const myMatch = getMyActiveTournamentMatch();
            if (myMatch && msg.matchId === myMatch.id && window.gbTetrisArena) {
              window.gbTetrisArena.onHeartRoundTransition(msg.roundWinnerName || 'Spieler', msg.wins1, msg.wins2, msg.nextSeed);
            }
            return;
          }

          if (msg.type === 'TOURNAMENT_MATCH_COMPLETED') {
            if (window.gbTetrisArena && window.gbTetrisArena.activeMatch && window.gbTetrisArena.activeMatch.id === msg.matchId) {
              window.gbTetrisArena.onMatchFinished(msg.winner);
            }
            return;
          }

          if (msg.type === 'TOURNAMENT_CHAMPION') {
            if (msg.tournament) {
              partyState.tournament = msg.tournament;
              renderTournamentPanel();
            }
            if (msg.champion) {
              showToast(`🏆 Turniersieger: ${msg.champion.avatar || '👑'} ${msg.champion.name}!`);
            }
            return;
          }

          if (msg.type === 'HOST_TRANSFERRED') {
            partyState.hostId = msg.newHostId;
            partyState.isHost = (msg.newHostId === playerId);
            updateHeaderProfileUI();
            renderPartyRoster();
            renderTournamentPanel();
            if (partyState.isHost) {
              showToast('👑 Du bist jetzt der Party-Host!');
            }
            return;
          }

          if (msg.type === 'PARTY_LAUNCH_ROM') {
            if (msg.rom) {
              showToast(`🚀 ${msg.initiatedBy || 'Host'} startet ${msg.rom}!`);
              loadServerRomByName(msg.rom, false);
            }
            return;
          }

          if (msg.type === 'history') {
            const chatList = document.getElementById('chat-messages-list');
            if (chatList) chatList.innerHTML = '';
            msg.messages.forEach(m => addChatMessage(m, false));
          } else if (msg.type === 'chat' || msg.type === 'system') {
            addChatMessage(msg, true);
          }
        } catch (e) {}
      };

      ws.onclose = () => {
        if (chatWs === ws) {
          const liveDot = document.getElementById('live-party-dot');
          if (liveDot) liveDot.className = 'status-dot waiting';
          clearTimeout(chatReconnectTimer);
          chatReconnectTimer = setTimeout(() => connectChat(currentRoom, true), 2500);
        }
      };
    } catch (e) {
      console.error('Party/Chat connection error:', e);
    }
  }

  function addChatMessage(msg, playSound = true) {
    const chatList = document.getElementById('chat-messages-list');
    if (!chatList) return;

    const div = document.createElement('div');
    const isMine = msg.sender === playerName;

    if (msg.type === 'system') {
      div.className = 'chat-msg system';
      div.innerHTML = `<div class="chat-bubble">${escapeHtml(msg.text)}</div>`;
    } else {
      div.className = `chat-msg ${isMine ? 'mine' : 'theirs'}`;
      const avatarPrefix = msg.avatar ? `${escapeHtml(msg.avatar)} ` : '';
      div.innerHTML = `
        <div class="chat-bubble">
          ${!isMine ? `<strong style="display:block; font-size:11px; color:${escapeHtml(msg.color || '#38bdf8')}; margin-bottom:2px;">${avatarPrefix}${escapeHtml(msg.sender)}</strong>` : ''}
          ${escapeHtml(msg.text)}
        </div>
        <div class="chat-meta">${msg.time || ''}</div>
      `;
    }

    chatList.appendChild(div);
    chatList.scrollTop = chatList.scrollHeight;

    if (playSound && !isMine && msg.type !== 'system') {
      playRetroBlip(580, 'sine', 0.08);
      setTimeout(() => playRetroBlip(880, 'sine', 0.1), 80);
    }
  }

  function escapeHtml(text) {
    const p = document.createElement('p');
    p.textContent = text || '';
    return p.innerHTML;
  }

  function getEmulatorFileInput() {
    return document.querySelector('#root input[type="file"]');
  }

  let standbySelectedAvatar = playerAvatar;

  function applyStandbyProfileIfPresent() {
    const standbyNameEl = document.getElementById('standby-name-input');
    if (standbyNameEl) {
      const val = standbyNameEl.value.trim();
      if (val) {
        playerName = val.slice(0, 18);
        localStorage.setItem('gb_player_name', playerName);
      }
    }
    if (standbySelectedAvatar) {
      playerAvatar = standbySelectedAvatar;
      const foundPreset = AVATAR_POOL.find(p => p.avatar === playerAvatar);
      if (foundPreset) playerColor = foundPreset.color;
      localStorage.setItem('gb_player_avatar', playerAvatar);
      localStorage.setItem('gb_player_color', playerColor);
    }
    updateHeaderProfileUI();
    sendPartyUpdate();
  }

  function showGameBoyScreen() {
    const gbShell = document.querySelector('#root div[class*="_content_"]');
    if (gbShell && gbShell.style.display === 'none') {
      const closeBtn = Array.from(document.querySelectorAll('#root button')).find(
        b => b.textContent && b.textContent.includes('Close settings')
      );
      if (closeBtn) closeBtn.click();
    }
  }

  async function ensureEmulatorStarted() {
    applyStandbyProfileIfPresent();
    if (getEmulatorFileInput()) return true;

    const eggBtn = document.querySelector('#root button[class*="startButton"]') || document.querySelector('button[class*="startButton"]');
    if (eggBtn) {
      eggBtn.click();
    }

    for (let i = 0; i < 100; i++) {
      const inp = getEmulatorFileInput();
      if (inp) {
        const standby = document.getElementById('start-game-overlay');
        if (standby) standby.remove();
        return true;
      }
      await new Promise(r => setTimeout(r, 45));
    }
    return !!getEmulatorFileInput();
  }

  async function feedRomToEmulator(arrayBuffer, fileName) {
    await ensureEmulatorStarted();
    const fileInput = getEmulatorFileInput();
    if (fileInput) {
      const file = new File([arrayBuffer], fileName, { type: 'application/octet-stream' });
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      isGameInitialized = true;
      hasAttemptedRomAutoRestore = true;

      const standby = document.getElementById('start-game-overlay');
      if (standby) standby.remove();

      setTimeout(() => {
        showGameBoyScreen();
        connectDirectLinkCable(false);
        sendPartyUpdate();
      }, 250);
      return true;
    }
    return false;
  }

  function copyInviteLink() {
    const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(currentRoom)}`;
    navigator.clipboard.writeText(inviteUrl).then(() => {
      playRetroBlip(700, 'triangle', 0.08);
      showToast(`📋 Einladungslink kopiert! (Code: ${currentRoom})`);
    });
  }

  function wireEvents() {
    // Modal close buttons & backdrop click
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
      btn.onclick = () => {
        const id = btn.getAttribute('data-close-modal');
        const m = document.getElementById(id);
        if (m) m.classList.remove('open');
      };
    });

    document.querySelectorAll('.party-modal-backdrop').forEach(backdrop => {
      backdrop.onclick = (e) => {
        if (e.target === backdrop) backdrop.classList.remove('open');
      };
    });

    // Header Room Pill actions
    const codeBox = document.getElementById('header-room-code-box');
    if (codeBox) codeBox.onclick = copyInviteLink;

    const pillCopy = document.getElementById('pill-copy-btn');
    if (pillCopy) pillCopy.onclick = copyInviteLink;

    const copyBtn = document.getElementById('btn-copy-invite');
    if (copyBtn) copyBtn.onclick = copyInviteLink;

    const pillQr = document.getElementById('pill-qr-btn');
    if (pillQr) pillQr.onclick = openQrModal;

    const qrCopyBtn = document.getElementById('party-qr-copy-btn');
    if (qrCopyBtn) qrCopyBtn.onclick = copyInviteLink;

    const pillSwitch = document.getElementById('pill-switch-room-btn');
    if (pillSwitch) pillSwitch.onclick = openRoomModal;

    const openRoomBtn = document.getElementById('btn-open-room-modal');
    if (openRoomBtn) openRoomBtn.onclick = openRoomModal;

    const pillNewRoom = document.getElementById('pill-new-room-btn');
    if (pillNewRoom) {
      pillNewRoom.onclick = () => {
        const nextCode = generateRoomCode(4);
        playRetroBlip(620, 'triangle', 0.08);
        switchRoom(nextCode);
      };
    }

    // Room Modal actions
    const roomJoinBtn = document.getElementById('party-room-join-btn');
    const roomInput = document.getElementById('party-room-input');
    const doJoinRoom = () => {
      if (!roomInput) return;
      const code = normalizeRoomCode(roomInput.value);
      if (!code) {
        alert('Bitte gib einen gültigen Raum-Code ein!');
        return;
      }
      document.getElementById('party-room-modal')?.classList.remove('open');
      switchRoom(code);
    };
    if (roomJoinBtn) roomJoinBtn.onclick = doJoinRoom;
    if (roomInput) {
      roomInput.onkeydown = (e) => {
        if (e.key === 'Enter') doJoinRoom();
      };
    }

    const roomRandomBtn = document.getElementById('party-room-random-btn');
    if (roomRandomBtn) {
      roomRandomBtn.onclick = () => {
        document.getElementById('party-room-modal')?.classList.remove('open');
        switchRoom(generateRoomCode(4));
      };
    }

    // Profile Modal actions
    const userBadge = document.getElementById('header-user-badge');
    if (userBadge) userBadge.onclick = openProfileModal;

    const profileSaveBtn = document.getElementById('party-profile-save-btn');
    if (profileSaveBtn) {
      profileSaveBtn.onclick = () => {
        const nameEl = document.getElementById('party-profile-name-input');
        const newName = (nameEl && nameEl.value.trim()) ? nameEl.value.trim().slice(0, 18) : playerName;
        playerName = newName;
        playerAvatar = selectedTempAvatar || playerAvatar;
        const foundPreset = AVATAR_POOL.find(p => p.avatar === playerAvatar);
        if (foundPreset) playerColor = foundPreset.color;

        localStorage.setItem('gb_player_name', playerName);
        localStorage.setItem('gb_player_avatar', playerAvatar);
        localStorage.setItem('gb_player_color', playerColor);

        document.getElementById('party-profile-modal')?.classList.remove('open');
        updateHeaderProfileUI();
        sendPartyUpdate();
        showToast(`Profil gespeichert: ${playerAvatar} ${playerName}`);
      };
    }

    // Link-Cable Manual Sync button
    const reconnectLinkBtn = document.getElementById('btn-reconnect-link');
    if (reconnectLinkBtn) {
      reconnectLinkBtn.onclick = () => {
        playRetroBlip(540, 'triangle', 0.08);
        connectDirectLinkCable(true);
        showToast('🔄 Link-Kabel wird synchronisiert...');
      };
    }

    // Settings Toggle button
    const settingsBtn = document.getElementById('btn-open-settings');
    if (settingsBtn) {
      settingsBtn.onclick = () => {
        const reactSettingsBtn = document.querySelector('button[class*="settingsButton"]');
        if (reactSettingsBtn) {
          reactSettingsBtn.click();
          playRetroBlip(520, 'square', 0.05);
        } else {
          const closeBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && b.textContent.includes('Close settings'));
          if (closeBtn) closeBtn.click();
        }
        setTimeout(refreshSaveManagerList, 300);
      };
    }

    // Force save flush
    const syncBtn = document.getElementById('btn-force-save-sync');
    if (syncBtn) {
      syncBtn.onclick = async () => {
        syncBtn.disabled = true;
        syncBtn.textContent = '⏳ Sichern...';
        await forceSaveFlush();
        playRetroBlip(880, 'triangle', 0.1);
        await refreshSaveManagerList();
        syncBtn.textContent = '✅ Gesichert!';
        setTimeout(() => {
          syncBtn.textContent = '🔄 Emulator sichern (Sync)';
          syncBtn.disabled = false;
        }, 1200);
      };
    }

    // Load pre-configured starter save
    const demoBtn = document.getElementById('btn-load-demo-save');
    if (demoBtn) {
      demoBtn.onclick = async () => {
        try {
          const resp = await fetch('/api/roms/pokemon_rot.sav');
          if (!resp.ok) throw new Error('Starter-Spielstand konnte nicht geladen werden');
          const buf = new Uint8Array(await resp.arrayBuffer());
          const db = await openGebehDb();
          if (!db) throw new Error('IndexedDB nicht erreichbar');
          const tx = db.transaction('saves', 'readwrite');
          tx.objectStore('saves').put(buf, 'POKEMON RED');
          tx.oncomplete = () => {
            alert('⭐ Starter-Spielstand für "Pokémon Rot" erfolgreich aktiviert!\n\nTrainer: ROT\nStarter: Glumanda\nGröße: 32.768 Bytes (SRAM)\n\nDu kannst ihn jetzt mit "⬇️ .sav" herunterladen oder direkt im Spiel weiterspielen!');
            playRetroBlip(880, 'square', 0.15);
            refreshSaveManagerList();
          };
        } catch (e) {
          alert('Fehler: ' + e.message);
        }
      };
    }

    // Smart Import .sav file
    const importInput = document.getElementById('input-import-sav-file');
    if (importInput) {
      importInput.onchange = async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          let buffer = new Uint8Array(await file.arrayBuffer());
          if (buffer.length === 32812) {
            buffer = buffer.slice(0, 32768);
          } else if (buffer.length < 32768) {
            const padded = new Uint8Array(32768);
            padded.set(buffer);
            buffer = padded;
          }

          const info = inspectSaveBytes(buffer);
          let targetTitle = (info && info.title) ? info.title : null;
          if (!targetTitle) {
            const titles = await getGebehSaveTitles();
            const defaultTitle = titles[0] || (currentRomName && currentRomName.toUpperCase().replace(/\.[A-Z0-9]+$/, '')) || 'POKEMON RED';
            targetTitle = prompt('Für welches Spiel soll der Spielstand geladen werden? (z.B. POKEMON RED, POKEMON_GLDAAUD, TETRIS)', defaultTitle);
          }

          if (targetTitle) {
            targetTitle = targetTitle.trim().toUpperCase();
            await importSave(targetTitle, file);
          }
        } catch (err) {
          alert('Fehler beim Importieren: ' + err.message);
        }
        importInput.value = '';
      };
    }

    // Player name input in chat bar
    const nameInput = document.getElementById('player-name-input');
    if (nameInput) {
      nameInput.onchange = () => {
        playerName = nameInput.value.trim() || 'Spieler';
        localStorage.setItem('gb_player_name', playerName);
        updateHeaderProfileUI();
        sendPartyUpdate();
      };
    }

    // Chat send
    const sendBtn = document.getElementById('chat-send-btn');
    const chatInput = document.getElementById('chat-input');

    const sendMsg = () => {
      const text = chatInput.value.trim();
      if (!text) return;
      if (!chatWs || chatWs.readyState !== WebSocket.OPEN) {
        connectChat(currentRoom, true);
        return;
      }
      chatWs.send(JSON.stringify({
        type: 'chat',
        text,
        sender: playerName,
        avatar: playerAvatar,
        color: playerColor
      }));
      chatInput.value = '';
      playRetroBlip(440, 'square', 0.04);
    };

    if (sendBtn) sendBtn.onclick = sendMsg;
    if (chatInput) {
      chatInput.onkeydown = (e) => {
        if (e.key === 'Enter') sendMsg();
      };
    }

    // Quick reactions
    document.querySelectorAll('.reaction-btn').forEach(btn => {
      btn.onclick = () => {
        const text = btn.getAttribute('data-msg');
        if (chatWs && chatWs.readyState === WebSocket.OPEN) {
          chatWs.send(JSON.stringify({
            type: 'chat',
            text,
            sender: playerName,
            avatar: playerAvatar,
            color: playerColor
          }));
          playRetroBlip(600, 'square', 0.05);
        } else if (chatInput) {
          chatInput.value = text;
          chatInput.focus();
        }
      };
    });

    // Capture manual file input in React emulator (strictly inside #root)
    document.addEventListener('change', async (e) => {
      if (e.target && e.target.type === 'file' && e.target.files && e.target.files[0] && e.target.closest('#root')) {
        const file = e.target.files[0];
        try {
          const buffer = await file.arrayBuffer();
          await saveSessionRom(file.name, buffer);
          isGameInitialized = true;
          connectDirectLinkCable(false);
        } catch (err) {}
      }
    }, true);

    // Load ROMs list into sidebar & wire Party Launch button
    fetch('/api/roms')
      .then(res => res.json())
      .then(roms => {
        const select = document.getElementById('sidebar-rom-select');
        if (select && Array.isArray(roms)) {
          roms.forEach((rom, idx) => {
            const opt = document.createElement('option');
            opt.value = rom;
            opt.textContent = rom;
            if (currentRomName === rom || (!currentRomName && idx === 0)) {
              opt.selected = true;
            }
            select.appendChild(opt);
          });

          const standbyBadge = document.getElementById('standby-rom-badge');
          if (standbyBadge && !currentRomName && roms.length > 0) {
            standbyBadge.innerHTML = `🎮 Bereit: <strong>${escapeHtml(roms[0])}</strong>`;
          }

          select.onchange = async () => {
            const val = select.value;
            if (!val) return;
            await loadServerRomByName(val, true);
            if (chatWs && chatWs.readyState === WebSocket.OPEN) {
              chatWs.send(JSON.stringify({ type: 'SELECT_ROM', rom: val }));
            }
          };
        }
      })
      .catch(() => {});

    const partyLaunchBtn = document.getElementById('btn-party-launch-rom');
    if (partyLaunchBtn) {
      partyLaunchBtn.onclick = async () => {
        const select = document.getElementById('sidebar-rom-select');
        const chosenRom = (select && select.value) || currentRomName;
        if (!chosenRom) {
          alert('Bitte wähle zuerst ein Spiel im Dropdown-Menü aus!');
          return;
        }
        await loadServerRomByName(chosenRom, true);
        if (partyState.isHost && chatWs && chatWs.readyState === WebSocket.OPEN) {
          chatWs.send(JSON.stringify({
            type: 'PARTY_LAUNCH_ROM',
            rom: chosenRom,
            initiatedBy: `${playerAvatar} ${playerName}`
          }));
        }
      };
    }
  }

  let hasAttemptedRomAutoRestore = false;
  let lastAnnouncedWorkletReady = false;
  let isCreatingStandbyOverlay = false;

  const STANDBY_CHARS = ['🐶', '🦊', '🐱', '🐼', '🐸', '🦁', '🐧', '🦄', '🐻', '👾', '⚡', '🔥'];

  async function syncLoop() {
    const eggButton = document.querySelector('#root button[class*="startButton"]') || document.querySelector('button[class*="startButton"]');
    const emuFileInput = getEmulatorFileInput();
    let overlay = document.getElementById('start-game-overlay');

    if (window.gbTetrisArena && window.gbTetrisArena.isVisible) {
      if (overlay) overlay.style.display = 'none';
      const rootEl = document.getElementById('root');
      if (rootEl) rootEl.style.display = 'none';
      updateLinkCableUI();
      return;
    }

    // 1. Render authentic Standby Game Boy DMG Shell with Character & Name Selection inside #left-console-col
    if (eggButton && !overlay && !isCreatingStandbyOverlay) {
      const leftCol = document.getElementById('left-console-col');
      if (leftCol) {
        isCreatingStandbyOverlay = true;
        const cachedRom = await getSessionRom();
        const selectEl = document.getElementById('sidebar-rom-select');
        const readyRomName = (cachedRom && cachedRom.name) || currentRomName || (selectEl && selectEl.value) || null;

        if (!document.getElementById('start-game-overlay')) {
          overlay = document.createElement('div');
          overlay.id = 'start-game-overlay';
          overlay.className = 'standby-gb-shell';

          standbySelectedAvatar = playerAvatar;
          const charButtonsHtml = STANDBY_CHARS.map(emoji => `
            <button type="button" class="standby-char-btn ${emoji === standbySelectedAvatar ? 'selected' : ''}" data-char="${emoji}" title="Charakter ${emoji} wählen">${emoji}</button>
          `).join('');

          overlay.innerHTML = `
            <div class="standby-gb-bezel">
              <div class="standby-gb-lcd">
                <div class="standby-gb-title">👾 SPIELER & START</div>

                <div>
                  <label class="standby-field-label" for="standby-name-input">Dein Spielername:</label>
                  <input type="text" class="standby-name-input" id="standby-name-input" maxlength="18" value="${escapeHtml(playerName)}" placeholder="Name eingeben...">

                  <span class="standby-field-label">Wähle deinen Charakter:</span>
                  <div class="standby-char-grid" id="standby-char-grid">
                    ${charButtonsHtml}
                  </div>
                </div>

                <div>
                  <div class="standby-gb-sub" id="standby-rom-badge">
                    ${readyRomName ? `💾 Bereit: <strong>${escapeHtml(readyRomName)}</strong>` : '🎮 Wähle ein Spiel & starte'}
                  </div>
                  <button type="button" class="start-arcade-btn" id="start-arcade-trigger">▶ START GAME BOY</button>
                </div>
              </div>
            </div>
            <div class="standby-controls-mock">
              <div class="standby-dpad"></div>
              <div class="standby-ab"><span></span><span></span></div>
            </div>
          `;

          leftCol.prepend(overlay);

          // Wire character selection buttons inside the Game Boy LCD
          overlay.querySelectorAll('.standby-char-btn').forEach(btn => {
            btn.onclick = (e) => {
              e.stopPropagation();
              overlay.querySelectorAll('.standby-char-btn').forEach(b => b.classList.remove('selected'));
              btn.classList.add('selected');
              standbySelectedAvatar = btn.getAttribute('data-char');
              playRetroBlip(620, 'square', 0.05);
              applyStandbyProfileIfPresent();
            };
          });

          const nameInp = document.getElementById('standby-name-input');
          if (nameInp) {
            nameInp.onclick = (e) => e.stopPropagation();
            nameInp.oninput = () => applyStandbyProfileIfPresent();
            nameInp.onkeydown = (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('start-arcade-trigger')?.click();
              }
            };
          }

          const triggerStart = async (e) => {
            if (e) e.stopPropagation();
            const btn = document.getElementById('start-arcade-trigger');
            if (btn) {
              btn.disabled = true;
              btn.textContent = '⏳ STARTE...';
            }
            playRetroBlip(440, 'triangle', 0.09);
            setTimeout(() => playRetroBlip(880, 'triangle', 0.14), 90);

            await ensureEmulatorStarted();

            const cached = await getSessionRom();
            if (cached && cached.buffer) {
              hasAttemptedRomAutoRestore = true;
              await feedRomToEmulator(cached.buffer, cached.name);
              showToast(`🎮 Willkommen ${playerAvatar} ${playerName}! (${cached.name})`);
            } else {
              const sel = document.getElementById('sidebar-rom-select');
              const fallbackRom = (sel && sel.value) || currentRomName;
              if (fallbackRom) {
                hasAttemptedRomAutoRestore = true;
                await loadServerRomByName(fallbackRom, false);
                showToast(`🎮 Willkommen ${playerAvatar} ${playerName}! (${fallbackRom})`);
              } else {
                showGameBoyScreen();
                showToast(`🎮 Willkommen ${playerAvatar} ${playerName}!`);
              }
            }
          };

          const startBtn = document.getElementById('start-arcade-trigger');
          if (startBtn) startBtn.onclick = triggerStart;
        }
        isCreatingStandbyOverlay = false;
      }
    } else if (!eggButton && emuFileInput && overlay) {
      overlay.remove();
    }

    // 2. Auto-restore cached ROM & auto-connect Link-Cable once AudioWorklet + #root input[type="file"] are ready
    if (!eggButton && window.__gbWorkletNode && window.__gbWorkletNode.port) {
      if (!lastAnnouncedWorkletReady) {
        lastAnnouncedWorkletReady = true;
        connectDirectLinkCable(false);
        sendPartyUpdate();
        updateLinkCableUI();
      }

      if (!hasAttemptedRomAutoRestore && emuFileInput) {
        hasAttemptedRomAutoRestore = true;
        const cached = await getSessionRom();
        if (cached && cached.buffer) {
          await feedRomToEmulator(cached.buffer, cached.name);
          showToast(`💾 "${cached.name}" automatisch wiederhergestellt`);
        } else {
          const sel = document.getElementById('sidebar-rom-select');
          if (sel && sel.value) {
            await loadServerRomByName(sel.value, false);
          } else {
            showGameBoyScreen();
          }
        }
      }
    }

    updateLinkCableUI();
  }

  // Heartbeat every 10s for Party presence
  setInterval(() => {
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify({ type: 'HEARTBEAT', playerId }));
    }
    if (linkWs && linkWs.readyState === WebSocket.OPEN) {
      linkWs.send(JSON.stringify({ type: 'PING' }));
    }
  }, 10000);

  window.addEventListener('DOMContentLoaded', () => {
    initLayout();
    syncLoop();
    setInterval(syncLoop, 500);
  });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initLayout();
    syncLoop();
    setInterval(syncLoop, 500);
  }
})();
