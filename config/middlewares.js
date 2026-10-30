module.exports = [
  'strapi::logger',
  'strapi::errors',
  {
    name: 'strapi::security',
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'img-src': ["'self'", "data:", "blob:", "https://website-generoso.s3.us-east-1.amazonaws.com"],
          'media-src': ["'self'", "blob:", "https://website-generoso.s3.us-east-1.amazonaws.com"],
        },
      },
    },
  },
  'strapi::cors',
  'strapi::poweredBy',
  'strapi::query',
  {
    name: 'strapi::body',
    config: {
      // Account deletion requires an explicit confirmation in the JSON body.
      parsedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    },
  },
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
];