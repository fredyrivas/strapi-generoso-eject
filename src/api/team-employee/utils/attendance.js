'use strict';
const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { errors: { ValidationError } } = require('@strapi/utils');
const { currentWeek } = require('./personal-access');
const SITE = { latitude: 19.5476069, longitude: -99.2208511, radius: 70 };
const LOCK = 'generoso:team:attendance';

function localClock(now) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Mexico_City', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now);
  const value = key => Number(parts.find(part => part.type === key).value);
  return { date: currentWeek(now).today, seconds: value('hour') * 3600 + value('minute') * 60 + value('second') };
}
const punctualAt = now => localClock(now).seconds <= 8 * 3600 + 5 * 60 + 59;
const openAt = now => localClock(now).seconds < 12 * 3600;
function locationInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['latitude', 'longitude', 'accuracy', 'challenge'].includes(key))) throw new ValidationError('Los datos de ubicación no son válidos.');
  const { latitude, longitude, accuracy, challenge } = input;
  if (![latitude, longitude, accuracy].every(value => typeof value === 'number' && Number.isFinite(value)) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracy <= 0 || typeof challenge !== 'string' || challenge.length > 200) throw new ValidationError('No se recibió una ubicación válida. Intenta de nuevo.');
  return { latitude, longitude, accuracy, challenge };
}
function validateLocation({ latitude, longitude, accuracy }) {
  if (accuracy > SITE.radius) throw new ValidationError('Tu ubicación no es suficientemente precisa. Intenta de nuevo cerca de la entrada.');
  const rad = value => value * Math.PI / 180;
  const a = Math.sin(rad(latitude - SITE.latitude) / 2) ** 2 + Math.cos(rad(SITE.latitude)) * Math.cos(rad(latitude)) * Math.sin(rad(longitude - SITE.longitude) / 2) ** 2;
  const distance = 6371000 * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
  if (distance > SITE.radius) throw new ValidationError('Debes estar a menos de 70 metros de Generoso para registrar tu llegada.');
}
function signature(secret, hash, date, expires, nonce) { return createHmac('sha256', secret).update(['team-checkin-v1', hash, date, expires, nonce].join(':')).digest('base64url'); }
function challengeFor(secret, hash, now) {
  const expires = String(Math.floor(now.getTime() / 1000) + 120), nonce = randomBytes(16).toString('base64url');
  return [expires, nonce, signature(secret, hash, localClock(now).date, expires, nonce)].join('.');
}
function validChallenge(secret, hash, challenge, now) {
  if (typeof challenge !== 'string' || !/^\d{10,12}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(challenge)) return false;
  const [expires, nonce, signed] = challenge.split('.'), seconds = Math.floor(now.getTime() / 1000);
  if (Number(expires) < seconds || Number(expires) > seconds + 120) return false;
  return timingSafeEqual(Buffer.from(signed), Buffer.from(signature(secret, hash, localClock(now).date, expires, nonce)));
}
function weekWithRecords(records, now) {
  const week = currentWeek(now);
  return { ...week, days: week.days.map(day => { const record = records.find(record => record.date === day.date); return { ...day, status: record ? record.punctual ? 'on_time' : 'late' : day.date > week.today ? 'upcoming' : 'no_record', timestamp: record ? new Date(record.timestamp).toISOString() : null }; }) };
}
module.exports = { SITE, LOCK, localClock, punctualAt, openAt, locationInput, validateLocation, challengeFor, validChallenge, weekWithRecords };
