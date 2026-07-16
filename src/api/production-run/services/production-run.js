'use strict';

const { createCoreService } = require('@strapi/strapi').factories;
module.exports = createCoreService('api::production-run.production-run');
