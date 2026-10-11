import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DIST_DIR = path.join(__dirname, 'dist');
const ROMS_DIR = path.join(__dirname, 'roms');

if (!fs.existsSync(ROMS_DIR)) {
  fs.mkdirSync(ROMS_DIR, { recursive: true });
}

// Alphanumeric alphabet: lowercase only, no 'o' (to avoid confusion with zero / 0)
// 25 lowercase letters + 10 digits = 35 chars
const CODE_ALPHABET = 'abcdefghijklmnpqrstuvwxyz0123456789';

function generateRoomCode(length = 4) {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
  }
  return result;
}

function normalizeRoomCode(raw) {
  return (raw || '').trim().toLowerCase().replace(/o/g, '0');
}

// Retro CPU Bot Pool for filling odd player counts or full 4/8 brackets
const CPU_BOT_POOL = [
  { id: 'cpu_rob', name: 'R.O.B. 89 (CPU)', avatar: '🤖', color: '#38bdf8' },
  { id: 'cpu_dmg', name: 'DMG-01 Bot (CPU)', avatar: '👾', color: '#a855f7' },
  { id: 'cpu_rex', name: 'Tetromino Rex (CPU)', avatar: '🦖', color: '#f97316' },
  { id: 'cpu_alexey', name: 'Alexey AI (CPU)', avatar: '🧠', color: '#ec4899' },
  { id: 'cpu_pixel', name: 'Pixel Byte (CPU)', avatar: '⚡', color: '#eab308' },
  { id: 'cpu_link', name: 'Link-Master (CPU)', avatar: '🔌', color: '#10b981' },
  { id: 'cpu_koro', name: 'Korobeiniki (CPU)', avatar: '🎵', color: '#f43f5e' },
  { id: 'cpu_gb', name: 'GameBoy CPU-8', avatar: '🕹️', color: '#6366f1' }
];

// Legacy game rooms map: roomCodeLower -> { id, host, guest, createdAt }
const gameRooms = new Map();

// Direct Auto-Link-Cable rooms map: channelKey -> { id, baseRoom, matchId, clients: Map<ws, { playerId, joinedAt }>, createdAt }
const directLinkRooms = new Map();

// Active Party-Hub, Chat & Tournament rooms map:
// roomCodeLower -> { code, clients: Set<ws>, players: Map<playerId, playerObj>, socketToPlayerId: Map<ws, playerId>, hostId, selectedRom, history: Array<msg>, tournament: Object }
const chatRooms = new Map();

// MIME Types
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.gb': 'application/octet-stream',
  '.gbc': 'application/octet-stream',
  '.sav': 'application/octet-stream',
};

// HTTP Server
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname;
  try { pathname = decodeURIComponent(parsedUrl.pathname); } catch (e) { pathname = parsedUrl.pathname; }

  // Healthcheck endpoint
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      partyRooms: chatRooms.size,
      linkRooms: directLinkRooms.size + gameRooms.size,
      uptime: process.uptime()
    }));
    return;
  }

  // API: List ROMs (sort tetris.gb first for tournament fork)
  if (pathname === '/api/roms' && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      const files = fs.readdirSync(ROMS_DIR).filter(f => {
        const ext = path.extname(f).toLowerCase();
        return ext === '.gb' || ext === '.gbc';
      }).sort((a, b) => {
        const aTetris = a.toLowerCase().includes('tetris') ? 0 : 1;
        const bTetris = b.toLowerCase().includes('tetris') ? 0 : 1;
        if (aTetris !== bTetris) return aTetris - bTetris;
        return a.localeCompare(b);
      });
      const data = JSON.stringify(files);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Cache-Control': 'no-cache'
      });
      if (req.method === 'GET') res.end(data);
      else res.end();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: Download/Fetch ROM or Save
  if (pathname.startsWith('/api/roms/') && (req.method === 'GET' || req.method === 'HEAD')) {
    const filename = path.basename(pathname);
    const filepath = path.join(ROMS_DIR, filename);
    if (fs.existsSync(filepath)) {
      const stat = fs.statSync(filepath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      if (req.method === 'GET') {
        fs.createReadStream(filepath).pipe(res);
      } else {
        res.end();
      }
      return;
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('ROM not found');
      return;
    }
  }

  // Static files in dist/
  let filePath = path.join(DIST_DIR, pathname === '/' ? 'index.html' : pathname);
  filePath = path.normalize(filePath);

  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  const headers = { 'Content-Type': contentType };
  if (pathname.startsWith('/assets/') && !parsedUrl.searchParams.has('v')) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  } else {
    headers['Cache-Control'] = 'no-cache';
  }

  const stat = fs.statSync(filePath);
  headers['Content-Length'] = stat.size;

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
  } else {
    fs.createReadStream(filePath).pipe(res);
  }
});

// WebSocket Server for Game Boy Serial Link Cable (/ws)
const wssGame = new WebSocketServer({ noServer: true });

