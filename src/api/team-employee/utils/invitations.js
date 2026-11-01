'use strict';

const { randomBytes, createHash } = require('node:crypto');
const { employeeProfile } = require('./employee-details');
const { activationStatus } = require('./activations');
const { personalLinkStatus } = require('./personal-access');

function newInvitation() {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  return {
    token, expiresAt,
    data: { invitationTokenHash: createHash('sha256').update(token).digest('hex'), invitationExpiresAt: expiresAt, invitationCancelled: false, invitationAccepted: false },
  };
}

function invitationStatus(entry, now = Date.now()) {
  if (!entry || entry.status !== 'invited' || !entry.account || entry.account.blocked) return 'unavailable';
  if (entry.invitationAccepted === true) return 'accepted';
  if (entry.invitationCancelled === true) return 'cancelled';
  if (!entry.invitationExpiresAt || !Number.isFinite(Date.parse(entry.invitationExpiresAt))) return 'missing';
  return Date.parse(entry.invitationExpiresAt) <= now ? 'expired' : 'pending';
}

function adminEmployee(entry) {
  return { ...employeeProfile(entry), invitationExpiresAt: entry.invitationExpiresAt ?? null, invitationStatus: invitationStatus(entry), activationExpiresAt: entry.activationExpiresAt ?? null, activationStatus: activationStatus(entry), personalLinkStatus: personalLinkStatus(entry) };
}

module.exports = { newInvitation, invitationStatus, adminEmployee };
