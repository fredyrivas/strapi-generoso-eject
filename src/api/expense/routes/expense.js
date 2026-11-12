'use strict';

const { createCoreRouter } = require('@strapi/strapi').factories;
module.exports = createCoreRouter('api::expense.expense', { only: ['find', 'findOne', 'create', 'update'] });
