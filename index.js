const express = require('express');
const app = express();

app.use(express.json());
app.use(express.static('public'));

const ADMIN_PASSWORD = 'mutti123';
const STARTING_TAKA = 1000;

const EVENTS = [
  { id: 'mutti', name: 'Mutti Mari', emoji: '💀' },
  { id: 'gay', name: 'Gay Ass Joke', emoji: '🌈' },
  { id: 'pdf', name: 'PDF File Joke', emoji: '📄' },
  { id: 'rant', name: 'Random Unhinged Rant', emoji: '🤡' },
];

const TIME_WINDOWS = [
  { label: '2 min', minutes: 2, multiplier: 10 },
  { label: '5 min', minutes: 5, multiplier: 5 },
  { label: '10 min', minutes: 10, multiplier: 3 },
  { label: '20 min', minutes: 20, multiplier: 1.5 },
];

let users = {};
let bets = [];
let feed = [];

app.get('/api/state', (req, res) => {
  res.json({ users, bets, events: EVENTS, timeWindows: TIME_WINDOWS, feed: feed.slice(-15) });
});

app.post('/api/register', (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length < 1) return res.status(400).json({ error: 'Name required' });
  const cleanName = name.trim();
  if (users[cleanName]) {
    return res.json({ success: true, user: { name: cleanName, taka: users[cleanName].taka } });
  }
  users[cleanName] = { taka: STARTING_TAKA };
  feed.push({ text: `🆕 ${cleanName} joined MuttiTaharat with ৳1000`, time: Date.now() });
  res.json({ success: true, user: { name: cleanName, taka: STARTING_TAKA } });
});

app.post('/api/bet', (req, res) => {
  const { userName, eventId, timeWindowIndex, wager } = req.body;
  if (!users[userName]) return res.status(400).json({ error: 'User not found' });
  const w = parseInt(wager);
  if (!w || w <= 0) return res.status(400).json({ error: 'Invalid wager amount' });
  if (users[userName].taka < w) return res.status(400).json({ error: `Not enough Taka! You have ৳${users[userName].taka}` });
  const timeWindow = TIME_WINDOWS[timeWindowIndex];
  const event = EVENTS.find(e => e.id === eventId);
  if (!timeWindow || !event) return res.status(400).json({ error: 'Invalid selection' });
  users[userName].taka -= w;
  const now = Date.now();
  const bet = {
    id: now.toString() + Math.random().toString(36).slice(2),
    userName, eventId,
    eventName: event.name,
    eventEmoji: event.emoji,
    timeWindowLabel: timeWindow.label,
    minutes: timeWindow.minutes,
    multiplier: timeWindow.multiplier,
    wager: w,
    potentialWin: Math.floor(w * timeWindow.multiplier),
    placedAt: now,
    expiresAt: now + timeWindow.minutes * 60 * 1000,
    status: 'active',
  };
  bets.push(bet);
  feed.push({ text: `🎰 ${userName} bet ৳${w} on "${event.name}" within ${timeWindow.label} (${timeWindow.multiplier}x)`, time: now });
  res.json({ success: true, bet, newTaka: users[userName].taka });
});

app.post('/api/resolve', (req, res) => {
  const { password, eventId } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Wrong password lmao' });
  const event = EVENTS.find(e => e.id === eventId);
  if (!event) return res.status(400).json({ error: 'Invalid event' });
  const now = Date.now();
  let winners = 0, losers = 0;
  bets = bets.map(bet => {
    if (bet.eventId === eventId && bet.status === 'active') {
      if (bet.expiresAt > now) {
        if (users[bet.userName]) users[bet.userName].taka += bet.potentialWin;
        winners++;
        return { ...bet, status: 'won' };
      } else {
        losers++;
        return { ...bet, status: 'lost' };
      }
    }
    return bet;
  });
  feed.push({ text: `💀 IT HAPPENED: "${event.name}"! ${winners} winners paid out, ${losers} losers rekt.`, time: now });
  res.json({ success: true, winners, losers });
});

app.post('/api/tick', (req, res) => {
  const now = Date.now();
  bets = bets.map(bet => {
    if (bet.status === 'active' && bet.expiresAt <= now) return { ...bet, status: 'lost' };
    return bet;
  });
  res.json({ success: true });
});

app.post('/api/reset', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Wrong password' });
  bets = [];
  Object.keys(users).forEach(u => { users[u].taka = STARTING_TAKA; });
  feed = [{ text: '🔄 Admin reset all bets. Everyone back to ৳1000.', time: Date.now() }];
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎰 MuttiTaharat running on port ${PORT}`));
