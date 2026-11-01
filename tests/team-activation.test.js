'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
test('the separate activation step exposes no public or administrative routes', () => {
  assert.deepEqual(require('../src/api/team-employee/routes/activations').routes, []);
});
