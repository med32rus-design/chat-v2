// ============================================================
//  ЧАТ v2 — улучшенный сервер (Node.js + WebSocket)
//  Запуск:  npm install && npm start
//  Открыть: http://localhost:3000
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ---------- HTTP: раздаём страницу чата ----------
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.mp3':  'audio/mpeg'
};

const server = http.createServer((req, res) => {
    let url = req.url.split('?')[0];
    if (url === '/') url = '/index.html';

    const filePath = path.join(PUBLIC_DIR, path.normalize(url));
    if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403); return res.end('Forbidden');
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('404 — страница не найдена');
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
    });
});

// ---------- WebSocket: живой чат ----------
const wss = new WebSocketServer({ server });

const users = new Map();     // ws -> { name, color, room, id }
const history = new Map();   // room -> [{author, color, text, time, reactions}]
const privateMessages = [];  // [{from, to, text, time}]

const ROOMS = [
    { id: 'general', emoji: '💬', name: 'Общий чат' },
    { id: 'games',   emoji: '🎮', name: 'Игры' },
    { id: 'music',   emoji: '🎵', name: 'Музыка' },
    { id: 'movies',  emoji: '🎬', name: 'Фильмы' },
    { id: 'friends', emoji: '🤝', name: 'Знакомства' }
];

const HISTORY_LIMIT = 100;
const PRIVATE_HISTORY_LIMIT = 50;

function sendTo(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcastRoom(room, obj, exceptWs = null) {
    for (const [client, u] of users) {
        if (u.room === room && client !== exceptWs) sendTo(client, obj);
    }
}

function roomUserList(room) {
    return [...users.values()]
        .filter(u => u.room === room)
        .map(u => ({ name: u.name, color: u.color, id: u.id }));
}

function updateOnlineCount(room) {
    const list = roomUserList(room);
    const obj = { type: 'users', room, users: list };
    for (const [client, u] of users) {
        if (u.room === room) sendTo(client, obj);
    }
    return list.length;
}

function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

wss.on('connection', (ws) => {
    let logged = false;
    let userId = generateId();

    ws.on('message', (raw) => {
        let data;
        try { data = JSON.parse(raw); } catch { return; }

        // ----- вход -----
        if (data.type === 'login' && !logged) {
            const name = String(data.name || '').trim().slice(0, 20);
            const color = normalizeColor(data.color);
            if (name.length < 2) {
                return sendTo(ws, { type: 'error', text: 'Имя слишком короткое' });
            }
            const taken = [...users.values()].some(u => u.name.toLowerCase() === name.toLowerCase());
            if (taken) {
                return sendTo(ws, { type: 'error', text: 'Это имя уже занято, выберите другое' });
            }

            logged = true;
            users.set(ws, { name, color, room: 'general', id: userId });

            sendTo(ws, { type: 'welcome', rooms: ROOMS, history: history.get('general') || [], userId });
            updateOnlineCount('general');
            broadcastRoom('general', {
                type: 'system',
                text: `${name} присоединился к чату 👋`,
                room: 'general'
            }, ws);
            return;
        }

        if (!logged) return;
        const me = users.get(ws);

        // ----- смена комнаты -----
        if (data.type === 'joinRoom') {
            const room = ROOMS.find(r => r.id === data.room);
            if (!room) return;

            const oldRoom = me.room;
            broadcastRoom(oldRoom, {
                type: 'system', room: oldRoom, text: `${me.name} покинул комнату`
            });
            updateOnlineCount(oldRoom);

            me.room = room.id;
            sendTo(ws, { type: 'roomChanged', room: room.id, history: history.get(room.id) || [] });
            updateOnlineCount(room.id);
            broadcastRoom(room.id, {
                type: 'system', room: room.id, text: `${me.name} зашёл в комнату`
            }, ws);
            return;
        }

        // ----- сообщение -----
        if (data.type === 'message') {
            const text = String(data.text || '').trim().slice(0, 1000);
            if (!text) return;

            const msg = {
                author: me.name,
                color: me.color,
                text,
                time: Date.now(),
                reactions: {}
            };

            if (!history.has(me.room)) history.set(me.room, []);
            const h = history.get(me.room);
            h.push(msg);
            if (h.length > HISTORY_LIMIT) h.shift();

            broadcastRoom(me.room, { type: 'message', room: me.room, ...msg });
        }

        // ----- реакция -----
        if (data.type === 'react') {
            const { msgTime, emoji } = data;
            const h = history.get(me.room) || [];
            const msg = h.find(m => m.time === msgTime);
            if (msg) {
                if (!msg.reactions) msg.reactions = {};
                if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
                
                const idx = msg.reactions[emoji].indexOf(me.name);
                if (idx > -1) {
                    msg.reactions[emoji].splice(idx, 1);
                    if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
                } else {
                    msg.reactions[emoji].push(me.name);
                }
                
                broadcastRoom(me.room, { 
                    type: 'reaction', 
                    room: me.room, 
                    msgTime, 
                    reactions: msg.reactions 
                });
            }
        }

        // ----- личное сообщение -----
        if (data.type === 'private') {
            const { to, text } = data;
            const target = [...users.entries()].find(([ws, u]) => u.name === to);
            if (target && text) {
                const pm = {
                    from: me.name,
                    to,
                    text: text.slice(0, 500),
                    time: Date.now()
                };
                privateMessages.push(pm);
                if (privateMessages.length > 200) privateMessages.shift();
                
                sendTo(target[0], { type: 'privateMsg', ...pm });
                sendTo(ws, { type: 'privateMsg', ...pm, sent: true });
            }
        }

        // ----- печатает... -----
        if (data.type === 'typing') {
            broadcastRoom(me.room, {
                type: 'typing', room: me.room, name: me.name
            }, ws);
        }
    });

    ws.on('close', () => {
        if (!logged) return;
        const me = users.get(ws);
        users.delete(ws);
        broadcastRoom(me.room, {
            type: 'system', room: me.room, text: `${me.name} вышел из чата`
        });
        updateOnlineCount(me.room);
    });
});

function normalizeColor(c) {
    return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#6c8cff';
}

server.listen(PORT, () => {
    console.log('=====================================');
    console.log('  ЧАТ v2 — сервер запущен!');
    console.log('=====================================');
    console.log(`  Локально:       http://localhost:${PORT}`);
    console.log('');
    console.log('  Чтобы другие люди могли подключиться:');
    console.log('  1. Узнайте свой IP:  ipconfig (Windows) / ifconfig (Linux/Mac)');
    console.log(`  2. Поделитесь ссылкой:  http://ВАШ_IP:${PORT}`);
    console.log('=====================================');
});
