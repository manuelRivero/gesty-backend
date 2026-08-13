import { Client } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const OWNER_PHONE = '5434192474716';
const OWNER_NAME = 'Manuel Rivero';

const url =
  process.env.CONNECTION_STRING_NO_PULLING ?? process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL missing');

const client = new Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

async function main() {
  await client.connect();
  await client.query('SET statement_timeout = 15000');

  const businesses = await client.query(
    `SELECT id, name, slug FROM business
     WHERE name ILIKE '%sabros%' OR slug ILIKE '%sabros%'
     ORDER BY name`
  );
  console.log('businesses', JSON.stringify(businesses.rows, null, 2));

  const customers = await client.query(
    `SELECT c.id, c.phone_number, c.name, c.business_id, b.name AS business_name
     FROM customer c
     JOIN business b ON b.id = c.business_id
     WHERE regexp_replace(c.phone_number, '\\D', '', 'g') LIKE '%' || $1
     ORDER BY b.name`,
    [OWNER_PHONE.replace(/\D/g, '')]
  );
  console.log('customers', JSON.stringify(customers.rows, null, 2));

  if (businesses.rows.length === 0) {
    const all = await client.query('SELECT id, name, slug FROM business ORDER BY name');
    console.log('all_businesses', JSON.stringify(all.rows, null, 2));
    return;
  }

  const biz = businesses.rows[0];

  await client.query(`
    ALTER TABLE business_config
      ADD COLUMN IF NOT EXISTS owner_whatsapp_phones text[] NOT NULL DEFAULT '{}'
  `);

  await client.query(
    `INSERT INTO business_config (business_id, owner_whatsapp_phones)
     VALUES ($1::uuid, ARRAY[$2]::text[])
     ON CONFLICT (business_id) DO UPDATE SET
       owner_whatsapp_phones = (
         SELECT ARRAY(SELECT DISTINCT unnest(
           COALESCE(business_config.owner_whatsapp_phones, '{}'::text[]) || ARRAY[$2]::text[]
         ))
       )`,
    [biz.id, OWNER_PHONE]
  );

  const cfg = await client.query(
    `SELECT owner_whatsapp_phones FROM business_config WHERE business_id = $1::uuid`,
    [biz.id]
  );
  console.log('owner_whatsapp_phones', cfg.rows[0]);

  const upsert = await client.query(
    `INSERT INTO customer (business_id, phone_number, name)
     VALUES ($1::uuid, $2, $3)
     ON CONFLICT (business_id, phone_number)
     DO UPDATE SET name = EXCLUDED.name
     RETURNING id, phone_number, name`,
    [biz.id, OWNER_PHONE, OWNER_NAME]
  );
  console.log('customer', upsert.rows[0]);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => client.end());