// WebSocket Server for Party-Hub, Live Chat & Tournament (/chat)
const wssChat = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const parsedUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (parsedUrl.pathname === '/ws') {
    wssGame.handleUpgrade(request, socket, head, (ws) => {
      wssGame.emit('connection', ws, request);
    });
  } else if (parsedUrl.pathname === '/chat' || parsedUrl.pathname === '/party-ws') {
    wssChat.handleUpgrade(request, socket, head, (ws) => {
      wssChat.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Helper: Sync Direct Link-Cable Room status (supports base room or tournament match sub-channels)
function syncDirectLinkRoom(channelKey) {
  const room = directLinkRooms.get(channelKey);
  if (!room) return;

  for (const [clientWs] of room.clients.entries()) {
    if (clientWs.readyState !== WebSocket.OPEN) {
      room.clients.delete(clientWs);
    }
  }

  if (room.clients.size === 0) {
    directLinkRooms.delete(channelKey);
    if (!room.matchId) {
      updatePartyLinkState(room.baseRoom, false, 0);
    }
    return;
  }

  const activeSockets = Array.from(room.clients.keys());
  const isPaired = activeSockets.length >= 2;

  activeSockets.forEach((clientWs, idx) => {
    try {
      clientWs.send(JSON.stringify({
        type: isPaired ? 'LINK_PAIRED' : 'LINK_WAITING',
        room: room.baseRoom,
        matchId: room.matchId || null,
        channel: channelKey,
        role: idx === 0 ? 'host' : 'guest',
        peers: activeSockets.length
      }));
    } catch (e) {}
  });

  if (!room.matchId) {
    updatePartyLinkState(room.baseRoom, isPaired, activeSockets.length);
  }
}

function updatePartyLinkState(roomKey, isPaired, connectedCount) {
  const chatRoom = chatRooms.get(roomKey);
  if (!chatRoom) return;
  chatRoom.linkPaired = isPaired;
  chatRoom.linkCount = connectedCount;
  broadcastRoster(roomKey);
}

// --- Game Boy Netplay Handlers (/ws) ---
wssGame.on('connection', (ws, request) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const parsedUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const roomParam = parsedUrl.searchParams.get('room');
  const matchParam = parsedUrl.searchParams.get('matchId') || '';
  const isDirect = parsedUrl.searchParams.get('direct') === '1';
  const playerId = parsedUrl.searchParams.get('playerId') || ('anon_' + Math.random().toString(36).slice(2, 7));

  if (isDirect && roomParam) {
    const baseRoom = normalizeRoomCode(roomParam);
    const cleanMatch = matchParam.replace(/[^a-zA-Z0-9_-]/g, '');
    const channelKey = cleanMatch ? `${baseRoom}__${cleanMatch}` : baseRoom;

    let room = directLinkRooms.get(channelKey);
    if (!room) {
      room = {
        id: channelKey,
        baseRoom,
        matchId: cleanMatch || null,
        clients: new Map(),
        createdAt: Date.now()
      };
      directLinkRooms.set(channelKey, room);
    }

    for (const [oldWs, meta] of room.clients.entries()) {
      if (meta.playerId === playerId || oldWs.readyState !== WebSocket.OPEN) {
        room.clients.delete(oldWs);
        try { oldWs.close(1000, 'Replaced by new session'); } catch (e) {}
      }
    }

    if (room.clients.size >= 2) {
      ws.send(JSON.stringify({ type: 'LINK_FULL', room: baseRoom, matchId: cleanMatch || null }));
      ws.close(4003, 'Link cable already has 2 players');
      return;
    }

    room.clients.set(ws, { playerId, joinedAt: Date.now() });
    console.log(`[Direct Link-Cable] Player "${playerId}" connected in channel "${channelKey}" (${room.clients.size}/2)`);

    syncDirectLinkRoom(channelKey);

    ws.on('message', (message, isBinary) => {
      if (isBinary) {
        for (const [peerWs] of room.clients.entries()) {
          if (peerWs !== ws && peerWs.readyState === WebSocket.OPEN) {
            peerWs.send(message, { binary: true });
          }
        }
      } else {
        try {
          const data = JSON.parse(message.toString());
          if (data.type === 'PING' && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'PONG' }));
          }
        } catch (e) {}
      }
    });

    ws.on('close', () => {
      room.clients.delete(ws);
      console.log(`[Direct Link-Cable] Player "${playerId}" disconnected from channel "${channelKey}"`);
      syncDirectLinkRoom(channelKey);
    });

    ws.on('error', () => {
      room.clients.delete(ws);
      syncDirectLinkRoom(channelKey);
    });

    return;
  }

  // --- LEGACY gebeh UI WebSocket Mode ---
  if (!roomParam) {
    let roomId = generateRoomCode(4);
    while (gameRooms.has(roomId)) {
      roomId = generateRoomCode(4);
    }

    const roomKey = roomId;
    const room = {
      id: roomId,
      host: ws,
      guest: null,
      createdAt: Date.now()
    };
    gameRooms.set(roomKey, room);
    ws.send(roomId);

    ws.on('message', (message, isBinary) => {
      if (room.guest && room.guest.readyState === WebSocket.OPEN) {
        room.guest.send(message, { binary: isBinary });
      }
    });

    ws.on('close', () => {
      if (room.guest && room.guest.readyState === WebSocket.OPEN) {
        room.guest.close(1000, 'Host disconnected');
      }
      gameRooms.delete(roomKey);
    });

    ws.on('error', () => {});
  } else {
    let roomKey = normalizeRoomCode(roomParam);
    let room = gameRooms.get(roomKey);

    if (!room) {
      ws.close(4004, 'Room not found');
      return;
    }

    if (room.guest) {
      ws.close(4003, 'Room is full');
      return;
    }

    room.guest = ws;
    try {
      room.host.send(Buffer.alloc(0), { binary: true });
    } catch (e) {}

    ws.on('message', (message, isBinary) => {
      if (room.host && room.host.readyState === WebSocket.OPEN) {
        room.host.send(message, { binary: isBinary });
      }
    });

    ws.on('close', () => {
      if (room.host && room.host.readyState === WebSocket.OPEN) {
        room.host.close(1000, 'Guest disconnected');
      }
      gameRooms.delete(roomKey);
    });

    ws.on('error', () => {});
  }
});

