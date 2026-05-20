const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const rooms = {};

// 勝負判定邏輯 (屠城規則)
function checkWin(roomCode) {
    const room = rooms[roomCode];
    if (!room) return null;
    const alivePlayers = room.players.filter(p => p.alive);
    const wolves = alivePlayers.filter(p => p.role === '狼人');
    const nonWolves = alivePlayers.filter(p => p.role !== '狼人');

    if (wolves.length === 0) return "🎉 好人陣營勝利！狼人已全滅。";
    if (wolves.length >= nonWolves.length) return "🐺 狼人陣營勝利！狼人控制了局勢。";
    return null;
}

io.on('connection', (socket) => {
    socket.on('createRoom', () => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[roomCode] = { 
            host: socket.id, 
            players: [], 
            witchPotions: { save: true, poison: true } 
        };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
    });

    socket.on('joinRoom', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];
        if (room) {
            const existing = room.players.find(p => p.name === playerName);
            
            // 關鍵：如果他是房主，或者之前紀錄裡他就是 Host
            const isActuallyHost = (socket.id === room.host || (existing && existing.isHost));
            
            if (existing) {
                existing.id = socket.id;
                existing.isHost = isActuallyHost; // 確保權限續存
            } else {
                room.players.push({ 
                    id: socket.id, 
                    name: playerName, 
                    role: '等待中', 
                    alive: true,
                    isHost: isActuallyHost 
                });
            }
            socket.join(roomCode);
            // 告訴這個人他目前的權限
            socket.emit('hostCheck', { isHost: isActuallyHost });
            io.to(roomCode).emit('roomUpdated', room.players);
        }
    });
    socket.on('startGame', (roomCode) => {
        const room = rooms[roomCode];
        if (room) {
            room.witchPotions = { save: true, poison: true };
            let players = room.players;
            let num = players.length;
            // 自動配置板子
            let roles = (num <= 5) ? ['狼人', '預言家', '女巫', '平民', '平民'] :
                        (num <= 8) ? ['狼人', '狼人', '預言家', '女巫', '守衛', '平民', '平民', '平民'] :
                        ['狼人', '狼人', '狼人', '預言家', '女巫', '獵人', '守衛', '平民', '平民', '平民'];
            
            roles = roles.slice(0, num).sort(() => Math.random() - 0.5);
            players.forEach((p, i) => {
                p.role = roles[i];
                p.alive = true;
                io.to(p.id).emit('assignRole', { role: p.role });
            });
            io.to(roomCode).emit('roomUpdated', players);
            io.to(roomCode).emit('gameMsg', "🏮 遊戲開始，天黑請閉眼");
        }
    });

    socket.on('nextPhase', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            const aliveNames = room.players.filter(p => p.alive).map(p => p.name);
            io.to(data.roomCode).emit('phaseChanged', { 
                phase: data.phase, 
                alivePlayers: aliveNames, 
                potions: room.witchPotions 
            });
        }
    });

    socket.on('wolfVote', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            io.to(room.host).emit('adminLog', `🔪 狼人暗殺：${data.target}`);
            io.to(data.roomCode).emit('updateWitchInfo', { target: data.target, potions: room.witchPotions });
        }
    });

    socket.on('checkRole', (data) => {
        const room = rooms[data.roomCode];
        const target = room.players.find(p => p.name === data.targetName);
        if (target) {
            socket.emit('checkResult', { name: data.targetName, result: target.role === '狼人' ? '【壞人】' : '【好人】' });
            io.to(room.host).emit('adminLog', `🔮 預言家查驗了某人`);
        }
    });

    socket.on('specialAction', (data) => {
        const room = rooms[data.roomCode];
        if (!room) return;
        if (data.type === 'saved') {
            room.witchPotions.save = false;
            io.to(room.host).emit('adminLog', `💊 女巫使用了解藥`);
        }
        if (data.type === 'poisoned') {
            room.witchPotions.poison = false;
            io.to(room.host).emit('adminLog', `🧪 女巫毒殺：${data.target}`);
        }
        if (data.type === 'guarded') {
            io.to(room.host).emit('adminLog', `🛡️ 守衛守護：${data.target}`);
        }
        io.to(data.roomCode).emit('syncPotions', room.witchPotions);
    });

    socket.on('killPlayer', (data) => {
        const room = rooms[data.roomCode];
        const p = room.players.find(p => p.name === data.targetName);
        if (p) { 
            p.alive = false; 
            io.to(p.id).emit('youAreDead'); 
            io.to(data.roomCode).emit('roomUpdated', room.players); 
            
            const winMsg = checkWin(data.roomCode);
            if (winMsg) io.to(data.roomCode).emit('gameOver', winMsg);
        }
    });
});

http.listen(3000, '0.0.0.0', () => console.log('狼人殺最終版已啟動！'));