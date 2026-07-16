'use strict';

const { createCoreController } = require('@strapi/strapi').factories;
module.exports = createCoreController('api::production-run.production-run');
