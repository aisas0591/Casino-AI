
"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const START_BALANCE = 1000;
const MAX_PLAYERS = 6;

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

function shuffle() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = [
    "A", "2", "3", "4", "5", "6", "7",
    "8", "9", "10", "J", "Q", "K"
  ];

  const deck = [];

  for (let shoe = 0; shoe < 6; shoe++) {
    for (const suit of suits) {
      for (const rank of ranks) {
        deck.push({ rank, suit });
      }
    }
  }

  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

function score(cards) {
  let total = 0;
  let aces = 0;

  for (const card of cards) {
    if (card.rank === "A") {
      total += 11;
      aces++;
    } else if (["J", "Q", "K"].includes(card.rank)) {
      total += 10;
    } else {
      total += Number(card.rank);
    }
  }

  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }

  return total;
}

function blackjack(cards) {
  return cards.length === 2 && score(cards) === 21;
}

function draw(room) {
  if (!room.deck.length) room.deck = shuffle();
  return room.deck.pop();
}

function roomCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const code = roomCode();

  const room = {
    code,
    host: null,
    players: new Map(),
    phase: "betting",
    deck: shuffle(),
    dealer: [],
    turnOrder: [],
    turnIndex: 0,
    round: 0,
    history: []
  };

  rooms.set(code, room);
  return room;
}

function publicState(room, viewerId) {
  const activeId = room.turnOrder[room.turnIndex] || null;

  return {
    code: room.code,
    host: room.host,
    phase: room.phase,
    round: room.round,
    activeId,
    viewerId,
    dealer: room.phase === "betting"
      ? []
      : room.phase === "playing"
        ? [room.dealer[0], null]
        : room.dealer,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      balance: p.balance,
      bet: p.bet,
      cards: p.cards,
      score: score(p.cards),
      status: p.status,
      wins: p.wins,
      streak: p.streak,
      connected: p.connected
    })),
    history: room.history
  };
}

function broadcast(room) {
  for (const player of room.players.values()) {
    if (player.socketId) {
      io.to(player.socketId).emit(
        "room:state",
        publicState(room, player.id)
      );
    }
  }
}

function notify(socket, message) {
  socket.emit("game:error", message);
}

function getContext(socket) {
  const code = socket.data.code;
  const id = socket.data.playerId;
  const room = rooms.get(code);
  const player = room?.players.get(id);

  return { room, player };
}

function settle(room) {
  room.phase = "finished";

  const dealerScore = score(room.dealer);
  const dealerBJ = blackjack(room.dealer);
  const results = [];

  for (const player of room.players.values()) {
    if (player.bet <= 0) continue;

    const wager = player.bet;
    const playerScore = score(player.cards);
    const playerBJ = blackjack(player.cards);

    let result;
    let payout = 0;

    if (player.status === "bust") {
      result = "loss";
    } else if (playerBJ && !dealerBJ) {
      result = "blackjack";
      payout = wager * 2.5;
    } else if (dealerBJ && !playerBJ) {
      result = "loss";
    } else if (playerBJ && dealerBJ) {
      result = "push";
      payout = wager;
    } else if (dealerScore > 21 || playerScore > dealerScore) {
      result = "win";
      payout = wager * 2;
    } else if (playerScore === dealerScore) {
      result = "push";
      payout = wager;
    } else {
      result = "loss";
    }

    player.balance += payout;
    player.status = result;

    if (result === "win" || result === "blackjack") {
      player.wins++;
      player.streak++;
    } else if (result === "loss") {
      player.streak = 0;
    }

    results.push({
      name: player.name,
      result,
      profit: payout - wager
    });
  }

  room.history.unshift({
    round: room.round,
    dealerScore,
    results
  });

  room.history = room.history.slice(0, 10);
  broadcast(room);
}

function finishDealer(room) {
  room.phase = "dealer";
  broadcast(room);

  // El crupier se planta en 17, incluido 17 suave.
  while (score(room.dealer) < 17) {
    room.dealer.push(draw(room));
  }

  settle(room);
}

function advanceTurn(room) {
  room.turnIndex++;

  while (room.turnIndex < room.turnOrder.length) {
    const id = room.turnOrder[room.turnIndex];
    const player = room.players.get(id);

    if (player && player.status === "playing") {
      broadcast(room);
      return;
    }

    room.turnIndex++;
  }

  finishDealer(room);
}

function beginRound(room) {
  if (room.phase !== "betting" && room.phase !== "finished") {
    return false;
  }

  const participants = Array.from(room.players.values())
    .filter(p => p.bet > 0 && p.connected);

  if (!participants.length) return false;

  room.deck = shuffle();
  room.dealer = [];
  room.round++;
  room.phase = "playing";
  room.turnOrder = participants.map(p => p.id);
  room.turnIndex = 0;

  for (const p of room.players.values()) {
    p.cards = [];
    p.status = p.bet > 0 && p.connected
      ? "playing"
      : "waiting";
  }

  // Reparto alternado, dos cartas por jugador.
  for (let i = 0; i < 2; i++) {
    for (const p of participants) {
      p.cards.push(draw(room));
    }
    room.dealer.push(draw(room));
  }

  if (
    blackjack(room.dealer) ||
    participants.every(p => blackjack(p.cards))
  ) {
    settle(room);
    return true;
  }

  for (const p of participants) {
    if (blackjack(p.cards)) p.status = "stand";
  }

  while (
    room.turnIndex < room.turnOrder.length &&
    room.players.get(room.turnOrder[room.turnIndex])
      ?.status !== "playing"
  ) {
    room.turnIndex++;
  }

  if (room.turnIndex >= room.turnOrder.length) {
    finishDealer(room);
  } else {
    broadcast(room);
  }

  return true;
}

