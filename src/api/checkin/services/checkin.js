'use strict';

/**
 * checkin service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::checkin.checkin');
