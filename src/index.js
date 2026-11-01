'use strict';

const configureTeam = require('./team-config');
const configureAttendance = require('./team-attendance-config');
const configureOnboarding = require('./team-onboarding-config');

module.exports = {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/*{ strapi }*/) {},

  async bootstrap({ strapi }) {
    await configureTeam(strapi);
    await configureOnboarding(strapi);
    await configureAttendance(strapi);
    const store = strapi.store({ type: 'plugin', name: 'sortable-entries' });
    const key = 'configured-content-manager-v1';
    if (await store.get({ key })) return;

    const service = strapi.plugin('content-manager').service('content-types');
    const contentTypes = Object.values(strapi.contentTypes).filter((type) =>
      type.uid.startsWith('api::') && type.attributes.sortOrder?.type === 'integer');

    for (const contentType of contentTypes) {
      const configuration = await service.findConfiguration(contentType);
      configuration.settings.defaultSortBy = 'sortOrder';
      configuration.settings.defaultSortOrder = 'ASC';
      if (contentType.attributes.name?.type === 'string') {
        configuration.settings.mainField = 'name';
      }

      // Los números se administran desde el modal de arrastre, no en el formulario.
      const orderFields = new Set(['sortOrder', ...(contentType.attributes.order ? ['order'] : [])]);
      for (const field of orderFields) {
        const metadata = configuration.metadatas[field];
        metadata.edit = { ...metadata.edit, visible: false, editable: false };
      }
      configuration.metadatas.sortOrder.list.label = 'Orden';
      configuration.layouts.edit = configuration.layouts.edit
        .map((row) => row.filter((field) => !orderFields.has(field.name)))
        .filter((row) => row.length > 0);
      configuration.layouts.list = [...new Set(configuration.layouts.list
        .map((field) => field === 'order' ? 'sortOrder' : field))];
      await service.updateConfiguration(contentType, configuration);
    }

    // Se configura una sola vez para respetar los ajustes posteriores del editor.
    await store.set({ key, value: true });
  },
};
