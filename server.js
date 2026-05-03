const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname)));

const rooms = {};
let matchmakingQueue = [];

// Oyun alanı 600x420, spawn noktaları kesinlikle içeride
function getSpawnPos(team, idx, mode) {
  const isSoccer = mode && mode.includes('soccer');
  // Arena spawn: sol/sağ ortası, duvarlardan uzak
  const abl = [{x:50,y:100},{x:50,y:210},{x:50,y:320}];
  const ard = [{x:550,y:100},{x:550,y:210},{x:550,y:320}];
  // Futbol spawn: alan içi, kale önü değil
  const fbl = [{x:120,y:130},{x:120,y:210},{x:120,y:290}];
  const frd = [{x:480,y:130},{x:480,y:210},{x:480,y:290}];
  const list = isSoccer ? (team==='blue'?fbl:frd) : (team==='blue'?abl:ard);
  return list[idx % list.length];
}

function createRoom(roomId, mode) {
  return { id: roomId, players: {}, gameState: 'waiting', score: {blue:0,red:0}, ball: null, mode: mode||'arena' };
}

function assignTeam(room) {
  const players = Object.values(room.players);
  const blueCount = players.filter(p=>p.team==='blue').length;
  const redCount = players.filter(p=>p.team==='red').length;
  return blueCount <= redCount ? 'blue' : 'red';
}

function addPlayerToRoom(socket, room, mode) {
  const playerCount = Object.keys(room.players).length;
  const team = assignTeam(room);
  const teamPlayers = Object.values(room.players).filter(p=>p.team===team);
  const idx = teamPlayers.length;
  const spawn = getSpawnPos(team, idx, mode || room.mode);

  console.log(`Spawn: takım=${team} idx=${idx} x=${spawn.x} y=${spawn.y} mod=${mode||room.mode}`);

  room.players[socket.id] = {
    id: socket.id, team,
    x: spawn.x, y: spawn.y,
    r: 13,
    hp: 100, maxHp: 100,
    angle: team==='blue'?0:Math.PI,
    dead: false,
    label: `P${playerCount+1}`,
    ammo: 5, maxAmmo: 5,
    reloadTimer: 0, invincible: 0,
  };

  socket.join(room.id);
  socket.roomId = room.id;

  io.to(room.id).emit('roomUpdate', {
    players: room.players,
    score: room.score,
    gameState: room.gameState,
    mode: room.mode,
    playerCount: Object.keys(room.players).length,
  });

  socket.emit('joinedRoom', { playerId: socket.id, team, roomId: room.id });
}

