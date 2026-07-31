const express = require('express');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// Was hardcoded, in a public repo. Set ADMIN_PASSWORD in the Vercel dashboard;
// the fallback only exists so local dev still runs.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'mutti123';
const STARTING_TAKA = 1000;
const STATE_KEY = 'muttitaharat:state';

const EVENTS = [
  { id: 'mutti', name: 'Mutti Mari', emoji: '🍆' },
  { id: 'gay', name: 'Gay Ass Joke', emoji: '🌈' },
  { id: 'pedo', name: 'Pedo Joke', emoji: '👶' },
  { id: 'jork', name: "Starts jorkin it due to tutlami", emoji: '👋' },
];

const TIME_WINDOWS = [
  { label: '2 min', minutes: 2, multiplier: 10 },
  { label: '5 min', minutes: 5, multiplier: 5 },
  { label: '10 min', minutes: 10, multiplier: 3 },
  { label: '20 min', minutes: 20, multiplier: 1.5 },
];

const SHOP_ITEMS = [
  { id: 'forceBet', name: 'Force Bet', price: 15000, emoji: '💣', desc: 'Forces every user to bet 50% of their Taka on Mutti Mari at 10x in 2 min.' },
  { id: 'eventLog', name: 'Event Log', price: 2000, emoji: '📋', desc: 'Unlocks a full log of every confirmed event with date and time.' },
  { id: 'tasniaNumber', name: "Tasnia's Number", price: 40000, emoji: '📱', desc: "You know what this is." },
  { id: 'gallery', name: 'Taharat or Lengta Sobi', price: 50000, emoji: '📸', desc: 'Unlocks the full collection. You have been warned.' },
];

function hash(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }

/*
 * Storage.
 *
 * This used to be a data.json on disk, which cannot work on Vercel — the
 * filesystem is per-invocation, so every bet and balance would vanish. State
 * now lives in Upstash Redis.
 *
 * The routes below are untouched: they still call loadData()/saveData()
 * synchronously. A per-request middleware hydrates the state before the
 * handler runs and flushes it before the response goes out, so none of the
 * game logic had to be rewritten to be async.
 */
/** In-memory stand-in so `npm start` works without Upstash credentials. */
function memoryStore() {
  let value = null;
  console.warn('No UPSTASH_REDIS_REST_URL set — using in-memory storage. State will not survive a restart.');
  return {
    get: async () => value,
    set: async (_key, v) => {
      value = v;
    },
  };
}

const redis = process.env.UPSTASH_REDIS_REST_URL ? Redis.fromEnv() : memoryStore();
const EMPTY = { users: {}, bets: [], feed: [], eventLog: [] };

let state = null;
let dirty = false;

function loadData() { return state; }
function saveData(data) { state = data; dirty = true; }

app.use(async (req, res, next) => {
  try {
    state = (await redis.get(STATE_KEY)) || structuredClone(EMPTY);
  } catch (err) {
    console.error('redis read failed', err);
    return res.status(503).json({ error: 'Storage unavailable, try again' });
  }
  dirty = false;

  // Flush before responding. On serverless the process can freeze the moment
  // the response is sent, so a fire-and-forget write would be lost.
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    if (!dirty) return sendJson(body);
    redis
      .set(STATE_KEY, state)
      .then(() => sendJson(body))
      .catch((err) => {
        console.error('redis write failed', err);
        sendJson({ error: 'Could not save, try again' });
      });
    return res;
  };

  next();
});

// Auth
app.post('/api/register', (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Name and password required' });
  const cleanName = name.trim();
  const data = loadData();
  if (data.users[cleanName]) return res.status(400).json({ error: 'Username taken' });
  data.users[cleanName] = { taka: STARTING_TAKA, password: hash(password), purchases: [], notifications: [] };
  data.feed.push({ text: `🆕 ${cleanName} joined with ৳1000`, time: Date.now() });
  saveData(data);
  res.json({ success: true, user: { name: cleanName, taka: STARTING_TAKA, purchases: [], notifications: [] } });
});

app.post('/api/login', (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Name and password required' });
  const data = loadData();
  const user = data.users[name.trim()];
  if (!user) return res.status(400).json({ error: 'User not found' });
  if (user.password !== hash(password)) return res.status(400).json({ error: 'Wrong password' });
  res.json({ success: true, user: { name: name.trim(), taka: user.taka, purchases: user.purchases || [], notifications: user.notifications || [] } });
});

