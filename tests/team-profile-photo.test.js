'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const sharp = require('sharp');
const serviceFactory = require('../src/api/team-employee/services/team-profile-photo');
const routerFactory = require('../src/api/team-employee/routes/profile-photo');
const schema = require('../src/api/team-employee/content-types/team-employee/schema.json');
const { employeeProfile } = require('../src/api/team-employee/utils/employee-details');
const E = 'api::team-employee.team-employee';

function harness() {
  const entries = [1, 2].map(id => ({ documentId: 'employee-' + id, fullName: 'Persona ' + id, status: 'active', paymentAccount: { monthlySalary: 5000 }, account: { id, email: id + '@example.test', confirmed: true, blocked: false, provider: 'local' } }));
  const writes = [], locks = [];
  const documents = {
    async findFirst(query) { return entries.find(entry => entry.account.id === query.filters.account.id) ?? null; },
    async update(query) {
      writes.push(query);
      const entry = entries.find(entry => entry.documentId === query.documentId);
      Object.assign(entry, query.data);
      return { documentId: entry.documentId };
    },
  };
  const strapi = {
    documents(uid) { assert.equal(uid, E); return documents; },
    db: {
      metadata: { get: uid => ({ tableName: uid === E ? 'employees' : 'users' }) },
      transaction: operation => operation({ trx: { raw: async () => { locks.push('global'); } } }),
      connection: table => ({ transacting() { return this; }, select() { return this; }, where() { return this; }, forUpdate() { locks.push(table); return this; }, first: async () => ({ id: 1 }) }),
    },
  };
  return { service: serviceFactory({ strapi }), strapi, entries, writes, locks };
}
const jpeg = async (width = 800, height = 600) => 'data:image/jpeg;base64,' + (await sharp({ create: { width, height, channels: 3, background: 'red' } }).jpeg().toBuffer()).toString('base64');

test('an own photo persists on the employee, replaces only that photo and returns after a new service read', async () => {
  const { service, strapi, entries, writes, locks } = harness();
  assert.deepEqual(await service.readForAccount(1), { photo: null });
  const before = structuredClone(entries);
  const result = await service.saveForAccount(1, { photo: await jpeg() });
  assert.equal(result.photo, entries[0].profilePhoto);
  assert.equal((await serviceFactory({ strapi }).readForAccount(1)).photo, result.photo);
  const metadata = await sharp(Buffer.from(result.photo.slice(23), 'base64')).metadata();
  assert.equal(metadata.width, 512); assert.equal(metadata.height, 384); assert.equal(metadata.exif, undefined);
  assert.deepEqual(Object.keys(writes[0].data), ['profilePhoto']);
  assert.deepEqual(locks, ['global', 'employees', 'users']);
  assert.deepEqual(entries[1], before[1]);
  assert.deepEqual(entries[0].paymentAccount, before[0].paymentAccount);
  const updated = await service.saveForAccount(1, { photo: await jpeg(40, 60) });
  assert.notEqual(updated.photo, result.photo);
  assert.equal((await service.readForAccount(1)).photo, updated.photo);
  assert.equal(writes.length, 2);
});

test('selectors, forged images, excessive bytes and excessive dimensions never write a photo', async () => {
  const { service, writes } = harness();
  const photo = await jpeg(10, 10);
  for (const input of [null, [], {}, { photo, account: 2 }, { photo, documentId: 'employee-2' }, { photo: 'data:image/svg+xml;base64,PHN2Zz4=' }, { photo: 'data:image/jpeg;base64,aGVsbG8=' }, { photo: 'data:image/jpeg;base64,' + 'A'.repeat(350000) }, { photo: await jpeg(1025, 5) }]) {
    await assert.rejects(service.saveForAccount(1, input), { name: 'ValidationError' });
  }
  assert.equal(writes.length, 0);
});

test('missing profiles and revoked accounts cannot read or save photos', async () => {
  const photo = await jpeg(10, 10);
  for (const change of [entry => { entry.status = 'inactive'; }, entry => { entry.status = 'invited'; }, entry => { entry.account.blocked = true; }, entry => { entry.account.confirmed = false; }]) {
    const { service, entries, writes } = harness(); change(entries[0]);
    await assert.rejects(service.readForAccount(1));
    await assert.rejects(service.saveForAccount(1, { photo }));
    assert.equal(writes.length, 0);
  }
  const { service } = harness();
  for (const id of [undefined, null, '1', 0, 3]) {
    await assert.rejects(service.readForAccount(id));
    await assert.rejects(service.saveForAccount(id, { photo }));
  }
});

test('profile photos are private, excluded from ordinary profiles and use only member routes', () => {
  assert.equal(schema.attributes.profilePhoto.private, true);
  const { entries } = harness();
  assert.equal(Object.hasOwn(employeeProfile({ ...entries[0], profilePhoto: 'private-photo' }), 'profilePhoto'), false);
  const routes = routerFactory({ strapi: {} }).routes;
  assert.deepEqual(routes.map(route => [route.method, route.path]), [['GET', '/team/profile/photo'], ['PUT', '/team/profile/photo']]);
  for (const route of routes) {
    assert.deepEqual(route.config.auth, { strategies: ['users-permissions'], scope: [] });
    assert.deepEqual(route.config.policies, ['api::team-employee.team-member']);
  }
});
