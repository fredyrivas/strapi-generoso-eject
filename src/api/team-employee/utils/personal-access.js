'use strict';

const { randomBytes, createHash } = require('node:crypto');
const validPersonalToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
const personalTokenHash = token => createHash('sha256').update(token).digest('hex');
function newPersonalAccess() { const token = randomBytes(32).toString('base64url'); return { token, data: { personalTokenHash: personalTokenHash(token) } }; }
function personalLinkStatus(entry) {
  if (!entry || entry.status !== 'active' || !entry.account || entry.account.blocked || entry.account.confirmed === false || (entry.account.provider && entry.account.provider !== 'local')) return 'unavailable';
  return entry.personalTokenHash ? 'ready' : 'missing';
}

function currentWeek(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = type => parts.find(part => part.type === type).value;
  const today = value('year') + '-' + value('month') + '-' + value('day');
  // UTC arithmetic is used only for calendar dates after obtaining the local date.
  const monday = new Date(today + 'T12:00:00Z'); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const iso = date => date.toISOString().slice(0, 10);
  const labels = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
  const days = labels.map((label, index) => { const date = new Date(monday); date.setUTCDate(date.getUTCDate() + index); const calendar = iso(date); return { date: calendar, label, status: calendar > today ? 'upcoming' : 'no_record', timestamp: null }; });
  const end = new Date(monday); end.setUTCDate(end.getUTCDate() + 7);
  return { timeZone: 'America/Mexico_City', today, start: iso(monday), endExclusive: iso(end), days };
}

module.exports = { validPersonalToken, personalTokenHash, newPersonalAccess, personalLinkStatus, currentWeek };
