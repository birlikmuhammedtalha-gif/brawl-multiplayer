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

const GW=600, GH=420;

// Arena duvarları
const ARENA_WALLS=[
  [5,1],[9,1],[5,8],[9,8],
  [2,3],[2,7],[12,3],[12,7],
  [6,4],[8,4],[6,6],[8,6]
].map(([x,y])=>({x:x*40,y:y*40,w:40,h:40}));

function rectHit(ax,ay,aw,ah,bx,by,bw,bh){
  return ax<bx+bw&&ax+aw>bx&&ay<by+bh&&ay+ah>by;
}
function wallHit(x,y,r,walls){
  for(let w of walls)
    if(rectHit(x-r,y-r,r*2,r*2,w.x,w.y,w.w,w.h)) return true;
  return false;
}
function tryMove(obj,dx,dy,walls){
  const nx=Math.max(obj.r+1,Math.min(GW-obj.r-1,obj.x+dx));
  const ny=Math.max(obj.r+1,Math.min(GH-obj.r-1,obj.y+dy));
  if(!wallHit(nx,obj.y,obj.r,walls)) obj.x=nx;
  if(!wallHit(obj.x,ny,obj.r,walls)) obj.y=ny;
}

function getSpawnPos(team,idx,mode){
  const isSoccer=mode&&mode.includes('soccer');
  const abl=[{x:50,y:100},{x:50,y:210},{x:50,y:320}];
  const ard=[{x:550,y:100},{x:550,y:210},{x:550,y:320}];
  const fbl=[{x:120,y:130},{x:120,y:210},{x:120,y:290}];
  const frd=[{x:480,y:130},{x:480,y:210},{x:480,y:290}];
  const list=isSoccer?(team==='blue'?fbl:frd):(team==='blue'?abl:ard);
  return list[idx%list.length];
}

function createRoom(roomId,mode){
  return{id:roomId,players:{},bullets:[],gameState:'waiting',score:{blue:0,red:0},ball:null,mode:mode||'arena',goalLocked:false};
}
function assignTeam(room){
  const pl=Object.values(room.players);
  return pl.filter(p=>p.team==='blue').length<=pl.filter(p=>p.team==='red').length?'blue':'red';
}
function addPlayerToRoom(socket,room,mode){
  const playerCount=Object.keys(room.players).length;
  const team=assignTeam(room);
  const idx=Object.values(room.players).filter(p=>p.team===team).length;
  const spawn=getSpawnPos(team,idx,mode||room.mode);
  room.players[socket.id]={
    id:socket.id,team,x:spawn.x,y:spawn.y,r:13,
    hp:100,maxHp:100,angle:team==='blue'?0:Math.PI,
    dead:false,label:`P${playerCount+1}`,
    ammo:5,maxAmmo:5,reloadTimer:0,invincible:0,shootCooldown:0
  };
  socket.join(room.id);
  socket.roomId=room.id;
  io.to(room.id).emit('roomUpdate',{players:room.players,score:room.score,gameState:room.gameState,mode:room.mode,playerCount:Object.keys(room.players).length});
  socket.emit('joinedRoom',{playerId:socket.id,team,roomId:room.id});
}

// Sunucu taraflı oyun döngüsü (60fps)
function startServerLoop(room){
  if(room.loop) return;
  room.loop=setInterval(()=>{
    if(room.gameState!=='playing'){clearInterval(room.loop);room.loop=null;return;}
    const walls=room.mode&&room.mode.includes('soccer')?[]:ARENA_WALLS;
    updateBullets(room,walls);
    updateBall(room);
  },16);
}

function updateBullets(room,walls){
  if(!room.bullets)room.bullets=[];
  for(let b of room.bullets){
    if(b.dead)continue;
    b.x+=b.vx;b.y+=b.vy;b.life--;
    if(b.x<0||b.x>GW||b.y<0||b.y>GH||b.life<=0){b.dead=true;continue;}
    // Duvar çarpışması
    let hitWall=false;
    for(let w of walls){
      if(b.x>w.x&&b.x<w.x+w.w&&b.y>w.y&&b.y<w.y+w.h){hitWall=true;break;}
    }
    if(hitWall){b.dead=true;continue;}
    // Oyuncu çarpışması
    for(let p of Object.values(room.players)){
      if(p.dead||p.team===b.team||(p.invincible||0)>0)continue;
      if(Math.hypot(b.x-p.x,b.y-p.y)<p.r+b.r){
        p.hp-=b.dmg;
        p.invincible=30;
        b.dead=true;
        if(p.hp<=0){
          p.hp=0;p.dead=true;
          io.to(room.id).emit('playerDied',{id:p.id});
          checkRoundEnd(room.id);
        } else {
          io.to(room.id).emit('playerDamaged',{id:p.id,hp:p.hp});
        }
        break;
      }
    }
  }
  room.bullets=room.bullets.filter(b=>!b.dead);
}

