'use strict';
const sharp = require('sharp');
const { errors: { ForbiddenError, NotFoundError, ValidationError } } = require('@strapi/utils');
const { LOCK } = require('../utils/attendance');
const E = 'api::team-employee.team-employee', U = 'plugin::users-permissions.user';
const MAX_LENGTH = 350000;

async function normalizePhoto(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
    || typeof input.photo !== 'string' || input.photo.length > MAX_LENGTH || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(input.photo)) {
    throw new ValidationError('Selecciona una foto válida.');
  }
  try {
    const image = sharp(Buffer.from(input.photo.slice(23), 'base64'), { limitInputPixels: 1024 * 1024, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== 'jpeg' || !metadata.width || !metadata.height || metadata.width > 1024 || metadata.height > 1024) throw new Error('Invalid image');
    // Decode and re-encode: keep no original EXIF, GPS or embedded payloads.
    const photo = await image.rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    return 'data:image/jpeg;base64,' + photo.toString('base64');
  } catch { throw new ValidationError('No se pudo leer la foto. Prueba con otra imagen.'); }
}

module.exports = ({ strapi }) => {
  async function findOwn(id) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ForbiddenError('Inicia sesión para cambiar tu foto.');
    const entry = await strapi.documents(E).findFirst({
      filters: { account: { id } }, fields: ['documentId', 'status', 'profilePhoto'],
      populate: { account: { fields: ['id', 'confirmed', 'blocked', 'provider'] } },
    });
    if (!entry) throw new NotFoundError('Esta cuenta no tiene un perfil de empleado.');
    if (entry.account?.id !== id || entry.status !== 'active' || entry.account.confirmed !== true || entry.account.blocked || entry.account.provider !== 'local') throw new ForbiddenError('Tu cuenta no tiene acceso a esta foto.');
    return entry;
  }
  async function lock(uid, key, trx) {
    const table = strapi.db.metadata.get(uid).tableName;
    const row = await strapi.db.connection(table).transacting(trx).select('id').where(key).forUpdate().first();
    if (!row) throw new NotFoundError('El perfil o la cuenta ya no están disponibles.');
  }
  return {
    async readForAccount(id) { return { photo: (await findOwn(id)).profilePhoto ?? null }; },
    async saveForAccount(id, input) {
      await findOwn(id);
      const photo = await normalizePhoto(input);
      return strapi.db.transaction(async ({ trx }) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [LOCK]);
        const initial = await findOwn(id);
        await lock(E, { document_id: initial.documentId }, trx);
        await lock(U, { id }, trx);
        const entry = await findOwn(id);
        await strapi.documents(E).update({ documentId: entry.documentId, data: { profilePhoto: photo }, fields: ['documentId'] });
        return { photo };
      });
    },
  };
};
