'use strict';

module.exports = (plugin) => {
  const createService = plugin.services.service;

  plugin.services.service = ({ strapi }) => {
    const service = createService({ strapi });
    const fetchEntries = service.fetchEntries.bind(service);

    service.fetchEntries = async (params) => {
      const entries = await fetchEntries(params);
      const model = strapi.getModel(params.uid);
      if (!entries.length || model.attributes.image?.type !== 'media') return entries;
      const unnamedEntries = model.attributes.name ? entries.filter((entry) => !entry.mainField) : entries;
      if (!unnamedEntries.length) return entries;

      // Usar el archivo cuando la entrada todavía no tiene nombre.
      const records = await strapi.documents(params.uid).findMany({
        fields: ['documentId'],
        filters: { documentId: { $in: unnamedEntries.map((entry) => entry.documentId) } },
        populate: { image: { fields: ['name'] } },
        locale: params.locale,
      });
      const names = new Map(records.map((record) => [record.documentId, record.image?.name]));
      return entries.map((entry) => ({ ...entry, mainField: names.get(entry.documentId) || entry.mainField }));
    };

    return service;
  };

  return plugin;
};