// State
app.get('/api/state', (req, res) => {
  const data = loadData();
  const safeUsers = {};
  Object.keys(data.users).forEach(u => {
    safeUsers[u] = { taka: data.users[u].taka, purchases: data.users[u].purchases || [] };
  });
  /*
   * Expiry is derived here rather than trusted from stored state. A bet is only
   * flipped to 'lost' by /api/tick, which is client-driven — so with nobody's
   * browser open, expired bets keep reporting as 'active' and the board lies.
   *
   * Payouts were never affected: /api/resolve re-checks expiresAt before paying
   * out. This is about the board telling the truth without needing a poller.
   */
  const nowTs = Date.now();
  const bets = data.bets.map((bet) =>
    bet.status === 'active' && bet.expiresAt <= nowTs ? { ...bet, status: 'lost' } : bet,
  );

  res.json({ users: safeUsers, bets, events: EVENTS, timeWindows: TIME_WINDOWS, feed: data.feed.slice(-15), shopItems: SHOP_ITEMS, eventLog: data.eventLog || [] });
});

// Get notifications for a user
app.get('/api/notifications/:name', (req, res) => {
  const data = loadData();
  const user = data.users[req.params.name];
  if (!user) return res.status(400).json({ error: 'User not found' });
  const notifs = user.notifications || [];
  // Clear after reading
  data.users[req.params.name].notifications = [];
  saveData(data);
  res.json({ notifications: notifs });
});

// Place a bet
app.post('/api/bet', (req, res) => {
  const { userName, eventId, timeWindowIndex, wager, customName } = req.body;
  const data = loadData();
  if (!data.users[userName]) return res.status(400).json({ error: 'User not found' });
  const w = parseInt(wager);
  if (!w || w <= 0) return res.status(400).json({ error: 'Invalid wager amount' });
  if (data.users[userName].taka < w) return res.status(400).json({ error: `Not enough Taka! You have ৳${data.users[userName].taka}` });
  const timeWindow = TIME_WINDOWS[timeWindowIndex];
  if (!timeWindow) return res.status(400).json({ error: 'Invalid time window' });

  let event;
  if (eventId === 'custom') {
    if (!customName || customName.trim().length < 1) return res.status(400).json({ error: 'Custom event name required' });
    event = { id: 'custom', name: customName.trim(), emoji: '🎯' };
  } else {
    event = EVENTS.find(e => e.id === eventId);
    if (!event) return res.status(400).json({ error: 'Invalid event' });
  }

  data.users[userName].taka -= w;
  const now = Date.now();
  const bet = {
    id: now.toString() + Math.random().toString(36).slice(2),
    userName, eventId, eventName: event.name, eventEmoji: event.emoji,
    customName: eventId === 'custom' ? customName.trim() : null,
    timeWindowLabel: timeWindow.label, minutes: timeWindow.minutes,
    multiplier: timeWindow.multiplier, wager: w,
    potentialWin: Math.floor(w * timeWindow.multiplier),
    placedAt: now, expiresAt: now + timeWindow.minutes * 60 * 1000, status: 'active',
  };
  data.bets.push(bet);
  data.feed.push({ text: `🎰 ${userName} bet ৳${w} on "${event.name}" within ${timeWindow.label} (${timeWindow.multiplier}x)`, time: now });
  saveData(data);
  res.json({ success: true, bet, newTaka: data.users[userName].taka });
});

// Resolve standard event
app.post('/api/resolve', (req, res) => {
  const { password, eventId } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Wrong password lmao' });
  const data = loadData();
  const now = Date.now();

  let eventName;
  if (eventId === 'custom') return res.status(400).json({ error: 'Use /api/resolve-custom for custom bets' });
  const event = EVENTS.find(e => e.id === eventId);
  if (!event) return res.status(400).json({ error: 'Invalid event' });
  eventName = event.name;

  let winners = 0, losers = 0;
  data.bets = data.bets.map(bet => {
    if (bet.eventId === eventId && bet.status === 'active') {
      if (bet.expiresAt > now) {
        data.users[bet.userName].taka += bet.potentialWin;
        winners++;
        return { ...bet, status: 'won' };
      } else { losers++; return { ...bet, status: 'lost' }; }
    }
    return bet;
  });

  data.eventLog = data.eventLog || [];
  data.eventLog.push({ eventId, eventName, time: now });
  data.feed.push({ text: `💀 IT HAPPENED: "${eventName}"! ${winners} winners paid out, ${losers} rekt.`, time: now });
  saveData(data);
  res.json({ success: true, winners, losers });
});

