const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

app.use(express.static(__dirname));
const rooms = {};

// 檢查勝負
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
    
    socket.on('createRoom', () => {
        const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[roomCode] = { 
            host: socket.id, 
            players: [], 
            witchPotions: { save: true, poison: true }, 
            logs: [],
            guardedPlayer: null 
        };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
    });

    socket.on('joinRoom', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];
        
        if (room) {
            const existingPlayer = room.players.find(p => p.name === playerName);
            const isActuallyHost = (socket.id === room.host || (existingPlayer && existingPlayer.isHost));
            
            if (existingPlayer) { 
                existingPlayer.id = socket.id; 
                existingPlayer.isHost = isActuallyHost; 
                if (isActuallyHost) room.host = socket.id;
                
                // 🔥 終極防護：玩家重連時，補發身分與生死狀態，防止遊戲卡死
                if (existingPlayer.role !== '等待中') {
                    socket.emit('assignRole', { role: existingPlayer.role });
                    if (!existingPlayer.alive) {
                        socket.emit('youAreDead');
                    }
                }
            } else { 
                room.players.push({ id: socket.id, name: playerName, role: '等待中', alive: true, isHost: isActuallyHost }); 
                if (isActuallyHost) room.host = socket.id;
            }
            
            socket.join(roomCode);
            socket.emit('hostCheck', { isHost: isActuallyHost, historyLogs: room.logs });
            io.to(roomCode).emit('roomUpdated', room.players);
        }
    });

    socket.on('startGame', (roomCode) => {
        const room = rooms[roomCode];
        if (room) {
            room.witchPotions = { save: true, poison: true }; 
            room.logs = ["🏮 遊戲開始"]; 
            room.guardedPlayer = null; 
            
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

    socket.on('nextPhase', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            if (data.phase === 'night') room.guardedPlayer = null; 
            const aliveNames = room.players.filter(p => p.alive).map(p => p.name);
            io.to(data.roomCode).emit('phaseChanged', { phase: data.phase, alivePlayers: aliveNames, potions: room.witchPotions });
        }
    });

    socket.on('wolfVote', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            const msg = `🔪 狼人暗殺了：${data.target}`;
            room.logs.push(msg);
            io.to(room.host).emit('adminLog', msg); 
            io.to(data.roomCode).emit('updateWitchInfo', { target: data.target, potions: room.witchPotions });
        }
    });

    socket.on('checkRole', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            const targetPlayer = room.players.find(p => p.name === data.targetName);
            if (targetPlayer) {
                const result = (targetPlayer.role === '狼人') ? '【壞人】' : '【好人】';
                socket.emit('checkResult', { name: data.targetName, result: result });
            }
        }
    });

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
            room.guardedPlayer = data.target; 
        }
        
        if (msg) {
            room.logs.push(msg);
            io.to(room.host).emit('adminLog', msg);
        }
        io.to(data.roomCode).emit('syncPotions', room.witchPotions);
    });

    socket.on('hunterShoot', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            if (data.target) {
                const targetPlayer = room.players.find(p => p.name === data.target);
                if (targetPlayer) {
                    targetPlayer.alive = false;
                    const msg = `💥 砰！獵人開槍帶走了：${data.target}`;
                    room.logs.push(msg);
                    io.to(room.host).emit('adminLog', msg);
                    io.to(targetPlayer.id).emit('youAreDead');
                    io.to(data.roomCode).emit('roomUpdated', room.players);
                    
                    const winMessage = checkWin(data.roomCode);
                    if (winMessage) {
                        room.logs.push(`🏁 ${winMessage}`);
                        io.to(data.roomCode).emit('gameOver', winMessage);
                    }
                }
            } else {
                const msg = `🔫 獵人選擇不開槍 (或被毒死無法發動)`;
                room.logs.push(msg);
                io.to(room.host).emit('adminLog', msg);
            }
        }
    });

    socket.on('killPlayer', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            if (room.guardedPlayer === data.targetName) {
                socket.emit('gameMsg', `🛡️ 系統攔截：【${data.targetName}】昨晚受到守衛保護，已抵銷本次死亡！\n\n(若為白天投票處決，請再點擊一次即可強制執行)`);
                room.guardedPlayer = null; 
                return;
            }

            const targetPlayer = room.players.find(p => p.name === data.targetName);
            if (targetPlayer) {
                targetPlayer.alive = false;
                let msg = `💀 法官宣告死亡：${data.targetName}`;
                
                if (targetPlayer.role === '獵人') {
                    msg += ` (獵人正在準備開槍...)`;
                    const aliveNames = room.players.filter(p => p.alive && p.name !== data.targetName).map(p => p.name);
                    io.to(targetPlayer.id).emit('hunterAction', aliveNames);
                }

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

http.listen(3000, '0.0.0.0');