// ============================================================================
// 🏆 TETRIS TOURNAMENT ENGINE (UP TO 8 PLAYERS + AUTO CPU OPPONENT FILLING)
// ============================================================================

function createDefaultTournamentState() {
  return {
    id: 't_' + Date.now().toString(36),
    status: 'lobby', // 'lobby' | 'active' | 'completed'
    mode: 'builtin', // 'builtin' (Integriertes DMG Tetris) | 'emulator' (tetris.gb via Link-Kabel)
    fillMode: 'odd_plus_one', // 'odd_plus_one' (Ungerade Anzahl mit +1 CPU auffüllen) | 'bracket_full' (Voller 4er/8er Baum mit CPUs)
    cpuDifficulty: 'normal', // 'easy' | 'normal' | 'hard'
    bestOf: 3, // 1 oder 3 (Best-of-3 = 2 Herzen zum Matchsieg wie beim Original Game Boy Tetris)
    customCpus: [], // Manuell hinzugefügte CPU-Bots in der Lobby
    participants: [], // Aktive Turnierteilnehmer (max 8)
    currentRound: 0,
    rounds: [], // Array of Arrays of Matches
    champion: null,
    startedAt: null,
    completedAt: null
  };
}

function getNextCpuBot(usedIds, difficulty = 'normal', indexHint = 0) {
  for (let i = 0; i < CPU_BOT_POOL.length; i++) {
    const candidate = CPU_BOT_POOL[(indexHint + i) % CPU_BOT_POOL.length];
    if (!usedIds.has(candidate.id)) {
      usedIds.add(candidate.id);
      return {
        id: candidate.id,
        name: candidate.name,
        avatar: candidate.avatar,
        color: candidate.color,
        isCpu: true,
        difficulty
      };
    }
  }
  const fallbackId = 'cpu_extra_' + Math.random().toString(36).slice(2, 6);
  usedIds.add(fallbackId);
  return {
    id: fallbackId,
    name: `CPU Bot #${usedIds.size}`,
    avatar: '🤖',
    color: '#38bdf8',
    isCpu: true,
    difficulty
  };
}

function getRoundTitle(matchCount, roundIndex) {
  if (matchCount === 1) return '🏆 Finale';
  if (matchCount === 2) return '⚡ Halbfinale';
  if (matchCount >= 3) return '🕹️ Viertelfinale';
  return `Runde ${roundIndex + 1}`;
}

/**
 * Pair participants so that human players are paired with CPU opponents first
 * (avoiding unnecessary CPU-vs-CPU matches when humans are available),
 * while preserving competitive seeding.
 */
function buildRoundMatches(roomKey, participants, roundIndex, bestOf) {
  const list = [...participants];
  const humans = list.filter(p => !p.isCpu);
  const cpus = list.filter(p => p.isCpu);

  const orderedPairs = [];
  // Pair humans vs CPUs or humans vs humans cleanly
  // If we have both humans and CPUs, interleave so CPUs face humans first
  const pool = [];
  while (humans.length > 0 || cpus.length > 0) {
    if (humans.length > 0) pool.push(humans.shift());
    if (cpus.length > 0 && humans.length < cpus.length) {
      pool.push(cpus.shift());
    } else if (humans.length > 0 && cpus.length === 0) {
      pool.push(humans.shift());
    } else if (cpus.length > 0) {
      pool.push(cpus.shift());
    }
  }

  const matchCount = Math.floor(pool.length / 2);
  const roundName = getRoundTitle(matchCount, roundIndex);
  const matches = [];

  for (let m = 0; m < matchCount; m++) {
    const p1 = pool[m * 2];
    const p2 = pool[m * 2 + 1];
    const matchId = `m_r${roundIndex}_${m}`;
    matches.push({
      id: matchId,
      roundIndex,
      matchIndex: m,
      roundName,
      p1,
      p2,
      wins1: 0,
      wins2: 0,
      score1: 0,
      score2: 0,
      lines1: 0,
      lines2: 0,
      bestOf,
      winsNeeded: Math.ceil(bestOf / 2),
      status: 'active', // 'active' | 'completed'
      winnerId: null,
      winner: null,
      seed: Math.floor(100000 + Math.random() * 900000),
      linkChannel: `${roomKey}__${matchId}`,
      startedAt: Date.now()
    });
  }

  return matches;
}

/**
 * Automatically simulate any CPU-vs-CPU match so the tournament never stalls
 */
