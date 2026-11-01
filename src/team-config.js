'use strict';

// Idempotent: preserve existing accounts, role permissions and other authentication settings.
module.exports = async function configureTeam(strapi) {
  await strapi.db.transaction(async ({ trx }) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', ['generoso:team:configuration']);
    const roles = strapi.db.query('plugin::users-permissions.role');
    const role = await roles.findOne({ where: { type: 'teamemployee' } });
    if (!role) await roles.create({ data: { name: 'Empleado Team', type: 'teamemployee', description: 'Cuenta de empleado; acceso a Team sujeto al perfil y a sus políticas.' } });
    const store = strapi.store({ type: 'plugin', name: 'users-permissions' });
    const advanced = await store.get({ key: 'advanced' });
    if (!advanced || typeof advanced !== 'object') throw new Error('No se encontró la configuración de cuentas para Team.');
    if (advanced.allow_register !== false) await store.set({ key: 'advanced', value: { ...advanced, allow_register: false } });
  });
};
