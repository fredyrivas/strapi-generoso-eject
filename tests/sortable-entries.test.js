'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const extendPlugin = require('../src/extensions/sortable-entries/strapi-server');
const { bootstrap } = require('../src');

test('media labels preserve the filtered order and fall back when a file is missing', async () => {
  const entries = [
    { documentId: 'second', mainField: 2 },
    { documentId: 'first', mainField: 1 },
  ];
  const params = { uid: 'api::generoso-screen.generoso-screen', filters: { visible: true } };
  const plugin = extendPlugin({ services: { service: () => ({
    fetchEntries: async (received) => { assert.equal(received, params); return entries; },
  }) } });
  const strapi = {
    getModel: () => ({ attributes: { image: { type: 'media' } } }),
    documents: () => ({ findMany: async () => [
      { documentId: 'first', image: { name: 'promocion.png' } },
      { documentId: 'second', image: null },
    ] }),
  };

  const result = await plugin.services.service({ strapi }).fetchEntries(params);
  assert.deepEqual(result, [entries[0], { documentId: 'first', mainField: 'promocion.png' }]);
  assert.equal(entries[1].mainField, 1);
});

test('named collections keep their original labels without extra document queries', async () => {
  const entries = [{ documentId: 'product', mainField: 'Producto' }];
  const plugin = extendPlugin({ services: { service: () => ({ fetchEntries: async () => entries }) } });
  const strapi = { getModel: () => ({ attributes: { name: { type: 'string' } } }) };
  assert.equal(await plugin.services.service({ strapi }).fetchEntries({ uid: 'api::product.product' }), entries);
});

test('screens use their name and retain the filename fallback for unnamed entries', async () => {
  const entries = [{ documentId: 'named', mainField: 'Promoción' }, { documentId: 'unnamed', mainField: null }];
  const plugin = extendPlugin({ services: { service: () => ({ fetchEntries: async () => entries }) } });
  const strapi = {
    getModel: () => ({ attributes: { name: { type: 'string' }, image: { type: 'media' } } }),
    documents: () => ({ findMany: async (query) => {
      assert.deepEqual(query.filters.documentId.$in, ['unnamed']);
      return [{ documentId: 'unnamed', image: { name: 'pantalla.png' } }];
    } }),
  };

  assert.deepEqual(await plugin.services.service({ strapi }).fetchEntries({ uid: 'api::generoso-screen.generoso-screen' }), [
    entries[0], { documentId: 'unnamed', mainField: 'pantalla.png' },
  ]);
});

test('initial setup preserves other view settings and does not override later editor changes', async () => {
  let configured = false;
  let saves = 0;
  const configuration = {
    settings: { pageSize: 25, defaultSortBy: 'name', mainField: 'price' },
    metadatas: { order: { edit: {} }, sortOrder: { edit: {}, list: {} } },
    layouts: { edit: [[{ name: 'name' }, { name: 'order' }], [{ name: 'sortOrder' }]], list: ['name', 'order'] },
  };
  const strapi = {
    store: () => ({ get: async () => configured, set: async () => { configured = true; } }),
    contentTypes: { product: {
      uid: 'api::product.product',
      attributes: { name: { type: 'string' }, order: { type: 'integer' }, sortOrder: { type: 'integer' } },
    } },
    plugin: () => ({ service: () => ({
      findConfiguration: async () => configuration,
      updateConfiguration: async () => { saves += 1; },
    }) }),
  };

  await bootstrap({ strapi });
  assert.equal(configuration.settings.pageSize, 25);
  assert.equal(configuration.settings.defaultSortBy, 'sortOrder');
  assert.equal(configuration.settings.mainField, 'name');
  assert.deepEqual(configuration.layouts.edit, [[{ name: 'name' }]]);
  assert.deepEqual(configuration.layouts.list, ['name', 'sortOrder']);
  assert.equal(configuration.metadatas.order.edit.visible, false);
  configuration.settings.defaultSortBy = 'name';
  await bootstrap({ strapi });
  assert.equal(saves, 1);
  assert.equal(configuration.settings.defaultSortBy, 'name');
});
