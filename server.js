const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true }));

const rooms = new Map();
const codeChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function roomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => codeChars[Math.floor(Math.random() * codeChars.length)]).join("");
  } while (rooms.has(code));
  return code;
}
function cleanText(v, max = 500) {
  return String(v ?? "").trim().slice(0, max);
}
function normalizeRef(v) {
  return String(v ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[：:，,。．.、\s]/g, "")
    .replace(/第/g, "")
    .replace(/章/g, ":")
    .replace(/節/g, "");
}
function publicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    hostConnected: room.hostConnected,
    settings: room.settings,
    players: [...room.players.values()]
      .map(p => ({ id: p.id, name: p.name, score: p.score, connected: p.connected }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
    round: room.round ? {
      index: room.round.index,
      total: room.questions.length,
      revealed: room.round.revealed,
      charCount: Array.from(room.round.text).length,
      shownText: Array.from(room.round.text).slice(0, room.round.revealed).join(""),
      ended: room.round.ended,
      winnerName: room.round.winnerName || null,
      answerCount: room.round.answers.length
    } : null,
    questionCount: room.questions.length
  };
}
function emitRoom(room) {
  io.to(room.code).emit("room:update", publicRoom(room));
}
function emitHost(room, event, data) {
  if (room.hostSocket) io.to(room.hostSocket).emit(event, data);
}
function startReveal(room) {
  stopReveal(room);
  if (!room.round || room.round.ended || room.status !== "playing") return;
  room.revealTimer = setInterval(() => {
    if (!room.round || room.round.ended) return stopReveal(room);
    const length = Array.from(room.round.text).length;
    if (room.round.revealed >= length) {
      stopReveal(room);
      return;
    }
    room.round.revealed += 1;
    emitRoom(room);
  }, room.settings.revealMs);
}
function stopReveal(room) {
  if (room.revealTimer) clearInterval(room.revealTimer);
  room.revealTimer = null;
}
function finishRound(room, winnerName = null) {
  if (!room.round || room.round.ended) return;
  room.round.ended = true;
  room.round.winnerName = winnerName;
  stopReveal(room);
  emitRoom(room);
  emitHost(room, "round:answer", {
    answer: room.questions[room.round.index]?.reference || "",
    verse: room.questions[room.round.index]?.text || ""
  });
}
function hostOnly(socket, room, callback) {
  if (!room || room.hostSocket !== socket.id) {
    socket.emit("app:error", "只有房間主持人可以執行這項操作。");
    return false;
  }
  callback();
  return true;
}

