
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { customAlphabet } from "nanoid";
import path from "path";
import fs from "fs";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

const __dirnameResolved = path.resolve();
app.use(express.json());
app.use(express.static(path.join(__dirnameResolved, "public")));

const nanoid = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4);

const ROOMS = new Map(); // code -> room state

function loadDeck() {
  const prompts = JSON.parse(fs.readFileSync(path.join(__dirnameResolved, "data", "prompts.json"), "utf-8"));
  const answers = JSON.parse(fs.readFileSync(path.join(__dirnameResolved, "data", "answers.json"), "utf-8"));
  return { prompts, answers };
}

function draw(arr) {
  if (arr.length === 0) return null;
  const idx = Math.floor(Math.random() * arr.length);
  const [card] = arr.splice(idx, 1);
  return card;
}

function dealAnswers(room, playerId, count=7) {
  room.hands[playerId] = room.hands[playerId] || [];
  while (room.hands[playerId].length < count && room.answerDeck.length > 0) {
    room.hands[playerId].push(draw(room.answerDeck));
  }
}

// ---- Helper endpoints (used by the client) ----
app.get("/hand", (req, res) => {
  const code = String(req.query.code||"");
  const sid = String(req.query.sid || "");
  const room = ROOMS.get(code);
  if(!room || !sid) return res.json([]);
  const hand = room.hands[sid] || [];
  res.json(hand);
});

app.get("/submissions", (req, res) => {
  const code = String(req.query.code||"");
  const room = ROOMS.get(code);
  if(!room) return res.json([]);
  res.json(room.submissions.map(s => ({ playerId: s.playerId, card: s.card })));
});
// ------------------------------------------------

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name }) => {
    const code = nanoid();
    const { prompts, answers } = loadDeck();
    const room = {
      code,
      hostId: socket.id,
      players: {},
      order: [],
      judgeIndex: 0,
      promptsDiscard: [],
      answersDiscard: [],
      promptDeck: [...prompts],
      answerDeck: [...answers],
      hands: {},
      submissions: [],
      round: 0,
      started: false,
      pointsToWin: 7,
      mode: "office"
    };
    ROOMS.set(code, room);
    room.players[socket.id] = { id: socket.id, name: name?.trim()?.slice(0,20) || "Gast", score: 0 };
    room.order.push(socket.id);
    socket.join(code);
    io.to(code).emit("roomUpdate", publicRoom(room));
  });

  socket.on("joinRoom", ({ code, name }) => {
    const room = ROOMS.get(String(code || "").toUpperCase());
    if (!room) return socket.emit("errorMsg", "Raum nicht gefunden.");
    if (room.started && !room.players[socket.id]) {
      return socket.emit("errorMsg", "Spiel hat bereits begonnen.");
    }
    room.players[socket.id] = { id: socket.id, name: name?.trim()?.slice(0,20) || "Gast", score: 0 };
    room.order.push(socket.id);
    socket.join(room.code);
    io.to(room.code).emit("roomUpdate", publicRoom(room));
  });

  socket.on("startGame", ({ code, pointsToWin }) => {
    const room = ROOMS.get(code);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (room.started) return;
    room.pointsToWin = Math.max(3, Math.min(15, pointsToWin || 7));
    room.started = true;
    // deal initial hands
    for (const pid of room.order) {
      dealAnswers(room, pid, 7);
    }
    startRound(room);
  });

  socket.on("submitAnswer", ({ code, cardId }) => {
    const room = ROOMS.get(code);
    if (!room || !room.started) return;
    const judgeId = room.order[room.judgeIndex % room.order.length];
    if (socket.id === judgeId) return; // judge cannot submit
    const hand = room.hands[socket.id] || [];
    const idx = hand.findIndex(c => c.id === cardId);
    if (idx === -1) return;
    const [card] = hand.splice(idx, 1);
    room.submissions.push({ playerId: socket.id, card });
    io.to(code).emit("submissionsCount", room.submissions.length);
    // auto-advance if all non-judge players submitted
    const expected = room.order.length - 1;
    if (room.submissions.length >= expected) {
      io.to(code).emit("allSubmitted", true);
    }
  });

  socket.on("pickWinner", ({ code, playerId }) => {
    const room = ROOMS.get(code);
    if (!room || !room.started) return;
    const judgeId = room.order[room.judgeIndex % room.order.length];
    if (socket.id !== judgeId) return;
    const winner = room.players[playerId];
    if (!winner) return;
    winner.score += 1;
    io.to(code).emit("roundResult", { winnerId: winner.id, winnerName: winner.name, card: room.submissions.find(s=>s.playerId===playerId)?.card, prompt: room.currentPrompt });
    // replenish hands
    for (const s of room.submissions) {
      room.answersDiscard.push(s.card);
      dealAnswers(room, s.playerId, 7);
    }
    room.submissions = [];
    // check victory
    const maxScore = Math.max(...Object.values(room.players).map(p=>p.score));
    if (maxScore >= room.pointsToWin) {
      io.to(code).emit("gameOver", { winnerId: winner.id, winnerName: winner.name });
      room.started = false;
      return;
    }
    setTimeout(() => startRound(room), 600);
  });

  socket.on("changeMode", ({ code, mode }) => {
    const room = ROOMS.get(code);
    if (!room || socket.id !== room.hostId) return;
    room.mode = mode === "open" ? "open" : "office";
    io.to(code).emit("roomUpdate", publicRoom(room));
  });

  socket.on("disconnecting", () => {
    for (const code of socket.rooms) {
      if (ROOMS.has(code)) {
        const room = ROOMS.get(code);
        delete room.players[socket.id];
        room.order = room.order.filter(id => id !== socket.id);
        if (room.order.length === 0) {
          ROOMS.delete(code);
        } else {
          if (socket.id === room.hostId) {
            room.hostId = room.order[0];
          }
          io.to(code).emit("roomUpdate", publicRoom(room));
        }
      }
    }
  });
});

function startRound(room) {
  room.round += 1;
  // rotate judge
  room.judgeIndex = room.round === 1 ? 0 : (room.judgeIndex + 1) % room.order.length;
  // draw prompt
  if (room.promptDeck.length === 0) {
    room.promptDeck = room.promptsDiscard.splice(0);
  }
  const prompt = draw(room.promptDeck);
  room.currentPrompt = prompt;
  // notify clients
  io.to(room.code).emit("newRound", { 
    round: room.round, 
    judgeId: room.order[room.judgeIndex], 
    prompt 
  });
  io.to(room.code).emit("submissionsCount", 0);
}

function publicRoom(room) {
  const players = Object.values(room.players).map(p => ({ id: p.id, name: p.name, score: p.score }));
  return {
    code: room.code,
    hostId: room.hostId,
    players,
    started: room.started,
    pointsToWin: room.pointsToWin,
    mode: room.mode
  };
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Prompts against Mediocrity läuft auf http://localhost:${PORT}`);
});
