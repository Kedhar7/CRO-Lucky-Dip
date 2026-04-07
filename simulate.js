const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, 'cro_lucky_dip.db'));
db.pragma('journal_mode = WAL');

// Load encryption key
const ENC_KEY = Buffer.from(fs.readFileSync(path.join(__dirname, '.encryption_key'), 'utf8').trim(), 'hex');

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${enc}`;
}

function hashId(id) {
  return crypto.createHash('sha256').update(id).digest('hex');
}

const SEVAS = [
  'Suprabhatam', 'Thomala Seva', 'Archana',
  'Astadala Pada Padmaradhana', 'Vishesha Pooja',
  'Sahasra Deepalankara Seva', 'Nijapada Darshanam'
];

const FIRST_NAMES = ['Rama', 'Krishna', 'Sita', 'Lakshmi', 'Venkata', 'Srinivasa', 'Padma', 'Govinda', 'Narayana', 'Anjali', 'Suresh', 'Mahesh', 'Priya', 'Deepa', 'Ravi', 'Kumar', 'Devi', 'Ganesh', 'Balaji', 'Sarada'];
const LAST_NAMES = ['Reddy', 'Naidu', 'Sharma', 'Rao', 'Prasad', 'Kumar', 'Pillai', 'Iyer', 'Nair', 'Gupta', 'Singh', 'Patel', 'Varma', 'Murthy', 'Chari', 'Rajan', 'Swamy', 'Devi', 'Yadav', 'Hegde'];

const TOTAL = 100000;
const today = new Date();
const opts = { timeZone: 'Asia/Kolkata' };
const day = today.toLocaleDateString('en-GB', { ...opts, day: '2-digit' });
const month = today.toLocaleDateString('en-GB', { ...opts, month: '2-digit' });
const year = today.toLocaleDateString('en-GB', { ...opts, year: 'numeric' });
const todayStr = `${day}/${month}/${year}`;

console.log(`\n=== CRO Lucky Dip Simulation ===`);
console.log(`Date: ${todayStr}`);
console.log(`Generating ${TOTAL.toLocaleString()} pilgrim registrations...\n`);

// Clear existing simulation data for today (keep real registrations if enrollment_no <= 10)
db.prepare("DELETE FROM pilgrims WHERE created_at LIKE ? AND enrollment_no > 10").run(`${todayStr}%`);
db.prepare("DELETE FROM seva_config WHERE draw_date = ?").run(todayStr);

const insert = db.prepare(`INSERT INTO pilgrims
  (token, enrollment_no, name, phone, aadhaar_hash, aadhaar_encrypted, aadhaar_masked, id_type, seva, status, created_at, confirmed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const tokens = new Set();
function uniqueToken() {
  let t;
  do { t = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (tokens.has(t));
  tokens.add(t);
  return t;
}

// Get current max enrollment
const maxEnroll = db.prepare("SELECT MAX(enrollment_no) as m FROM pilgrims WHERE created_at LIKE ?").get(`${todayStr}%`);
let enrollStart = (maxEnroll.m || 0) + 1;

const startTime = Date.now();
const sevaCounts = {};
SEVAS.forEach(s => sevaCounts[s] = 0);

// Batch insert in transaction for speed
const batchSize = 5000;
let inserted = 0;

const runBatch = db.transaction((batch) => {
  for (const row of batch) {
    insert.run(...row);
  }
});

let batch = [];

for (let i = 0; i < TOTAL; i++) {
  const enrollNo = enrollStart + i;
  const token = uniqueToken();
  const firstName = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const lastName = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  const name = `${firstName} ${lastName}`;
  const phone = '9' + String(Math.floor(Math.random() * 900000000) + 100000000);
  const aadhaar = String(Math.floor(Math.random() * 900000000000) + 100000000000);
  const seva = SEVAS[Math.floor(Math.random() * SEVAS.length)];

  const aadhaarHash = hashId(aadhaar);
  const aadhaarEnc = encrypt(aadhaar);
  const aadhaarMasked = 'XXXX-XXXX-' + aadhaar.slice(-4);

  // Random time between 11:00 and 17:00
  const hour = 11 + Math.floor(Math.random() * 6);
  const min = String(Math.floor(Math.random() * 60)).padStart(2, '0');
  const sec = String(Math.floor(Math.random() * 60)).padStart(2, '0');
  const ampm = hour >= 12 ? 'pm' : 'am';
  const hour12 = hour > 12 ? hour - 12 : hour;
  const timeStr = `${String(hour12).padStart(2, '0')}:${min}:${sec} ${ampm}`;
  const createdAt = `${todayStr}, ${timeStr}`;
  const confirmedAt = `${todayStr}, ${timeStr}`; // auto-confirmed for simulation

  sevaCounts[seva]++;
  batch.push([token, enrollNo, name, phone, aadhaarHash, aadhaarEnc, aadhaarMasked, 'aadhaar', seva, 'confirmed', createdAt, confirmedAt]);

  if (batch.length >= batchSize) {
    runBatch(batch);
    inserted += batch.length;
    process.stdout.write(`\r  Inserted: ${inserted.toLocaleString()} / ${TOTAL.toLocaleString()}`);
    batch = [];
  }
}

if (batch.length > 0) {
  runBatch(batch);
  inserted += batch.length;
}

const insertTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\r  Inserted: ${inserted.toLocaleString()} / ${TOTAL.toLocaleString()} in ${insertTime}s`);

console.log(`\n--- Registrations per Seva ---`);
SEVAS.forEach(s => console.log(`  ${s.padEnd(32)} ${sevaCounts[s].toLocaleString()}`));

// Configure slots (realistic numbers)
const slotConfig = {
  'Suprabhatam': 100,
  'Thomala Seva': 80,
  'Archana': 200,
  'Astadala Pada Padmaradhana': 60,
  'Vishesha Pooja': 150,
  'Sahasra Deepalankara Seva': 120,
  'Nijapada Darshanam': 50
};

console.log(`\n--- Running Lucky Dip Draw ---`);
const drawTime = Date.now();

for (const seva of SEVAS) {
  const slots = slotConfig[seva];

  // Set config
  db.prepare(`INSERT INTO seva_config (seva_name, slots, draw_date) VALUES (?, ?, ?)
    ON CONFLICT(seva_name, draw_date) DO UPDATE SET slots = ?, drawn_at = NULL`
  ).run(seva, slots, todayStr, slots);

  // Get confirmed pilgrims for this seva
  const confirmed = db.prepare(
    "SELECT id FROM pilgrims WHERE seva = ? AND status = 'confirmed' AND created_at LIKE ? ORDER BY id"
  ).all(seva, `${todayStr}%`);

  // Fisher-Yates shuffle
  const ids = confirmed.map(r => r.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }

  const winnerIds = new Set(ids.slice(0, Math.min(slots, ids.length)));

  // Update in batches
  const updateAllotted = db.prepare("UPDATE pilgrims SET allotment_status = 'allotted' WHERE id = ?");
  const updateNot = db.prepare("UPDATE pilgrims SET allotment_status = 'not_allotted' WHERE id = ?");

  const runUpdate = db.transaction(() => {
    for (const id of ids) {
      if (winnerIds.has(id)) updateAllotted.run(id);
      else updateNot.run(id);
    }
    const now = `${todayStr}, 05:00:00 pm`;
    db.prepare("UPDATE seva_config SET drawn_at = ? WHERE seva_name = ? AND draw_date = ?").run(now, seva, todayStr);
  });

  runUpdate();

  const ratio = confirmed.length > 0 ? ((winnerIds.size / confirmed.length) * 100).toFixed(1) : 0;
  console.log(`  ${seva.padEnd(32)} ${String(confirmed.length).padStart(6)} applicants | ${String(winnerIds.size).padStart(4)} allotted | ${ratio}% success rate`);
}

const totalDrawTime = ((Date.now() - drawTime) / 1000).toFixed(1);
const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

// Final stats
const totalAllotted = db.prepare("SELECT COUNT(*) as c FROM pilgrims WHERE allotment_status = 'allotted' AND created_at LIKE ?").get(`${todayStr}%`);
const totalNot = db.prepare("SELECT COUNT(*) as c FROM pilgrims WHERE allotment_status = 'not_allotted' AND created_at LIKE ?").get(`${todayStr}%`);

console.log(`\n--- Summary ---`);
console.log(`  Total Pilgrims:    ${inserted.toLocaleString()}`);
console.log(`  Total Allotted:    ${totalAllotted.c.toLocaleString()}`);
console.log(`  Total Not Allotted: ${totalNot.c.toLocaleString()}`);
console.log(`  Insert Time:       ${insertTime}s`);
console.log(`  Draw Time:         ${totalDrawTime}s`);
console.log(`  Total Time:        ${totalTime}s`);
console.log(`\nDone! Refresh the operator dashboard to see results.\n`);
