const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

app.use(express.static(__dirname));
const rooms = {};

// 檢查遊戲是否結束
function checkWin(roomCode) {
    const room = rooms[roomCode];
    if (!room) return null;
    const alivePlayers = room.players.filter(p => p.alive);
    const wolves = alivePlayers.filter(p => p.role === '狼人');
    const nonWolves = alivePlayers.filter(p => p.role !== '狼人');
    
    if (wolves.length === 0) return "🎉 遊戲結束：好人陣營勝利！";
    if (wolves.length >= nonWolves.length) return "🐺 遊戲結束：狼人陣營勝利！";
    return null;
}

io.on('connection', (socket) => {
    
    // 建立房間
    socket.on('createRoom', () => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[roomCode] = { 
            host: socket.id, 
            players: [], 
            witchPotions: { save: true, poison: true }, 
            logs: [] 
        };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
    });

    // 加入房間與法官權限判定
    socket.on('joinRoom', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];
        
        if (room) {
            const existingPlayer = room.players.find(p => p.name === playerName);
            // 確認是否為原始建立者或之前紀錄的法官
            const isActuallyHost = (socket.id === room.host || (existingPlayer && existingPlayer.isHost));
            
            if (existingPlayer) { 
                existingPlayer.id = socket.id; 
                existingPlayer.isHost = isActuallyHost; 
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
            // 補發權限與歷史紀錄給法官
            socket.emit('hostCheck', { isHost: isActuallyHost, historyLogs: room.logs });
            io.to(roomCode).emit('roomUpdated', room.players);
        }
    });

    // 開始遊戲與身分發放
    socket.on('startGame', (roomCode) => {
        const room = rooms[roomCode];
        if (room) {
            room.witchPotions = { save: true, poison: true }; 
            room.logs = ["🏮 遊戲開始"]; // 清空並重置紀錄
            
            let players = room.players;
            let num = players.length;
            let roles = (num <= 5) ? ['狼人', '預言家', '女巫', '平民', '平民'] : 
                        (num <= 8) ? ['狼人', '狼人', '預言家', '女巫', '守衛', '平民', '平民', '平民'] : 
                        ['狼人', '狼人', '狼人', '預言家', '女巫', '獵人', '守衛', '平民', '平民', '平民'];
            
            roles = roles.slice(0, num).sort(() => Math.random() - 0.5);
            
            players.forEach((player, index) => { 
                player.role = roles[index]; 
                player.alive = true; 
                io.to(player.id).emit('assignRole', { role: player.role }); 
            });
            
            io.to(roomCode).emit('roomUpdated', players);
            io.to(roomCode).emit('gameMsg', "🏮 遊戲開始，請確認身分！");
        }
    });

    // 切換日夜階段
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

    // 狼人暗殺
    socket.on('wolfVote', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            const msg = `🔪 狼人暗殺了：${data.target}`;
            room.logs.push(msg);
            io.to(room.host).emit('adminLog', msg);
            io.to(data.roomCode).emit('updateWitchInfo', { target: data.target, potions: room.witchPotions });
        }
    });

    // 預言家查驗
    socket.on('checkRole', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            const targetPlayer = room.players.find(p => p.name === data.targetName);
            if (targetPlayer) {
                const result = (targetPlayer.role === '狼人') ? '【壞人】' : '【好人】';
                socket.emit('checkResult', { name: data.targetName, result: result });
                const msg = `🔮 預言家查驗：${data.targetName} -> ${result}`;
                room.logs.push(msg);
                io.to(room.host).emit('adminLog', msg);
            }
        }
    });

    // 特殊身分行動 (女巫、守衛)
    socket.on('specialAction', (data) => {
        const room = rooms[data.roomCode];
        if (!room) return;
        
        let msg = "";
        if (data.type === 'saved') { 
            room.witchPotions.save = false; 
            msg = "💊 女巫使用解藥救人"; 
        } else if (data.type === 'poisoned') { 
            room.witchPotions.poison = false; 
            msg = `🧪 女巫毒殺了：${data.target}`; 
        } else if (data.type === 'guarded') { 
            msg = `🛡️ 守衛守護了：${data.target}`; 
        }
        
        if (msg) {
            room.logs.push(msg);
            io.to(room.host).emit('adminLog', msg);
        }
        io.to(data.roomCode).emit('syncPotions', room.witchPotions);
    });

    // 法官宣告死亡
    socket.on('killPlayer', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            const targetPlayer = room.players.find(p => p.name === data.targetName);
            if (targetPlayer) {
                targetPlayer.alive = false;
                const msg = `💀 法官宣告死亡：${data.targetName}`;
                room.logs.push(msg);
                
                io.to(targetPlayer.id).emit('youAreDead');
                io.to(data.roomCode).emit('roomUpdated', room.players);
                
                const winMessage = checkWin(data.roomCode);
                if (winMessage) {
                    room.logs.push(`🏁 ${winMessage}`);
                    io.to(data.roomCode).emit('gameOver', winMessage);
                }
            }
        }
    });
});

http.listen(3000, '0.0.0.0', () => {
    console.log('伺服器已成功啟動！');
});
