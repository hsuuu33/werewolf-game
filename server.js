const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const rooms = {};

// 勝負判定邏輯
function checkWin(roomCode) {
    const room = rooms[roomCode];
    if (!room) return null;
    const alivePlayers = room.players.filter(p => p.alive);
    const wolves = alivePlayers.filter(p => p.role === '狼人');
    const nonWolves = alivePlayers.filter(p => p.role !== '狼人');

    if (wolves.length === 0) return "🎉 好人陣營勝利！狼人已全滅。";
    if (wolves.length >= nonWolves.length) return "🐺 狼人陣營勝利！屠城成功。";
    return null;
}

io.on('connection', (socket) => {
    socket.on('createRoom', () => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[roomCode] = { 
            host: socket.id, 
            players: [], 
            witchPotions: { save: true, poison: true },
            logs: [] // 儲存本局所有行動紀錄
        };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
    });

    socket.on('joinRoom', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];
        if (room) {
            const existing = room.players.find(p => p.name === playerName);
            // 權限判定：確認是否為原始建立者或之前紀錄的法官
            const isActuallyHost = (socket.id === room.host || (existing && existing.isHost));
            
            if (existing) {
                existing.id = socket.id;
                existing.isHost = isActuallyHost;
            } else {
                room.players.push({ 
                    id: socket.id, name: playerName, role: '等待中', alive: true, isHost: isActuallyHost 
                });
            }
            socket.join(roomCode);
            // 關鍵：將權限與歷史紀錄一併發送給重連的法官
            socket.emit('hostCheck', { isHost: isActuallyHost, historyLogs: room.logs });
            io.to(roomCode).emit('roomUpdated', room.players);
        }
    });

    socket.on('startGame', (roomCode) => {
        const room = rooms[roomCode];
        if (room) {
            room.witchPotions = { save: true, poison: true };
            room.logs = ["🏮 遊戲開始"]; // 重置紀錄
            let players = room.players;
            let num = players.length;
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
            const msg = `🔪 狼人暗殺：${data.target}`;
            room.logs.push(msg); // 存入伺服器紀錄
            io.to(room.host).emit('adminLog', msg);
            io.to(data.roomCode).emit('updateWitchInfo', { target: data.target, potions: room.witchPotions });
        }
    });

    socket.on('checkRole', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            const target = room.players.find(p => p.name === data.targetName);
            if (target) {
                socket.emit('checkResult', { name: data.targetName, result: target.role === '狼人' ? '【壞人】' : '【好人】' });
                const msg = `🔮 預言家查驗：${data.targetName}`;
                room.logs.push(msg);
                io.to(room.host).emit('adminLog', msg);
            }
        }
    });

    socket.on('specialAction', (data) => {
        const room = rooms[data.roomCode];
        if (!room) return;
        let msg = "";
        if (data.type === 'saved') { room.witchPotions.save = false; msg = "💊 女巫救了被殺者"; }
        if (data.type === 'poisoned') { room.witchPotions.poison = false; msg = `🧪 女巫毒殺：${data.target}`; }
        if (data.type === 'guarded') { msg = `🛡️ 守衛守護：${data.target}`; }
        
        if (msg) {
            room.logs.push(msg); // 存入伺服器紀錄
            io.to(room.host).emit('adminLog', msg);
        }
        io.to(data.roomCode).emit('syncPotions', room.witchPotions);
    });

    socket.on('killPlayer', (data) => {
        const room = rooms[data.roomCode];
        const p = room.players.find(p => p.name === data.targetName);
        if (p) { 
            p.alive = false; 
            const msg = `💀 法官宣告死亡：${data.targetName}`;
            room.logs.push(msg);
            io.to(p.id).emit('youAreDead'); 
            io.to(data.roomCode).emit('roomUpdated', room.players); 
            
            const winMsg = checkWin(data.roomCode);
            if (winMsg) {
                room.logs.push(`🏁 ${winMsg}`);
                io.to(data.roomCode).emit('gameOver', winMsg);
            }
        }
    });
});

http.listen(3000, '0.0.0.0');