// Resolve custom bet by bet ID
app.post('/api/resolve-custom', (req, res) => {
  const { password, betId } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Wrong password' });
  const data = loadData();
  const now = Date.now();
  let winners = 0, losers = 0;
  data.bets = data.bets.map(bet => {
    if (bet.id === betId && bet.status === 'active') {
      if (bet.expiresAt > now) {
        data.users[bet.userName].taka += bet.potentialWin;
        winners++;
        return { ...bet, status: 'won' };
      } else { losers++; return { ...bet, status: 'lost' }; }
    }
    return bet;
  });
  const resolvedBet = data.bets.find(b => b.id === betId);
  data.eventLog = data.eventLog || [];
  data.eventLog.push({ eventId: 'custom', eventName: resolvedBet?.eventName || 'Custom', time: now });
  data.feed.push({ text: `💀 IT HAPPENED: "${resolvedBet?.eventName}"! ${winners} winners paid, ${losers} rekt.`, time: now });
  saveData(data);
  res.json({ success: true, winners, losers });
});

// Shop purchase
app.post('/api/shop/buy', (req, res) => {
  const { userName, itemId } = req.body;
  const data = loadData();
  const user = data.users[userName];
  if (!user) return res.status(400).json({ error: 'User not found' });
  const item = SHOP_ITEMS.find(i => i.id === itemId);
  if (!item) return res.status(400).json({ error: 'Invalid item' });
  if (user.taka < item.price) return res.status(400).json({ error: `Not enough Taka! Need ৳${item.price}` });

  if (itemId === 'eventLog') {
    if ((user.purchases || []).includes('eventLog')) return res.status(400).json({ error: 'Already purchased' });
    user.taka -= item.price;
    user.purchases = [...(user.purchases || []), 'eventLog'];
    data.feed.push({ text: `🛒 ${userName} bought Event Log access`, time: Date.now() });
    saveData(data);
    return res.json({ success: true, newTaka: user.taka, purchases: user.purchases });
  }

  if (itemId === 'tasniaNumber') {
    if ((user.purchases || []).includes('tasniaNumber')) return res.status(400).json({ error: 'Already purchased' });
    user.taka -= item.price;
    user.purchases = [...(user.purchases || []), 'tasniaNumber'];
    data.feed.push({ text: `📱 ${userName} spent ৳40,000... you know why 👀`, time: Date.now() });
    saveData(data);
    return res.json({ success: true, newTaka: user.taka, purchases: user.purchases, reveal: '+880 1711-967041' });
  }

  if (itemId === 'gallery') {
    if ((user.purchases || []).includes('gallery')) return res.status(400).json({ error: 'Already purchased' });
    user.taka -= item.price;
    user.purchases = [...(user.purchases || []), 'gallery'];
    data.feed.push({ text: `📸 ${userName} bought Taharat or Lengta Sobi 👀`, time: Date.now() });
    saveData(data);
    return res.json({ success: true, newTaka: user.taka, purchases: user.purchases });
  }

  if (itemId === 'forceBet') {
    user.taka -= item.price;
    const now = Date.now();
    let count = 0;
    Object.keys(data.users).forEach(uName => {
      if (uName === userName) return;
      const target = data.users[uName];
      const wager = Math.floor(target.taka * 0.5);
      if (wager <= 0) return;
      target.taka -= wager;
      const bet = {
        id: now.toString() + Math.random().toString(36).slice(2) + count,
        userName: uName, eventId: 'mutti', eventName: 'Mutti Mari', eventEmoji: '🍆',
        customName: null, timeWindowLabel: '2 min', minutes: 2, multiplier: 10,
        wager, potentialWin: wager * 10,
        placedAt: now, expiresAt: now + 2 * 60 * 1000, status: 'active',
        forced: true,
      };
      data.bets.push(bet);
      target.notifications = target.notifications || [];
      target.notifications.push({ text: `💣 ${userName} used Force Bet on you! ৳${wager} has been placed on Mutti Mari at 10x in 2 min. Good luck.`, time: now });
      count++;
    });
    data.feed.push({ text: `💣 ${userName} activated FORCE BET on ${count} players 😈`, time: now });
    saveData(data);
    return res.json({ success: true, newTaka: user.taka, affected: count });
  }
});

// Tick
app.post('/api/tick', (req, res) => {
  const data = loadData();
  const now = Date.now();
  data.bets = data.bets.map(bet => bet.status === 'active' && bet.expiresAt <= now ? { ...bet, status: 'lost' } : bet);
  saveData(data);
  res.json({ success: true });
});

// Reset
app.post('/api/reset', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Wrong password' });
  const data = loadData();
  data.bets = [];
  Object.keys(data.users).forEach(u => {
    data.users[u].taka = STARTING_TAKA;
    data.users[u].purchases = [];
    data.users[u].notifications = [];
  });
  data.feed = [{ text: '🔄 Admin reset all bets. Everyone back to ৳1000.', time: Date.now() }];
  saveData(data);
  res.json({ success: true });
});

// Vercel imports the app; only listen when run directly (`npm start`).
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🎰 MuttiTaharat running on port ${PORT}`));
}

module.exports = app;
