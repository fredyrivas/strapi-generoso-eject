'use strict';

/*
 * `presentation` antes aceptaba texto libre. Normalizamos los registros
 * existentes antes de convertir el atributo a la enumeración kg/gr/pz.
 */
exports.up = async (knex) => {
  const tableName = 'purchase_items';
  const hasTable = await knex.schema.hasTable(tableName);

  if (!hasTable || !await knex.schema.hasColumn(tableName, 'presentation')) return;

  await knex(tableName).update({
    presentation: knex.raw(`CASE
      WHEN LOWER(TRIM(COALESCE(??, ''))) = 'kg' OR LOWER(COALESCE(??, '')) ~ '\\mkg\\M' THEN 'kg'
      WHEN LOWER(TRIM(COALESCE(??, ''))) IN ('gr', 'g') OR LOWER(COALESCE(??, '')) ~ '\\m(gr|gramo|gramos|g)\\M' THEN 'gr'
      ELSE 'pz'
    END`, ['presentation', 'presentation', 'presentation', 'presentation']),
  });
};

exports.down = async () => {
  // La columna continúa siendo texto en PostgreSQL; no es posible reconstruir
  // las descripciones libres originales después de normalizarlas.
};
