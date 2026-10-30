'use strict';

const { randomBytes, createHash } = require('node:crypto');
const validToken = (token) => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

function newActivation() {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return { token, expiresAt, data: { activationTokenHash: tokenHash(token), activationExpiresAt: expiresAt } };
}

function activationStatus(entry, now = Date.now()) {
  if (!entry || entry.status !== 'invited' || entry.invitationAccepted !== true || !entry.account || entry.account.blocked) return 'unavailable';
  if (!entry.activationTokenHash || !Number.isFinite(Date.parse(entry.activationExpiresAt))) return 'missing';
  return Date.parse(entry.activationExpiresAt) <= now ? 'expired' : 'pending';
}

module.exports = { validToken, tokenHash, newActivation, activationStatus };