const GOAL_H=110,GOAL_TOP=(GH-GOAL_H)/2,GOAL_BOT=(GH+GOAL_H)/2,GOAL_W=20;
function updateBall(room){
  const ball=room.ball;
  if(!ball||room.goalLocked)return;
  ball.x+=ball.vx;ball.y+=ball.vy;
  ball.vx*=0.988;ball.vy*=0.988;
  if(Math.abs(ball.vx)<0.04)ball.vx=0;
  if(Math.abs(ball.vy)<0.04)ball.vy=0;
  if(!room.goalLocked){
    if(ball.x-ball.r<=GOAL_W&&ball.y>=GOAL_TOP&&ball.y<=GOAL_BOT){
      room.goalLocked=true;handleGoal(room,'red');return;
    }
    if(ball.x+ball.r>=GW-GOAL_W&&ball.y>=GOAL_TOP&&ball.y<=GOAL_BOT){
      room.goalLocked=true;handleGoal(room,'blue');return;
    }
  }
  if(ball.x-ball.r<=0){if(ball.y<GOAL_TOP||ball.y>GOAL_BOT){ball.x=ball.r+1;ball.vx=Math.abs(ball.vx);}}
  if(ball.x+ball.r>=GW){if(ball.y<GOAL_TOP||ball.y>GOAL_BOT){ball.x=GW-ball.r-1;ball.vx=-Math.abs(ball.vx);}}
  if(ball.y-ball.r<=0){ball.y=ball.r+1;ball.vy=Math.abs(ball.vy);}
  if(ball.y+ball.r>=GH){ball.y=GH-ball.r-1;ball.vy=-Math.abs(ball.vy);}
  // Oyuncu-top çarpışması
  for(let p of Object.values(room.players)){
    if(p.dead)continue;
    const dist=Math.hypot(ball.x-p.x,ball.y-p.y);
    if(dist<ball.r+p.r&&dist>0){
      const a=Math.atan2(ball.y-p.y,ball.x-p.x);
      ball.x=p.x+Math.cos(a)*(ball.r+p.r+1);
      ball.y=p.y+Math.sin(a)*(ball.r+p.r+1);
      const spd=Math.max(Math.sqrt(ball.vx*ball.vx+ball.vy*ball.vy),2.5);
      ball.vx=Math.cos(a)*spd;ball.vy=Math.sin(a)*spd;
    }
  }
  // Tüm oyunculara top pozisyonunu gönder (10 framede bir)
  if(!room.ballTick)room.ballTick=0;
  room.ballTick++;
  if(room.ballTick%3===0) io.to(room.id).emit('ballMoved',{...ball});
}

function handleGoal(room,team){
  if(team==='blue')room.score.blue++;else room.score.red++;
  io.to(room.id).emit('goalScored',{team,score:room.score});
  if(room.score.blue>=3||room.score.red>=3){
    room.gameState='ended';
    io.to(room.id).emit('gameOver',{winner:room.score.blue>=3?'blue':'red',score:room.score});
  } else {
    setTimeout(()=>{
      room.ball={x:300,y:210,vx:0,vy:0,r:11};
      room.goalLocked=false;
      room.bullets=[];
      Object.values(room.players).forEach((p,i)=>{
        p.hp=100;p.dead=false;p.invincible=90;
        const sp=getSpawnPos(p.team,i,room.mode);p.x=sp.x;p.y=sp.y;
      });
      io.to(room.id).emit('roundReset',{players:room.players,ball:room.ball,score:room.score});
    },1500);
  }
}

