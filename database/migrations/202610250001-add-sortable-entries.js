'use strict';

const tables = [
  'generoso_screens',
  'home_sliders',
  'desayunos_sliders',
  'sandwiches_sliders',
  'menu_categories',
  'bebidas_categories',
  'products',
];

exports.up = async (knex) => {
  // El plugin escribe directamente con Knex, en borradores y publicaciones.
  // El trigger conserva la compatibilidad de las API que aún utilizan `order`.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION generoso_sync_entry_order() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW."order" IS NOT NULL THEN
          NEW.sort_order := NEW."order";
        ELSE
          NEW."order" := NEW.sort_order;
        END IF;
      ELSIF NEW.sort_order IS DISTINCT FROM OLD.sort_order THEN
        NEW."order" := NEW.sort_order;
      ELSIF NEW."order" IS DISTINCT FROM OLD."order" THEN
        NEW.sort_order := NEW."order";
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  for (const tableName of tables) {
    if (!await knex.schema.hasTable(tableName)) continue;
    if (!await knex.schema.hasColumn(tableName, 'sort_order')) {
      await knex.schema.alterTable(tableName, (table) => {
        table.integer('sort_order');
      });
    }

    await knex(tableName).whereNull('sort_order').update({ sort_order: knex.ref('order') });
    await knex.raw('DROP TRIGGER IF EXISTS generoso_sync_entry_order ON ??', [tableName]);
    await knex.raw(`
      CREATE TRIGGER generoso_sync_entry_order
      BEFORE INSERT OR UPDATE OF "order", sort_order ON ??
      FOR EACH ROW EXECUTE FUNCTION generoso_sync_entry_order()
    `, [tableName]);
  }
};