io.on('connection', (socket) => {
  console.log('Bağlantı:', socket.id);

  socket.on('findMatch', ({ mode }) => {
    const waitingIdx = matchmakingQueue.findIndex(q => q.mode === mode);
    if (waitingIdx !== -1) {
      const waiting = matchmakingQueue.splice(waitingIdx, 1)[0];
      const roomId = 'match_' + Date.now();
      const room = createRoom(roomId, mode);
      rooms[roomId] = room;
      addPlayerToRoom(waiting.socket, room, mode);
      addPlayerToRoom(socket, room, mode);
      setTimeout(() => {
        room.gameState = 'playing';
        if (mode && mode.includes('soccer')) room.ball = { x:300, y:210, vx:0, vy:0, r:11 };
        io.to(roomId).emit('gameStarted', {
          players: room.players, ball: room.ball, mode: room.mode, isRandom: true
        });
      }, 1500);
    } else {
      matchmakingQueue.push({ socket, mode });
      socket.emit('waitingForMatch', { message: 'Rakip aranıyor...' });
    }
  });

  socket.on('cancelMatch', () => {
    matchmakingQueue = matchmakingQueue.filter(q => q.socket.id !== socket.id);
    socket.emit('matchCancelled');
  });

  socket.on('joinRoom', ({ roomId, mode }) => {
    if (!rooms[roomId]) rooms[roomId] = createRoom(roomId, mode);
    const room = rooms[roomId];
    if (Object.keys(room.players).length >= 6) { socket.emit('roomFull'); return; }
    if (mode) room.mode = mode;
    addPlayerToRoom(socket, room, mode);
  });

  socket.on('startGame', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    room.gameState = 'playing';
    if (room.mode && room.mode.includes('soccer')) room.ball = {x:300,y:210,vx:0,vy:0,r:11};
    io.to(socket.roomId).emit('gameStarted', {
      players: room.players, ball: room.ball, mode: room.mode
    });
  });

  socket.on('playerMove', (data) => {
    const room = rooms[socket.roomId];
    if (!room || !room.players[socket.id]) return;
    const p = room.players[socket.id];
    if (p.dead) return;
    // Sunucu tarafında da sınır kontrolü
    p.x = Math.max(14, Math.min(586, data.x));
    p.y = Math.max(14, Math.min(406, data.y));
    p.angle = data.angle;
    p.ammo = data.ammo;
    socket.to(socket.roomId).emit('playerMoved', {
      id: socket.id, x: p.x, y: p.y, angle: p.angle, ammo: p.ammo
    });
  });

  socket.on('shoot', (data) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    io.to(socket.roomId).emit('bulletFired', {
      ...data, shooterId: socket.id, team: room.players[socket.id]?.team
    });
  });

  socket.on('playerHit', ({ targetId, dmg }) => {
    const room = rooms[socket.roomId];
    if (!room || !room.players[targetId]) return;
    const target = room.players[targetId];
    if (target.dead || (target.invincible||0) > 0) return;
    target.hp -= dmg;
    target.invincible = 18;
    if (target.hp <= 0) {
      target.hp = 0; target.dead = true;
      io.to(socket.roomId).emit('playerDied', { id: targetId });
      checkRoundEnd(socket.roomId);
    } else {
      io.to(socket.roomId).emit('playerDamaged', { id: targetId, hp: target.hp });
    }
  });

  socket.on('ballUpdate', (ballData) => {
    const room = rooms[socket.roomId];
    if (!room || !room.ball) return;
    room.ball = ballData;
    socket.to(socket.roomId).emit('ballMoved', ballData);
  });

  socket.on('goalScored', ({ team }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    if (team==='blue') room.score.blue++; else room.score.red++;
    io.to(socket.roomId).emit('goalScored', { team, score: room.score });
    if (room.score.blue >= 3 || room.score.red >= 3) {
      room.gameState = 'ended';
      io.to(socket.roomId).emit('gameOver', {
        winner: room.score.blue>=3?'blue':'red', score: room.score
      });
    } else {
      room.ball = {x:300,y:210,vx:0,vy:0,r:11};
      Object.values(room.players).forEach((p, i) => {
        p.hp=100; p.dead=false; p.invincible=60;
        const sp = getSpawnPos(p.team, i, room.mode);
        p.x=sp.x; p.y=sp.y;
      });
      io.to(socket.roomId).emit('roundReset', {
        players: room.players, ball: room.ball, score: room.score
      });
    }
  });

  socket.on('disconnect', () => {
    matchmakingQueue = matchmakingQueue.filter(q => q.socket.id !== socket.id);
    const room = rooms[socket.roomId];
    if (!room) return;
    delete room.players[socket.id];
    io.to(socket.roomId).emit('playerLeft', { id: socket.id });
    if (Object.keys(room.players).length === 0) delete rooms[socket.roomId];
    console.log('Ayrıldı:', socket.id);
  });
});

function checkRoundEnd(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const blue = Object.values(room.players).filter(p=>p.team==='blue'&&!p.dead).length;
  const red = Object.values(room.players).filter(p=>p.team==='red'&&!p.dead).length;
  if (blue===0 || red===0) {
    const winner = blue>0?'blue':'red';
    if (winner==='blue') room.score.blue++; else room.score.red++;
    if (room.score.blue>=2 || room.score.red>=2) {
      room.gameState='ended';
      io.to(roomId).emit('gameOver', { winner, score: room.score });
    } else {
      Object.values(room.players).forEach((p, i) => {
        p.hp=100; p.dead=false; p.invincible=60;
        const sp = getSpawnPos(p.team, i, room.mode);
        p.x=sp.x; p.y=sp.y;
      });
      io.to(roomId).emit('newRound', { players: room.players, score: room.score, winner });
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Sunucu: http://localhost:${PORT}`));
