const { Pool } = require("@neondatabase/serverless");

const MAX_CAPACITY = Object.freeze({
  hall: 4,
  fourBed: 4,
  eightBed: 8,
  cooler: 1,
  ac: 1,
  twoBhk: 1,
});

// Keep half of dorm capacity saleable online by default; staff can tune each date.
const DEFAULT_CAPACITY = Object.freeze({
  hall: 2,
  fourBed: 2,
  eightBed: 4,
  cooler: 1,
  ac: 1,
  twoBhk: 1,
});

let schemaReady;

function getPool() {
  if (!process.env.DATABASE_URL) throw new Error("Booking database is not configured.");
  return new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
}

async function ensureSchema(database = getPool()) {
  if (!schemaReady) {
    schemaReady = (async () => {
      const db = database;
      const statements = [
        `CREATE TABLE IF NOT EXISTS awara_inventory (
          stay_date date NOT NULL,
          stay_type text NOT NULL CHECK (stay_type IN ('hall','fourBed','eightBed','cooler','ac','twoBhk')),
          capacity integer NOT NULL CHECK (capacity >= 0),
          blocked integer NOT NULL DEFAULT 0 CHECK (blocked >= 0),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (stay_date, stay_type)
        )`,
        `CREATE TABLE IF NOT EXISTS awara_bookings (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          reference text NOT NULL UNIQUE,
          stay_type text NOT NULL CHECK (stay_type IN ('hall','fourBed','eightBed','cooler','ac','twoBhk')),
          check_in date NOT NULL,
          check_out date NOT NULL,
          quantity integer NOT NULL CHECK (quantity > 0),
          guest_count integer NOT NULL CHECK (guest_count > 0 AND guest_count <= 8),
          guest_name text NOT NULL,
          guest_email text NOT NULL DEFAULT '',
          payer_country text NOT NULL DEFAULT 'INT',
          phone text NOT NULL,
          note text NOT NULL DEFAULT '',
          source text NOT NULL DEFAULT 'website' CHECK (source IN ('website','offline','booking.com','makemytrip','goibibo','hostelworld','other')),
          status text NOT NULL CHECK (status IN ('awaiting_staff','pending_payment','confirmed','cancelled','expired')),
          amount_inr numeric(10,2) NOT NULL CHECK (amount_inr >= 0),
          amount_usd numeric(10,2),
          fx_rate numeric(12,6),
          fx_checked_at timestamptz,
          payment_provider text,
          payment_order_id text UNIQUE,
          payment_capture_id text,
          expires_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CHECK (check_out > check_in)
        )`,
        "ALTER TABLE awara_bookings ADD COLUMN IF NOT EXISTS guest_email text NOT NULL DEFAULT ''",
        "ALTER TABLE awara_bookings ADD COLUMN IF NOT EXISTS payer_country text NOT NULL DEFAULT 'INT'",
        "CREATE INDEX IF NOT EXISTS awara_bookings_dates_idx ON awara_bookings(check_in, check_out)",
        "CREATE INDEX IF NOT EXISTS awara_bookings_status_idx ON awara_bookings(status, expires_at)",
      ];
      for (const statement of statements) await db.query(statement);
    })().catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  return schemaReady;
}

function isoDays(checkIn, checkOut) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn || "") || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut || "")) return [];
  const start = Date.parse(`${checkIn}T00:00:00Z`);
  const end = Date.parse(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || new Date(start).toISOString().slice(0, 10) !== checkIn || new Date(end).toISOString().slice(0, 10) !== checkOut || end <= start || end - start > 90 * 86400000) return [];
  const days = [];
  for (let time = start; time < end; time += 86400000) days.push(new Date(time).toISOString().slice(0, 10));
  return days;
}

async function availabilityForDay(client, stayDate, stayType) {
  return (await availabilityForDays(client, [stayDate], stayType))[0];
}

async function availabilityForDays(client, days, stayType) {
  if (!days.length) return [];
  const result = await client.query(
    `WITH requested AS (SELECT unnest($1::date[]) AS stay_date)
     SELECT requested.stay_date::text AS date,
            COALESCE(i.capacity,$3::int) AS capacity,
            COALESCE(i.blocked,0)::int AS blocked,
            COALESCE(b.quantity,0)::int AS booked,
            GREATEST(0,COALESCE(i.capacity,$3::int)-COALESCE(i.blocked,0)-COALESCE(b.quantity,0))::int AS remaining
       FROM requested
       LEFT JOIN awara_inventory i ON i.stay_date=requested.stay_date AND i.stay_type=$2
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(quantity),0)::int AS quantity
           FROM awara_bookings
          WHERE status IN ('awaiting_staff','pending_payment','confirmed')
            AND (expires_at IS NULL OR expires_at > now())
            AND check_in <= requested.stay_date AND check_out > requested.stay_date
            AND (stay_type=$2 OR ($2='twoBhk' AND stay_type IN ('cooler','ac')) OR ($2 IN ('cooler','ac') AND stay_type='twoBhk'))
       ) b ON true
      ORDER BY requested.stay_date`,
    [days, stayType, DEFAULT_CAPACITY[stayType]],
  );
  let rows = result.rows;
  if (stayType === "twoBhk") {
    const rooms = await client.query(
      `SELECT requested.stay_date::text AS date, i.stay_type,
              COALESCE(i.capacity,1)::int AS capacity, COALESCE(i.blocked,0)::int AS blocked
         FROM (SELECT unnest($1::date[]) AS stay_date) requested
         CROSS JOIN (VALUES ('cooler'::text),('ac'::text)) types(stay_type)
         LEFT JOIN awara_inventory i ON i.stay_date=requested.stay_date AND i.stay_type=types.stay_type`,
      [days],
    );
    const openRooms = new Map();
    for (const room of rooms.rows) {
      const isOpen = Number(room.capacity) - Number(room.blocked) > 0;
      openRooms.set(room.date, (openRooms.get(room.date) ?? true) && isOpen);
    }
    rows = rows.map((row) => openRooms.get(row.date) ? row : { ...row, remaining: 0 });
  }
  return rows;
}

module.exports = { DEFAULT_CAPACITY, MAX_CAPACITY, availabilityForDay, availabilityForDays, ensureSchema, getPool, isoDays };