io.on('connection',(socket)=>{
  console.log('Bağlantı:',socket.id);

  socket.on('findMatch',({mode})=>{
    const wi=matchmakingQueue.findIndex(q=>q.mode===mode);
    if(wi!==-1){
      const waiting=matchmakingQueue.splice(wi,1)[0];
      const roomId='match_'+Date.now();
      const room=createRoom(roomId,mode);
      rooms[roomId]=room;
      addPlayerToRoom(waiting.socket,room,mode);
      addPlayerToRoom(socket,room,mode);
      setTimeout(()=>{
        room.gameState='playing';
        if(mode&&mode.includes('soccer'))room.ball={x:300,y:210,vx:0,vy:0,r:11};
        io.to(roomId).emit('gameStarted',{players:room.players,ball:room.ball,mode:room.mode,isRandom:true});
        startServerLoop(room);
      },1500);
    } else {
      matchmakingQueue.push({socket,mode});
      socket.emit('waitingForMatch',{message:'Rakip aranıyor...'});
    }
  });

  socket.on('cancelMatch',()=>{
    matchmakingQueue=matchmakingQueue.filter(q=>q.socket.id!==socket.id);
    socket.emit('matchCancelled');
  });

  socket.on('joinRoom',({roomId,mode})=>{
    if(!rooms[roomId])rooms[roomId]=createRoom(roomId,mode);
    const room=rooms[roomId];
    if(Object.keys(room.players).length>=6){socket.emit('roomFull');return;}
    if(mode)room.mode=mode;
    addPlayerToRoom(socket,room,mode);
  });

  socket.on('startGame',()=>{
    const room=rooms[socket.roomId];if(!room)return;
    room.gameState='playing';
    if(room.mode&&room.mode.includes('soccer'))room.ball={x:300,y:210,vx:0,vy:0,r:11};
    io.to(socket.roomId).emit('gameStarted',{players:room.players,ball:room.ball,mode:room.mode});
    startServerLoop(room);
  });

  socket.on('playerMove',(data)=>{
    const room=rooms[socket.roomId];
    if(!room||!room.players[socket.id])return;
    const p=room.players[socket.id];
    if(p.dead)return;
    const walls=room.mode&&room.mode.includes('soccer')?[]:ARENA_WALLS;
    // Sunucu tarafında hareket + duvar kontrolü
    const dx=data.x-p.x, dy=data.y-p.y;
    tryMove(p,dx,dy,walls);
    p.angle=data.angle;p.ammo=data.ammo;
    if(p.invincible>0)p.invincible--;
    if(p.shootCooldown>0)p.shootCooldown--;
    socket.to(socket.roomId).emit('playerMoved',{id:socket.id,x:p.x,y:p.y,angle:p.angle,ammo:p.ammo,hp:p.hp});
  });

  socket.on('shoot',(data)=>{
    const room=rooms[socket.roomId];if(!room)return;
    const p=room.players[socket.id];if(!p||p.dead)return;
    if(!room.bullets)room.bullets=[];
    const bullet={
      x:data.x,y:data.y,vx:data.vx,vy:data.vy,
      r:5,color:data.color,dmg:20,
      team:p.team,shooterId:socket.id,life:70,dead:false
    };
    room.bullets.push(bullet);
    // Diğer oyunculara gönder (görsel için)
    socket.to(socket.roomId).emit('bulletFired',{...bullet});
  });

  socket.on('ballKick',(data)=>{
    const room=rooms[socket.roomId];
    if(!room||!room.ball||room.goalLocked)return;
    room.ball.vx=data.vx;room.ball.vy=data.vy;
    socket.to(socket.roomId).emit('ballMoved',{...room.ball});
  });

  socket.on('disconnect',()=>{
    matchmakingQueue=matchmakingQueue.filter(q=>q.socket.id!==socket.id);
    const room=rooms[socket.roomId];if(!room)return;
    delete room.players[socket.id];
    io.to(socket.roomId).emit('playerLeft',{id:socket.id});
    if(Object.keys(room.players).length===0){
      if(room.loop)clearInterval(room.loop);
      delete rooms[socket.roomId];
    }
    console.log('Ayrıldı:',socket.id);
  });
});

function checkRoundEnd(roomId){
  const room=rooms[roomId];if(!room)return;
  const blue=Object.values(room.players).filter(p=>p.team==='blue'&&!p.dead).length;
  const red=Object.values(room.players).filter(p=>p.team==='red'&&!p.dead).length;
  if(blue===0||red===0){
    const winner=blue>0?'blue':'red';
    if(winner==='blue')room.score.blue++;else room.score.red++;
    if(room.score.blue>=2||room.score.red>=2){
      room.gameState='ended';
      io.to(roomId).emit('gameOver',{winner,score:room.score});
    } else {
      setTimeout(()=>{
        Object.values(room.players).forEach((p,i)=>{
          p.hp=100;p.dead=false;p.invincible=90;
          const sp=getSpawnPos(p.team,i,room.mode);p.x=sp.x;p.y=sp.y;
        });
        room.bullets=[];
        io.to(roomId).emit('newRound',{players:room.players,score:room.score,winner});
      },800);
    }
  }
}

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Sunucu: http://localhost:${PORT}`));
