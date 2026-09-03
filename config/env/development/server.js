module.exports = ({ env }) => ({
    url: env('DEV_PUBLIC_URL', 'http://127.0.0.1:1337')
});