function scheduleCpuVsCpuMatches(roomKey) {
  const chatRoom = chatRooms.get(roomKey);
  if (!chatRoom || !chatRoom.tournament || chatRoom.tournament.status !== 'active') return;

  const t = chatRoom.tournament;
  const currentMatches = t.rounds[t.currentRound] || [];

  currentMatches.forEach((match) => {
    if (match.status === 'active' && match.p1.isCpu && match.p2.isCpu && !match._simTimer) {
      let step = 0;
      match._simTimer = setInterval(() => {
        const roomNow = chatRooms.get(roomKey);
        if (!roomNow || !roomNow.tournament || roomNow.tournament.status !== 'active' || match.status !== 'active') {
          clearInterval(match._simTimer);
          match._simTimer = null;
          return;
        }
        step++;
        match.lines1 += Math.floor(2 + Math.random() * 5);
        match.lines2 += Math.floor(2 + Math.random() * 5);
        match.score1 = match.lines1 * 240;
        match.score2 = match.lines2 * 240;

        if (step >= 3) {
          clearInterval(match._simTimer);
          match._simTimer = null;
          const p1Wins = Math.random() >= 0.45;
          const winner = p1Wins ? match.p1 : match.p2;
          match.wins1 = p1Wins ? match.winsNeeded : Math.max(0, match.winsNeeded - 1);
          match.wins2 = p1Wins ? Math.max(0, match.winsNeeded - 1) : match.winsNeeded;
          match.status = 'completed';
          match.winnerId = winner.id;
          match.winner = winner;

          broadcastChat(roomKey, {
            type: 'system',
            text: `🤖 CPU-Duell beendet: ${winner.avatar} ${winner.name} besiegt ${p1Wins ? match.p2.name : match.p1.name} (${match.wins1}:${match.wins2})!`,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          });

          checkAndAdvanceTournamentRound(roomKey);
          broadcastTournamentState(roomKey);
        } else {
          broadcastTournamentState(roomKey);
        }
      }, 1500);
    }
  });
}

