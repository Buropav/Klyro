const { Pool } = require('pg');
const requestContext = require('./requestContext');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'klyro',
  user: process.env.PGUSER || 'klyro',
  password: process.env.PGPASSWORD || 'klyro',
  max: Number(process.env.PGPOOL_MAX || 10),
});

async function query(text, params) {
  requestContext.increment('dbQueries');
  return pool.query(text, params);
}

module.exports = { pool, query };
