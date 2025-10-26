
import io from "https://cdn.socket.io/4.7.5/socket.io.esm.min.js";

const socket = io();

// Patch fetch to always add our socket.id (sid) to /hand calls
const oldFetch = window.fetch;
window.fetch = (url, opts={}) => {
  const u = new URL(url, location.origin);
  if (u.pathname === "/hand") {
    u.searchParams.set("sid", socket.id);
  }
  return oldFetch(u.toString(), opts);
};

const $ = s => document.querySelector(s);
const byId = id => document.getElementById(id);
const state = { code:null, me:null, hostId:null, players:[], started:false, judgeId:null, prompt:null, pointsToWin:7 };

function toast(msg){ const t=byId("toast"); t.textContent=msg; t.classList.add("show"); setTimeout(()=>t.classList.remove("show"),1400); }
function setView({welcome=false,lobby=false,round=false,judge=false,result=false}){
  byId("welcome").classList.toggle("hidden", !welcome);
  byId("lobby").classList.toggle("hidden", !lobby);
  byId("round").classList.toggle("hidden", !round);
  byId("judgeView").classList.toggle("hidden", !judge);
  byId("result").classList.toggle("hidden", !result);
}
function renderPlayers(){
  const el = byId("players");
  const sb = byId("scoreboard");
  el.innerHTML = ""; sb.innerHTML = "";
  state.players.forEach(p => {
    const pill = document.createElement("div");
    pill.className = "pill";
    pill.textContent = `${p.name}${p.id===state.hostId?' ⭐':''}`;
    el.appendChild(pill);
    const score = document.createElement("div");
    score.className = "pill";
    score.textContent = `${p.name}: ${p.score}`;
    sb.appendChild(score);
  });
}
function renderPrompt(){
  const text = (state.prompt?.text || "").replace(/____/g,'<span class="prompt-blank">&nbsp;&nbsp;&nbsp;&nbsp;</span>');
  byId("promptText").innerHTML = text;
}
function updateJudgeTag(){
  const meJudge = state.judgeId === state.me?.id;
  byId("judgeTag").textContent = meJudge ? "Du bist Kurator·in (keine Karte spielen)" : `Kurator·in: ${state.players.find(p=>p.id===state.judgeId)?.name||''}`;
}

byId("hostBtn").onclick = () => {
  const name = byId("name").value || "Gast";
  socket.emit("createRoom", { name });
};
byId("joinBtn").onclick = () => {
  const name = byId("name").value || "Gast";
  const code = (byId("code").value || "").toUpperCase().trim();
  if(!code) return toast("Bitte Code eingeben");
  socket.emit("joinRoom", { code, name });
};
byId("startBtn").onclick = () => {
  if (state.me?.id !== state.hostId) return toast("Nur Host kann starten");
  const pointsToWin = parseInt(byId("points").value, 10);
  socket.emit("startGame", { code: state.code, pointsToWin });
};

socket.on("roomUpdate", (room) => {
  state.code = room.code;
  state.hostId = room.hostId;
  state.players = room.players;
  state.started = room.started;
  state.pointsToWin = room.pointsToWin;
  byId("room-pill").textContent = room.code ? `Raum ${room.code}` : "";
  renderPlayers();
  byId("hostHint").textContent = state.me?.id===state.hostId ? "Du bist Host. Teile den Code & starte das Spiel, wenn alle drin sind." : "Warte bis der Host startet.";
  setView({welcome:false, lobby:!room.started, round:false, judge:false, result:false});
});

socket.on("connect", () => {
  state.me = { id: socket.id, name: byId("name").value || "Ich" };
});

socket.on("errorMsg", (msg)=> toast(msg));

socket.on("newRound", ({ round, judgeId, prompt }) => {
  state.judgeId = judgeId;
  state.prompt = prompt;
  byId("submissionInfo").textContent = "Abgaben: 0";
  byId("judgeChoices").innerHTML = "";
  byId("answers").innerHTML = "";
  renderPrompt();
  updateJudgeTag();
  if (state.judgeId === state.me?.id) {
    setView({ welcome:false, lobby:false, round:true, judge:true, result:false });
  } else {
    setView({ welcome:false, lobby:false, round:true, judge:false, result:false });
  }
  // fetch my hand
  fetch(`/hand?code=${state.code}`).then(r=>r.json()).then(cards => renderHand(cards));
});

socket.on("submissionsCount", (n) => {
  byId("submissionInfo").textContent = `Abgaben: ${n}`;
});

socket.on("allSubmitted", () => {
  if (state.judgeId === state.me?.id) {
    // load choices for judge
    fetch(`/submissions?code=${state.code}`).then(r=>r.json()).then(list => {
      const grid = byId("judgeChoices"); grid.innerHTML = "";
      list.forEach(item => {
        const div = document.createElement("div");
        div.className = "answer tap";
        div.innerHTML = item.card.text;
        div.onclick = () => socket.emit("pickWinner", { code: state.code, playerId: item.playerId });
        grid.appendChild(div);
      });
    });
  }
});

socket.on("roundResult", ({ winnerId, winnerName, card, prompt }) => {
  byId("resultText").textContent = `${winnerName} gewinnt die Runde.`;
  setView({ welcome:false, lobby:false, round:false, judge:false, result:true });
  setTimeout(()=> setView({ welcome:false, lobby:false, round:true, judge: state.judgeId===state.me?.id, result:false }), 1200);
});

socket.on("gameOver", ({ winnerName }) => {
  toast(`Spielende! Sieger: ${winnerName}`);
  setView({welcome:false, lobby:true, round:false, judge:false, result:false});
});

function renderHand(cards){
  const grid = byId("answers");
  grid.innerHTML = "";
  if (state.judgeId === state.me?.id) {
    const div = document.createElement("div");
    div.className = "muted small";
    div.textContent = "Du bist Kurator·in und spielst diese Runde keine Antwort.";
    grid.appendChild(div);
    return;
  }
  cards.forEach(c => {
    const div = document.createElement("div");
    div.className = "answer tap";
    div.innerHTML = c.text;
    div.onclick = () => {
      socket.emit("submitAnswer", { code: state.code, cardId: c.id });
      grid.innerHTML = "<p class='muted small'>Abgegeben. Bitte warten …</p>";
    };
    grid.appendChild(div);
  });
}