io.on("connection", socket => {

  socket.on("room:create", (name, callback) => {
    if (socket.data.code) return;

    const room = createRoom();
    joinRoom(socket, room, name, callback);
  });

  socket.on("room:join", ({ code, name, token }, callback) => {
    if (socket.data.code) return;

    const room = rooms.get(String(code || "").toUpperCase());

    if (!room) {
      return callback?.({ ok: false, error: "Sala inexistente." });
    }

    joinRoom(socket, room, name, callback, token);
  });

  function joinRoom(socket, room, name, callback, token) {
    name = String(name || "Jugador").trim().slice(0, 20);

    let player = token
      ? Array.from(room.players.values())
          .find(p => p.token === token)
      : null;

    if (player && player.connected) {
      return callback?.({
        ok: false,
        error: "Esta sesión ya está conectada."
      });
    }

    if (!player) {
      if (room.players.size >= MAX_PLAYERS) {
        return callback?.({
          ok: false,
          error: "La sala está llena."
        });
      }

      const id = crypto.randomUUID();
      const newToken = crypto.randomBytes(24).toString("hex");

      player = {
        id,
        token: newToken,
        name,
        socketId: null,
        connected: false,
        balance: START_BALANCE,
        bet: 0,
        cards: [],
        status: "waiting",
        wins: 0,
        streak: 0
      };

      room.players.set(id, player);

      if (!room.host) room.host = id;
    }

    player.socketId = socket.id;
    player.connected = true;

    socket.data.code = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);

    callback?.({
      ok: true,
      code: room.code,
      token: player.token,
      playerId: player.id
    });

    broadcast(room);
  }

  socket.on("bet:place", amount => {
    const { room, player } = getContext(socket);
    if (!room || !player) return;

    if (!["betting", "finished"].includes(room.phase)) {
      return notify(socket, "No puedes apostar durante una mano.");
    }

    amount = Number(amount);

    if (
      !Number.isInteger(amount) ||
      ![10, 50, 100, 500].includes(amount) ||
      amount > player.balance
    ) {
      return notify(socket, "Apuesta inválida.");
    }

    // Cuando inicia una nueva ronda se borran
    // las apuestas anteriores al primer depósito.
    if (room.phase === "finished") {
      room.phase = "betting";

      for (const p of room.players.values()) {
        p.bet = 0;
        p.cards = [];
        p.status = "waiting";
      }

      room.dealer = [];
    }

    player.balance -= amount;
    player.bet += amount;

    broadcast(room);
  });

  socket.on("bet:clear", () => {
    const { room, player } = getContext(socket);
    if (!room || !player || room.phase !== "betting") return;

    player.balance += player.bet;
    player.bet = 0;

    broadcast(room);
  });

  socket.on("round:start", () => {
    const { room, player } = getContext(socket);
    if (!room || !player) return;

    if (room.host !== player.id) {
      return notify(socket, "Solo el anfitrión inicia la ronda.");
    }

    if (!beginRound(room)) {
      notify(socket, "No hay apuestas listas.");
    }
  });

  socket.on("player:action", action => {
    const { room, player } = getContext(socket);
    if (!room || !player) return;

    if (
      room.phase !== "playing" ||
      room.turnOrder[room.turnIndex] !== player.id ||
      player.status !== "playing"
    ) {
      return notify(socket, "No es tu turno.");
    }

    if (action === "hit") {
      player.cards.push(draw(room));

      if (score(player.cards) > 21) {
        player.status = "bust";
        advanceTurn(room);
      } else if (score(player.cards) === 21) {
        player.status = "stand";
        advanceTurn(room);
      } else {
        broadcast(room);
      }

    } else if (action === "stand") {
      player.status = "stand";
      advanceTurn(room);

    } else if (action === "double") {
      if (
        player.cards.length !== 2 ||
        player.balance < player.bet
      ) {
        return notify(socket, "No puedes doblar.");
      }

      player.balance -= player.bet;
      player.bet *= 2;
      player.cards.push(draw(room));

      player.status = score(player.cards) > 21
        ? "bust"
        : "stand";

      advanceTurn(room);
    }
  });

  socket.on("disconnect", () => {
    const { room, player } = getContext(socket);
    if (!room || !player) return;

    player.connected = false;
    player.socketId = null;

    if (room.phase === "playing" && player.status === "playing") {
      player.status = "stand";

      if (room.turnOrder[room.turnIndex] === player.id) {
        advanceTurn(room);
      }
    }

    if (room.host === player.id) {
      const nextHost = Array.from(room.players.values())
        .find(p => p.connected);

      if (nextHost) room.host = nextHost.id;
    }

    broadcast(room);
  });

});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", rooms: rooms.size });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Blackjack Royale activo en puerto ${PORT}`);
});
