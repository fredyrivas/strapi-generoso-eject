'use strict';

exports.up = async (knex) => {
  const key = 'plugin_content_manager_configuration_content_types::api::generoso-screen.generoso-screen';
  const record = await knex('strapi_core_store_settings').where({ key }).first();
  if (!record) return;

  const configuration = JSON.parse(record.value);
  configuration.settings = { ...configuration.settings, mainField: 'name' };
  configuration.layouts.list = ['name', ...configuration.layouts.list.filter((field) => field !== 'name')];
  await knex('strapi_core_store_settings').where({ key }).update({ value: JSON.stringify(configuration) });
};
