module.exports = ({ env }) => {
  // Variables AWS
  process.env.AWS_ACCESS_KEY_ID = env("AWS_ACCESS_KEY_ID");
  process.env.AWS_SECRET_ACCESS_KEY = env("AWS_ACCESS_SECRET");
  process.env.AWS_REGION = env("AWS_REGION");

  console.log('AWS CHECK:', {
    key: env('AWS_ACCESS_KEY_ID'),
    region: env('AWS_REGION'),
    bucket: env('AWS_BUCKET'),
  });

  return {
    "users-permissions": {
      config: { jwtSecret: env("JWT_SECRET") },
    },
    upload: {
      config: {
        provider: "aws-s3",
        providerOptions: {
          s3Options: {
            region: env("AWS_REGION"),
            credentials: {
              accessKeyId: env("AWS_ACCESS_KEY_ID"),
              secretAccessKey: env("AWS_ACCESS_SECRET"),
            },
          },
          params: {
            Bucket: env("AWS_BUCKET"),
            ACL: 'private',
          },
        },
        breakpoints: false, // 👈 esto desactiva thumbnails, medium, small, etc.
        actionOptions: {
          upload: {},
          delete: {},
        },
      },
    },
  };
};









// module.exports = ({ env }) => ({
//   "users-permissions": {
//     config: {
//       jwtSecret: env("JWT_SECRET"),
//     },
//   },
//   upload: {
//     config: {
//       provider: "cloudinary",
//       providerOptions: {
//         cloud_name: env("CLOUDINARY_NAME"),
//         api_key: env("CLOUDINARY_KEY"),
//         api_secret: env("CLOUDINARY_SECRET"),
//       },
//       actionOptions: {
//         upload: {},
//         delete: {},
//       },
//     },
//   },
// });

