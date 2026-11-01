module.exports = ({ env }) => ({
    connection: {
        client: 'postgres',
        connection: {
            connectionString: env('DATABASE_URL')
        },
        debug: false,
        pool: { min: 0, max: 7 },
    }
});