const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// Oda yönetimi
const rooms = {};

function createRoom(roomId) {
  return {
    id: roomId,
    players: {},
    gameState: 'waiting', // waiting, playing, ended
    score: { blue: 0, red: 0 },
    ball: null,
    mode: null,
  };
}

function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
  return rooms[roomId];
}

function assignTeam(room) {
  const players = Object.values(room.players);
  const blueCount = players.filter(p => p.team === 'blue').length;
  const redCount = players.filter(p => p.team === 'red').length;
  return blueCount <= redCount ? 'blue' : 'red';
}

function getSpawnPos(team, idx, mode) {
  const isSoccer = mode && mode.includes('soccer');
  const abl = [{x:30,y:80},{x:30,y:210},{x:30,y:340}];
  const ard = [{x:570,y:80},{x:570,y:210},{x:570,y:340}];
  const fbl = [{x:100,y:110},{x:100,y:210},{x:100,y:310}];
  const frd = [{x:500,y:110},{x:500,y:210},{x:500,y:310}];
  const list = isSoccer ? (team === 'blue' ? fbl : frd) : (team === 'blue' ? abl : ard);
  return list[idx % list.length];
}

io.on('connection', (socket) => {
  console.log('Bağlantı:', socket.id);

  // Odaya katıl
  socket.on('joinRoom', ({ roomId, mode }) => {
    const room = getOrCreateRoom(roomId);
    const playerCount = Object.keys(room.players).length;

    if (playerCount >= 6) {
      socket.emit('roomFull');
      return;
    }

    const team = assignTeam(room);
    const teamPlayers = Object.values(room.players).filter(p => p.team === team);
    const idx = teamPlayers.length;
    const spawn = getSpawnPos(team, idx, mode || 'arena');

    room.players[socket.id] = {
      id: socket.id,
      team,
      x: spawn.x,
      y: spawn.y,
      hp: 100,
      maxHp: 100,
      angle: team === 'blue' ? 0 : Math.PI,
      dead: false,
      label: `P${playerCount + 1}`,
      ammo: 5,
      maxAmmo: 5,
      reloadTimer: 0,
      invincible: 0,
    };

    if (mode) room.mode = mode;
    socket.join(roomId);
    socket.roomId = roomId;

    // Odadaki herkese güncel oyuncu listesini gönder
    io.to(roomId).emit('roomUpdate', {
      players: room.players,
      score: room.score,
      gameState: room.gameState,
      mode: room.mode,
    });

    socket.emit('joinedRoom', {
      playerId: socket.id,
      team,
      roomId,
    });

    console.log(`${socket.id} → oda: ${roomId}, takım: ${team}`);
  });

  // Oyun başlat
  socket.on('startGame', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    room.gameState = 'playing';
    if (room.mode && room.mode.includes('soccer')) {
      room.ball = { x: 300, y: 210, vx: 0, vy: 0, r: 11 };
    }
    io.to(socket.roomId).emit('gameStarted', {
      players: room.players,
      ball: room.ball,
      mode: room.mode,
    });
  });

  // Oyuncu hareketi
  socket.on('playerMove', (data) => {
    const room = rooms[socket.roomId];
    if (!room || !room.players[socket.id]) return;
    const p = room.players[socket.id];
    if (p.dead) return;
    p.x = data.x;
    p.y = data.y;
    p.angle = data.angle;
    p.ammo = data.ammo;
    p.reloadTimer = data.reloadTimer;
    // Diğer oyunculara yayınla
    socket.to(socket.roomId).emit('playerMoved', {
      id: socket.id,
      x: p.x, y: p.y,
      angle: p.angle,
      ammo: p.ammo,
    });
  });

  // Mermi
  socket.on('shoot', (data) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    io.to(socket.roomId).emit('bulletFired', {
      ...data,
      shooterId: socket.id,
      team: room.players[socket.id]?.team,
    });
  });

  // Hasar
  socket.on('playerHit', ({ targetId, dmg }) => {
    const room = rooms[socket.roomId];
    if (!room || !room.players[targetId]) return;
    const target = room.players[targetId];
    if (target.dead || target.invincible > 0) return;
    target.hp -= dmg;
    target.invincible = 18;
    if (target.hp <= 0) {
      target.hp = 0;
      target.dead = true;
      io.to(socket.roomId).emit('playerDied', { id: targetId });
      checkRoundEnd(socket.roomId);
    } else {
      io.to(socket.roomId).emit('playerDamaged', { id: targetId, hp: target.hp });
    }
  });

  // Top hareketi (sadece host gönderir)
  socket.on('ballUpdate', (ballData) => {
    const room = rooms[socket.roomId];
    if (!room || !room.ball) return;
    room.ball = ballData;
    socket.to(socket.roomId).emit('ballMoved', ballData);
  });

  // Gol
  socket.on('goalScored', ({ team }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    if (team === 'blue') room.score.blue++;
    else room.score.red++;
    io.to(socket.roomId).emit('goalScored', {
      team,
      score: room.score,
    });
    if (room.score.blue >= 3 || room.score.red >= 3) {
      room.gameState = 'ended';
      io.to(socket.roomId).emit('gameOver', {
        winner: room.score.blue >= 3 ? 'blue' : 'red',
        score: room.score,
      });
    } else {
      // Topu sıfırla
      room.ball = { x: 300, y: 210, vx: 0, vy: 0, r: 11 };
      // Oyuncuları sıfırla
      Object.values(room.players).forEach((p, i) => {
        p.hp = 100; p.dead = false; p.invincible = 60;
        const sp = getSpawnPos(p.team, i, room.mode);
        p.x = sp.x; p.y = sp.y;
      });
      io.to(socket.roomId).emit('roundReset', {
        players: room.players,
        ball: room.ball,
        score: room.score,
      });
    }
  });

  // Bağlantı kesildi
  socket.on('disconnect', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    delete room.players[socket.id];
    io.to(socket.roomId).emit('playerLeft', { id: socket.id });
    if (Object.keys(room.players).length === 0) {
      delete rooms[socket.roomId];
      console.log(`Oda silindi: ${socket.roomId}`);
    }
    console.log('Ayrıldı:', socket.id);
  });
});

function checkRoundEnd(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const blue = Object.values(room.players).filter(p => p.team === 'blue' && !p.dead).length;
  const red = Object.values(room.players).filter(p => p.team === 'red' && !p.dead).length;
  if (blue === 0 || red === 0) {
    const winner = blue > 0 ? 'blue' : 'red';
    if (winner === 'blue') room.score.blue++;
    else room.score.red++;
    if (room.score.blue >= 2 || room.score.red >= 2) {
      room.gameState = 'ended';
      io.to(roomId).emit('gameOver', { winner, score: room.score });
    } else {
      // Yeni tur
      Object.values(room.players).forEach((p, i) => {
        p.hp = 100; p.dead = false; p.invincible = 60;
        const sp = getSpawnPos(p.team, i, room.mode);
        p.x = sp.x; p.y = sp.y;
      });
      io.to(roomId).emit('newRound', { players: room.players, score: room.score, winner });
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Sunucu çalışıyor: http://localhost:${PORT}`));
