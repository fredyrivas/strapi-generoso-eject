'use strict';

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::checklist-task.checklist-task');