function checkAndAdvanceTournamentRound(roomKey) {
  const chatRoom = chatRooms.get(roomKey);
  if (!chatRoom || !chatRoom.tournament || chatRoom.tournament.status !== 'active') return;

  const t = chatRoom.tournament;
  const currentMatches = t.rounds[t.currentRound] || [];
  if (currentMatches.length === 0) return;

  const allCompleted = currentMatches.every(m => m.status === 'completed' && m.winner);
  if (!allCompleted) return;

  const winners = currentMatches.map(m => m.winner);

  // If only 1 winner remains, the tournament is complete!
  if (winners.length === 1) {
    const champion = winners[0];
    t.status = 'completed';
    t.champion = champion;
    t.completedAt = Date.now();

    broadcastChat(roomKey, {
      type: 'system',
      text: `🏆🎉 TURNIERSIEGER: ${champion.avatar} ${champion.name} hat das Tetris-Turnier gewonnen!`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    broadcastChat(roomKey, {
      type: 'TOURNAMENT_CHAMPION',
      champion,
      tournament: sanitizeTournamentForClient(t)
    });
    return;
  }

  // Otherwise, prepare the next round!
  // Check if winners count is odd (e.g., 6 initial players -> 3 Quarterfinal matches -> 3 Semifinal winners)
  // Fill with 1 CPU opponent so every Semifinal match is a clean 1v1!
  const nextParticipants = [...winners];
  if (nextParticipants.length % 2 === 1) {
    const usedIds = new Set(t.participants.map(p => p.id));
    nextParticipants.forEach(p => usedIds.add(p.id));
    const wildcardCpu = getNextCpuBot(usedIds, t.cpuDifficulty, t.currentRound + 3);
    wildcardCpu.name = `${wildcardCpu.name.replace(' (CPU)', '')} [Wildcard CPU]`;
    nextParticipants.push(wildcardCpu);

    broadcastChat(roomKey, {
      type: 'system',
      text: `🤖 Ungerade Anzahl in der nächsten Runde (${winners.length} Spieler) – ${wildcardCpu.avatar} ${wildcardCpu.name} rückt als CPU-Gegner nach!`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  }

  t.currentRound += 1;
  const nextMatches = buildRoundMatches(roomKey, nextParticipants, t.currentRound, t.bestOf);
  t.rounds.push(nextMatches);

  const roundLabel = nextMatches[0] ? nextMatches[0].roundName : `Runde ${t.currentRound + 1}`;
  broadcastChat(roomKey, {
    type: 'system',
    text: `🔥 ${roundLabel} gestartet! (${nextMatches.length} ${nextMatches.length === 1 ? 'Match' : 'Matches'})`,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  });

  broadcastChat(roomKey, {
    type: 'TOURNAMENT_ROUND_STARTED',
    roundIndex: t.currentRound,
    roundName: roundLabel,
    tournament: sanitizeTournamentForClient(t)
  });

  scheduleCpuVsCpuMatches(roomKey);
}

function sanitizeTournamentForClient(t) {
  if (!t) return null;
  return {
    id: t.id,
    status: t.status,
    mode: t.mode,
    fillMode: t.fillMode,
    cpuDifficulty: t.cpuDifficulty,
    bestOf: t.bestOf,
    customCpus: t.customCpus || [],
    participants: t.participants || [],
    currentRound: t.currentRound,
    rounds: (t.rounds || []).map(round =>
      round.map(m => ({
        id: m.id,
        roundIndex: m.roundIndex,
        matchIndex: m.matchIndex,
        roundName: m.roundName,
        p1: m.p1,
        p2: m.p2,
        wins1: m.wins1,
        wins2: m.wins2,
        score1: m.score1,
        score2: m.score2,
        lines1: m.lines1,
        lines2: m.lines2,
        bestOf: m.bestOf,
        winsNeeded: m.winsNeeded,
        status: m.status,
        winnerId: m.winnerId,
        winner: m.winner,
        seed: m.seed,
        linkChannel: m.linkChannel
      }))
    ),
    champion: t.champion,
    startedAt: t.startedAt,
    completedAt: t.completedAt
  };
}

function broadcastTournamentState(roomKey) {
  const chatRoom = chatRooms.get(roomKey);
  if (!chatRoom) return;
  broadcastChat(roomKey, {
    type: 'TOURNAMENT_SYNC',
    room: roomKey,
    tournament: sanitizeTournamentForClient(chatRoom.tournament)
  });
}

// --- Party-Hub & Live Chat Handlers (/chat) ---
function getOrCreateChatRoom(roomKey) {
  let chatRoom = chatRooms.get(roomKey);
  if (!chatRoom) {
    chatRoom = {
      code: roomKey,
      clients: new Set(),
      players: new Map(),
      socketToPlayerId: new Map(),
      hostId: null,
      selectedRom: null,
      linkPaired: false,
      linkCount: 0,
      history: [],
      tournament: createDefaultTournamentState()
    };
    chatRooms.set(roomKey, chatRoom);
  }
  return chatRoom;
}

function ensureRoomHost(chatRoom) {
  if (chatRoom.hostId && chatRoom.players.has(chatRoom.hostId)) {
    return chatRoom.hostId;
  }
  const sorted = Array.from(chatRoom.players.values()).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  chatRoom.hostId = sorted.length > 0 ? sorted[0].id : null;
  return chatRoom.hostId;
}

function broadcastRoster(roomKey) {
  const chatRoom = chatRooms.get(roomKey);
  if (!chatRoom) return;

  ensureRoomHost(chatRoom);
  const playerList = Array.from(chatRoom.players.values()).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  playerList.forEach(p => {
    p.isHost = (p.id === chatRoom.hostId);
  });

  broadcastChat(roomKey, {
    type: 'ROSTER_SYNC',
    room: roomKey,
    hostId: chatRoom.hostId,
    selectedRom: chatRoom.selectedRom,
    linkPaired: !!chatRoom.linkPaired,
    linkCount: chatRoom.linkCount || 0,
    players: playerList,
    tournament: sanitizeTournamentForClient(chatRoom.tournament)
  });
}

wssChat.on('connection', (ws, request) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const parsedUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const roomParam = parsedUrl.searchParams.get('room') || 'lobby';
  const nameParam = parsedUrl.searchParams.get('name') || 'Spieler';
  const avatarParam = parsedUrl.searchParams.get('avatar') || '🎮';
  const colorParam = parsedUrl.searchParams.get('color') || '#48c78e';
  const playerIdParam = parsedUrl.searchParams.get('playerId') || ('p_' + Math.random().toString(36).slice(2, 8));
  const roomKey = normalizeRoomCode(roomParam) || 'lobby';

  const chatRoom = getOrCreateChatRoom(roomKey);

  ws.roomKey = roomKey;
  ws.playerName = nameParam;
  ws.playerId = playerIdParam;
  chatRoom.clients.add(ws);

  if (chatRoom.history.length > 0) {
    ws.send(JSON.stringify({ type: 'history', messages: chatRoom.history }));
  }

  const isNewPlayer = !chatRoom.players.has(playerIdParam);
  const existing = chatRoom.players.get(playerIdParam);
  const playerObj = {
    id: playerIdParam,
    name: nameParam,
    avatar: avatarParam,
    color: colorParam,
    isHost: false,
    isReady: existing ? existing.isReady : true,
    rom: existing ? existing.rom : null,
    emulatorReady: existing ? existing.emulatorReady : false,
    joinedAt: existing ? existing.joinedAt : Date.now(),
    lastSeen: Date.now()
  };

  chatRoom.players.set(playerIdParam, playerObj);
  chatRoom.socketToPlayerId.set(ws, playerIdParam);
  ensureRoomHost(chatRoom);

  if (isNewPlayer) {
    const joinMsg = {
      type: 'system',
      text: `${avatarParam} ${nameParam} ist der Party beigetreten!`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    broadcastChat(roomKey, joinMsg);
  }

  broadcastRoster(roomKey);
  broadcastTournamentState(roomKey);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case 'JOIN':
        case 'UPDATE_USER': {
          const u = msg.user || {};
          const pid = u.id || ws.playerId;
          const prev = chatRoom.players.get(pid);
          const updated = {
            id: pid,
            name: (u.name || ws.playerName || 'Spieler').slice(0, 20),
            avatar: u.avatar || (prev && prev.avatar) || '🎮',
            color: u.color || (prev && prev.color) || '#48c78e',
            isHost: pid === chatRoom.hostId,
            isReady: u.isReady !== undefined ? !!u.isReady : (prev ? prev.isReady : true),
            rom: u.rom !== undefined ? u.rom : (prev ? prev.rom : null),
            emulatorReady: u.emulatorReady !== undefined ? !!u.emulatorReady : (prev ? prev.emulatorReady : false),
            joinedAt: prev ? prev.joinedAt : Date.now(),
            lastSeen: Date.now()
          };
          ws.playerId = pid;
          ws.playerName = updated.name;
          chatRoom.players.set(pid, updated);
          chatRoom.socketToPlayerId.set(ws, pid);
          if (updated.rom && pid === chatRoom.hostId) {
            chatRoom.selectedRom = updated.rom;
          }
          broadcastRoster(roomKey);
          break;
        }

        case 'HEARTBEAT': {
          const pid = msg.playerId || ws.playerId;
          const p = chatRoom.players.get(pid);
          if (p) p.lastSeen = Date.now();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'PONG' }));
          }
          break;
        }

        case 'READY_TOGGLE': {
          const pid = msg.playerId || ws.playerId;
          const p = chatRoom.players.get(pid);
          if (p) {
            p.isReady = msg.isReady !== undefined ? !!msg.isReady : !p.isReady;
            broadcastRoster(roomKey);
          }
          break;
        }

        case 'TRANSFER_HOST': {
          const senderId = chatRoom.socketToPlayerId.get(ws) || ws.playerId;
          if (senderId === chatRoom.hostId && msg.targetPlayerId && chatRoom.players.has(msg.targetPlayerId)) {
            chatRoom.hostId = msg.targetPlayerId;
            const newHost = chatRoom.players.get(msg.targetPlayerId);
            broadcastChat(roomKey, {
              type: 'HOST_TRANSFERRED',
              newHostId: msg.targetPlayerId,
              newHostName: newHost ? newHost.name : 'Mitspieler'
            });
            broadcastChat(roomKey, {
              type: 'system',
              text: `👑 ${newHost ? newHost.avatar + ' ' + newHost.name : 'Mitspieler'} ist jetzt Party-Host!`,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
            broadcastRoster(roomKey);
          }
          break;
        }

        case 'SELECT_ROM': {
          const senderId = chatRoom.socketToPlayerId.get(ws) || ws.playerId;
          const p = chatRoom.players.get(senderId);
          if (p) p.rom = msg.rom;
          if (senderId === chatRoom.hostId || !chatRoom.selectedRom) {
            chatRoom.selectedRom = msg.rom;
          }
          broadcastRoster(roomKey);
          break;
        }

        case 'PARTY_LAUNCH_ROM': {
          const senderId = chatRoom.socketToPlayerId.get(ws) || ws.playerId;
          const p = chatRoom.players.get(senderId);
          if (msg.rom) {
            chatRoom.selectedRom = msg.rom;
            broadcastChat(roomKey, {
              type: 'PARTY_LAUNCH_ROM',
              rom: msg.rom,
              initiatedBy: p ? `${p.avatar} ${p.name}` : ws.playerName
            });
            broadcastChat(roomKey, {
              type: 'system',
              text: `🚀 ${p ? p.avatar + ' ' + p.name : ws.playerName} startet "${msg.rom}" für die Party!`,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
            broadcastRoster(roomKey);
          }
          break;
        }

        // ====================================================================
        // 🏆 TOURNAMENT MESSAGES
        // ====================================================================

        case 'TOURNAMENT_CONFIG': {
          const t = chatRoom.tournament;
          if (t.status !== 'lobby') break;
          if (msg.mode === 'builtin' || msg.mode === 'emulator') t.mode = msg.mode;
          if (msg.fillMode === 'odd_plus_one' || msg.fillMode === 'bracket_full') t.fillMode = msg.fillMode;
          if (['easy', 'normal', 'hard'].includes(msg.cpuDifficulty)) {
            t.cpuDifficulty = msg.cpuDifficulty;
            t.customCpus.forEach(c => { c.difficulty = t.cpuDifficulty; });
          }
          if (msg.bestOf === 1 || msg.bestOf === 3) t.bestOf = msg.bestOf;
          broadcastTournamentState(roomKey);
          break;
        }

        case 'TOURNAMENT_ADD_CPU': {
          const t = chatRoom.tournament;
          if (t.status !== 'lobby') break;
          const humanCount = Math.min(8, chatRoom.players.size);
          if (humanCount + t.customCpus.length >= 8) break;
          const usedIds = new Set(t.customCpus.map(c => c.id));
          const bot = getNextCpuBot(usedIds, t.cpuDifficulty, t.customCpus.length);
          t.customCpus.push(bot);
          broadcastTournamentState(roomKey);
          break;
        }

        case 'TOURNAMENT_REMOVE_CPU': {
          const t = chatRoom.tournament;
          if (t.status !== 'lobby') break;
          if (msg.cpuId) {
            t.customCpus = t.customCpus.filter(c => c.id !== msg.cpuId);
          } else {
            t.customCpus.pop();
          }
          broadcastTournamentState(roomKey);
          break;
        }

        case 'TOURNAMENT_START': {
          const t = chatRoom.tournament;
          // Gather up to 8 human players sorted by join order
          const humans = Array.from(chatRoom.players.values())
            .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0))
            .slice(0, 8)
            .map(p => ({
              id: p.id,
              name: p.name,
              avatar: p.avatar || '🎮',
              color: p.color || '#48c78e',
              isCpu: false
            }));

          if (humans.length === 0) break;

          // Update config if passed in start message
          if (msg.mode === 'builtin' || msg.mode === 'emulator') t.mode = msg.mode;
          if (msg.fillMode === 'odd_plus_one' || msg.fillMode === 'bracket_full') t.fillMode = msg.fillMode;
          if (['easy', 'normal', 'hard'].includes(msg.cpuDifficulty)) t.cpuDifficulty = msg.cpuDifficulty;
          if (msg.bestOf === 1 || msg.bestOf === 3) t.bestOf = msg.bestOf;

          const usedIds = new Set(humans.map(h => h.id));
          const participants = [...humans];

          // Include manually added custom CPUs up to 8 total
          for (const customCpu of t.customCpus) {
            if (participants.length >= 8) break;
            usedIds.add(customCpu.id);
            participants.push({
              ...customCpu,
              isCpu: true,
              difficulty: t.cpuDifficulty
            });
          }

          // Determine target participant count (max 8)
          let targetCount = participants.length;
          if (t.fillMode === 'bracket_full') {
            if (targetCount <= 2) targetCount = Math.max(2, targetCount === 1 ? 4 : 2);
            else if (targetCount <= 4) targetCount = 4;
            else targetCount = 8;
          } else {
            // 'odd_plus_one': Always fill odd numbers with +1 CPU opponent (and 1 player -> 2)
            if (targetCount < 2) targetCount = 2;
            else if (targetCount % 2 === 1) targetCount += 1;
          }
          targetCount = Math.min(8, targetCount);

          let autoAddedCpuCount = 0;
          while (participants.length < targetCount) {
            const cpu = getNextCpuBot(usedIds, t.cpuDifficulty, participants.length);
            participants.push(cpu);
            autoAddedCpuCount++;
          }

          t.id = 't_' + Date.now().toString(36);
          t.status = 'active';
          t.participants = participants;
          t.currentRound = 0;
          t.champion = null;
          t.startedAt = Date.now();
          t.completedAt = null;

          const firstRoundMatches = buildRoundMatches(roomKey, participants, 0, t.bestOf);
          t.rounds = [firstRoundMatches];

          const cpuTotal = participants.filter(p => p.isCpu).length;
          const fillNote = autoAddedCpuCount > 0
            ? ` (🤖 +${autoAddedCpuCount} CPU-Gegner automatisch zum Auffüllen ergänzt)`
            : (cpuTotal > 0 ? ` (inkl. ${cpuTotal} CPU-Bots)` : '');

          broadcastChat(roomKey, {
            type: 'system',
            text: `🏆 Tetris-Turnier gestartet mit ${participants.length} Teilnehmern${fillNote}! Modus: ${t.mode === 'builtin' ? '🕹️ DMG Turnier-Tetris' : '🔗 Emulator Link-Kabel'}.`,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          });

          broadcastChat(roomKey, {
            type: 'TOURNAMENT_STARTED',
            tournament: sanitizeTournamentForClient(t)
          });

          broadcastTournamentState(roomKey);
          scheduleCpuVsCpuMatches(roomKey);
          break;
        }

        case 'TOURNAMENT_RESET': {
          // Clear any running CPU-vs-CPU timers
          if (chatRoom.tournament && chatRoom.tournament.rounds) {
            chatRoom.tournament.rounds.forEach(r => r.forEach(m => {
              if (m._simTimer) clearInterval(m._simTimer);
            }));
          }
          const prevCustomCpus = chatRoom.tournament ? chatRoom.tournament.customCpus : [];
          const prevMode = chatRoom.tournament ? chatRoom.tournament.mode : 'builtin';
          const prevFill = chatRoom.tournament ? chatRoom.tournament.fillMode : 'odd_plus_one';
          const prevDiff = chatRoom.tournament ? chatRoom.tournament.cpuDifficulty : 'normal';
          const prevBestOf = chatRoom.tournament ? chatRoom.tournament.bestOf : 3;

          chatRoom.tournament = createDefaultTournamentState();
          chatRoom.tournament.customCpus = prevCustomCpus;
          chatRoom.tournament.mode = prevMode;
          chatRoom.tournament.fillMode = prevFill;
          chatRoom.tournament.cpuDifficulty = prevDiff;
          chatRoom.tournament.bestOf = prevBestOf;

          broadcastChat(roomKey, {
            type: 'system',
            text: `🔄 Das Tetris-Turnier wurde zurückgesetzt. Bereit für ein neues Turnier!`,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          });
          broadcastTournamentState(roomKey);
          break;
        }

        case 'TOURNAMENT_GARBAGE_ATTACK': {
          const t = chatRoom.tournament;
          if (!t || t.status !== 'active') break;
          const lines = Math.max(1, Math.min(8, parseInt(msg.lines, 10) || 0));
          if (!lines || !msg.matchId) break;

          broadcastChat(roomKey, {
            type: 'TOURNAMENT_GARBAGE_INCOMING',
            matchId: msg.matchId,
            fromPlayerId: msg.fromPlayerId || ws.playerId,
            targetPlayerId: msg.targetPlayerId || null,
            lines,
            holeCol: typeof msg.holeCol === 'number' ? msg.holeCol : Math.floor(Math.random() * 10)
          });
          break;
        }

        case 'TOURNAMENT_BOARD_UPDATE': {
          const t = chatRoom.tournament;
          if (!t || t.status !== 'active' || !msg.matchId) break;

          // Update live scores on the match object
          const currentMatches = t.rounds[t.currentRound] || [];
          const match = currentMatches.find(m => m.id === msg.matchId);
          if (match) {
            if (msg.playerId === match.p1.id) {
              if (typeof msg.score === 'number') match.score1 = msg.score;
              if (typeof msg.lines === 'number') match.lines1 = msg.lines;
            } else if (msg.playerId === match.p2.id) {
              if (typeof msg.score === 'number') match.score2 = msg.score;
              if (typeof msg.lines === 'number') match.lines2 = msg.lines;
            }
          }

          // Relay live board snapshot to opponent and spectators
          const payload = JSON.stringify({
            type: 'TOURNAMENT_BOARD_STATE',
            matchId: msg.matchId,
            playerId: msg.playerId || ws.playerId,
            board: msg.board, // Compact 200-char string or array
            score: msg.score || 0,
            lines: msg.lines || 0,
            level: msg.level || 0,
            nextType: msg.nextType || null
          });

          chatRoom.clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(payload);
            }
          });
          break;
        }

        case 'TOURNAMENT_REPORT_WIN': {
          const t = chatRoom.tournament;
          if (!t || t.status !== 'active' || !msg.matchId || !msg.winnerId) break;

          const currentMatches = t.rounds[t.currentRound] || [];
          const match = currentMatches.find(m => m.id === msg.matchId);
          if (!match || match.status !== 'active') break;

          // Guard against duplicate reports for the same heart round
          const now = Date.now();
          if (match._lastWinReportAt && now - match._lastWinReportAt < 1200) break;
          match._lastWinReportAt = now;

          const isP1Winner = (msg.winnerId === match.p1.id);
          const isP2Winner = (msg.winnerId === match.p2.id);
          if (!isP1Winner && !isP2Winner) break;

          if (typeof msg.score1 === 'number') match.score1 = Math.max(match.score1, msg.score1);
          if (typeof msg.score2 === 'number') match.score2 = Math.max(match.score2, msg.score2);
          if (typeof msg.lines1 === 'number') match.lines1 = Math.max(match.lines1, msg.lines1);
          if (typeof msg.lines2 === 'number') match.lines2 = Math.max(match.lines2, msg.lines2);

          if (msg.instantMatchWin) {
            if (isP1Winner) match.wins1 = match.winsNeeded;
            else match.wins2 = match.winsNeeded;
          } else {
            if (isP1Winner) match.wins1 += 1;
            else match.wins2 += 1;
          }

          const roundWinner = isP1Winner ? match.p1 : match.p2;
          const roundLoser = isP1Winner ? match.p2 : match.p1;

          if (match.wins1 >= match.winsNeeded || match.wins2 >= match.winsNeeded) {
            match.status = 'completed';
            match.winnerId = roundWinner.id;
            match.winner = roundWinner;

            broadcastChat(roomKey, {
              type: 'system',
              text: `⚔️ Match entschieden (${match.roundName}): ${roundWinner.avatar} ${roundWinner.name} gewinnt gegen ${roundLoser.avatar} ${roundLoser.name} (${match.wins1}:${match.wins2})!`,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });

            broadcastChat(roomKey, {
              type: 'TOURNAMENT_MATCH_COMPLETED',
              matchId: match.id,
              winner: roundWinner,
              loser: roundLoser,
              wins1: match.wins1,
              wins2: match.wins2
            });

            checkAndAdvanceTournamentRound(roomKey);
            broadcastTournamentState(roomKey);
          } else {
            // Next heart round within Best-of-N
            match.seed = Math.floor(100000 + Math.random() * 900000);
            broadcastChat(roomKey, {
              type: 'TOURNAMENT_HEART_WON',
              matchId: match.id,
              roundWinnerId: roundWinner.id,
              roundWinnerName: roundWinner.name,
              wins1: match.wins1,
              wins2: match.wins2,
              nextSeed: match.seed
            });
            broadcastTournamentState(roomKey);
          }
          break;
        }

        case 'chat': {
          if (msg.text && msg.text.trim().length > 0) {
            const p = chatRoom.players.get(ws.playerId);
            const item = {
              type: 'chat',
              sender: msg.sender || (p ? p.name : ws.playerName),
              avatar: msg.avatar || (p ? p.avatar : '🎮'),
              color: msg.color || (p ? p.color : '#38bdf8'),
              text: msg.text.trim().slice(0, 500),
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };
            chatRoom.history.push(item);
            if (chatRoom.history.length > 50) chatRoom.history.shift();
            broadcastChat(roomKey, item);
          }
          break;
        }
      }
    } catch (e) {
      console.error('[Party/Chat Error]:', e);
    }
  });

  ws.on('close', () => {
    chatRoom.clients.delete(ws);
    const pid = chatRoom.socketToPlayerId.get(ws) || ws.playerId;
    chatRoom.socketToPlayerId.delete(ws);

    let stillConnected = false;
    for (const [, otherPid] of chatRoom.socketToPlayerId.entries()) {
      if (otherPid === pid) {
        stillConnected = true;
        break;
      }
    }

    if (!stillConnected && pid) {
      const leavingPlayer = chatRoom.players.get(pid);
      chatRoom.players.delete(pid);
      if (leavingPlayer) {
        broadcastChat(roomKey, {
          type: 'PLAYER_LEFT',
          playerId: pid,
          name: leavingPlayer.name,
          avatar: leavingPlayer.avatar
        });
        broadcastChat(roomKey, {
          type: 'system',
          text: `${leavingPlayer.avatar || '👋'} ${leavingPlayer.name} hat die Party verlassen.`,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
      }
    }

    if (chatRoom.clients.size === 0) {
      if (chatRoom.tournament && chatRoom.tournament.rounds) {
        chatRoom.tournament.rounds.forEach(r => r.forEach(m => {
          if (m._simTimer) clearInterval(m._simTimer);
        }));
      }
      chatRooms.delete(roomKey);
    } else {
      ensureRoomHost(chatRoom);
      broadcastRoster(roomKey);
    }
  });
});

function broadcastChat(roomKey, messageObj) {
  const room = chatRooms.get(roomKey);
  if (!room) return;
  const payload = JSON.stringify(messageObj);
  room.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Keepalive interval every 15s to prevent timeouts through proxies / NAT
const interval = setInterval(() => {
  wssGame.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
  wssChat.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

wssGame.on('close', () => clearInterval(interval));

server.listen(PORT, HOST, () => {
  console.log(`===============================================`);
  console.log(`🎮 Game Boy Multiplayer & Tetris-Turnier Server`);
  console.log(`🚀 Listening on http://${HOST}:${PORT}`);
  console.log(`🏆 8-Player Tetris Tournament & CPU Auto-Fill enabled`);
  console.log(`🔑 Alphanumeric room codes (4 chars, no 'o', lowercase)`);
  console.log(`💬 Live Chat & Party Sync enabled on /chat`);
  console.log(`📁 Web Root: ${DIST_DIR}`);
  console.log(`💾 ROMs Dir: ${ROMS_DIR}`);
  console.log(`===============================================`);
});