io.on("connection", socket => {
  socket.on("room:create", (payload = {}, ack = () => {}) => {
    const code = roomCode();
    const maxPlayers = Math.max(2, Math.min(100, Number(payload.maxPlayers) || 20));
    const room = {
      code, hostSocket: socket.id, hostConnected: true,
      status: "lobby",
      settings: {
        maxPlayers,
        revealMs: Math.max(100, Math.min(3000, Number(payload.revealMs) || 650)),
        points: Math.max(1, Math.min(100, Number(payload.points) || 10))
      },
      players: new Map(), questions: [], round: null, revealTimer: null
    };
    rooms.set(code, room);
    socket.join(code);
    ack({ ok: true, code, room: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("room:join", (payload = {}, ack = () => {}) => {
    const code = cleanText(payload.code, 8).toUpperCase();
    const name = cleanText(payload.name, 24);
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: "找不到這個房間，請確認遊戲代碼。" });
    if (!name) return ack({ ok: false, error: "請先輸入玩家暱稱。" });
    if (room.status !== "lobby" && ![...room.players.values()].some(p => p.id === socket.id))
      return ack({ ok: false, error: "這場遊戲已經開始，暫時不能加入。" });
    let player = [...room.players.values()].find(p => p.id === socket.id);
    if (!player && room.players.size >= room.settings.maxPlayers)
      return ack({ ok: false, error: "房間人數已滿，請請主持人增加人數。" });
    if (!player) {
      const duplicate = [...room.players.values()].some(p => p.name.toLowerCase() === name.toLowerCase() && p.connected);
      if (duplicate) return ack({ ok: false, error: "這個暱稱已有人使用，請換一個。" });
      player = { id: socket.id, name, score: 0, connected: true };
      room.players.set(socket.id, player);
    } else {
      player.name = name;
      player.connected = true;
    }
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = socket.id;
    ack({ ok: true, room: publicRoom(room), playerId: socket.id });
    emitRoom(room);
  });

  socket.on("host:configure", (payload = {}, ack = () => {}) => {
    const room = rooms.get(cleanText(payload.code, 8).toUpperCase());
    hostOnly(socket, room, () => {
      room.settings.maxPlayers = Math.max(room.players.size || 2, Math.min(100, Number(payload.maxPlayers) || 20));
      room.settings.revealMs = Math.max(100, Math.min(3000, Number(payload.revealMs) || 650));
      room.settings.points = Math.max(1, Math.min(100, Number(payload.points) || 10));
      if (ack) ack({ ok: true });
      emitRoom(room);
    });
  });

  socket.on("host:questions", (payload = {}, ack = () => {}) => {
    const room = rooms.get(cleanText(payload.code, 8).toUpperCase());
    hostOnly(socket, room, () => {
      const questions = Array.isArray(payload.questions) ? payload.questions.slice(0, 100).map(q => ({
        text: cleanText(q.text, 1000),
        reference: cleanText(q.reference, 120),
        aliases: cleanText(q.aliases, 300)
      })).filter(q => q.text && q.reference) : [];
      if (!questions.length) return ack({ ok: false, error: "請至少新增一題，並填寫經文內容與正確出處。" });
      room.questions = questions;
      room.status = "lobby";
      room.round = null;
      room.players.forEach(p => p.score = 0);
      ack({ ok: true, count: questions.length });
      emitRoom(room);
    });
  });

  socket.on("host:start", (payload = {}, ack = () => {}) => {
    const room = rooms.get(cleanText(payload.code, 8).toUpperCase());
    hostOnly(socket, room, () => {
      if (!room.questions.length) return ack({ ok: false, error: "請先在題庫新增題目。" });
      room.status = "playing";
      room.round = { index: 0, text: room.questions[0].text, revealed: 0, ended: false, winnerName: null, answers: [] };
      ack({ ok: true });
      emitRoom(room);
      startReveal(room);
    });
  });

  socket.on("host:next", (payload = {}, ack = () => {}) => {
    const room = rooms.get(cleanText(payload.code, 8).toUpperCase());
    hostOnly(socket, room, () => {
      if (room.status !== "playing" || !room.round) return ack({ ok: false, error: "目前沒有進行中的遊戲。" });
      const next = room.round.index + 1;
      if (next >= room.questions.length) {
        room.status = "finished";
        finishRound(room);
        emitRoom(room);
        return ack({ ok: true, finished: true });
      }
      room.round = { index: next, text: room.questions[next].text, revealed: 0, ended: false, winnerName: null, answers: [] };
      ack({ ok: true });
      emitRoom(room);
      startReveal(room);
    });
  });

  socket.on("host:reveal-all", (payload = {}) => {
    const room = rooms.get(cleanText(payload.code, 8).toUpperCase());
    hostOnly(socket, room, () => {
      if (!room.round || room.round.ended) return;
      room.round.revealed = Array.from(room.round.text).length;
      emitRoom(room);
    });
  });

  socket.on("player:answer", (payload = {}, ack = () => {}) => {
    const code = cleanText(payload.code, 8).toUpperCase();
    const room = rooms.get(code);
    const player = room?.players.get(socket.id);
    if (!room || !player) return ack({ ok: false, error: "請先加入遊戲房間。" });
    if (room.status !== "playing" || !room.round || room.round.ended) return ack({ ok: false, error: "這題已結束，請等候下一題。" });
    const answer = cleanText(payload.answer, 120);
    if (!answer) return ack({ ok: false, error: "請輸入經節出處。" });
    const q = room.questions[room.round.index];
    const accepted = [q.reference, ...(q.aliases ? q.aliases.split(/[;,，；]/).map(x => x.trim()) : [])].filter(Boolean);
    const normalized = normalizeRef(answer);
    const correct = accepted.some(ref => normalizeRef(ref) === normalized);
    room.round.answers.push({ playerId: player.id, answer, correct, at: Date.now() });
    if (!correct) {
      ack({ ok: true, correct: false, message: "再想一想！出處格式可輸入「約翰福音 3:16」。" });
      emitHost(room, "answer:activity", { playerName: player.name, correct: false });
      return;
    }
    player.score += room.settings.points;
    ack({ ok: true, correct: true, message: `答對了！+${room.settings.points} 分` });
    emitHost(room, "answer:activity", { playerName: player.name, correct: true });
    finishRound(room, player.name);
  });

  socket.on("host:reset", (payload = {}, ack = () => {}) => {
    const room = rooms.get(cleanText(payload.code, 8).toUpperCase());
    hostOnly(socket, room, () => {
      stopReveal(room);
      room.status = "lobby";
      room.round = null;
      room.players.forEach(p => p.score = 0);
      ack({ ok: true });
      emitRoom(room);
    });
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      if (room.hostSocket === socket.id) {
        room.hostConnected = false;
        emitRoom(room);
      }
      const player = room.players.get(socket.id);
      if (player) {
        player.connected = false;
        emitRoom(room);
      }
    }
  });
});

server.listen(PORT, () => console.log(`Bible Quiz Live running on http://localhost:${PORT}`));
