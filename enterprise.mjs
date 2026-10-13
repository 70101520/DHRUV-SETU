import pg from 'pg';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || '';
const pool = databaseUrl ? new Pool({
  connectionString: databaseUrl,
  max: Number(process.env.DB_POOL_MAX || 20),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false
}) : null;

const json = (response, status, body, headers = {}) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
};
const readBody = request => new Promise((resolve, reject) => {
  let body = '';
  request.on('data', chunk => {
    body += chunk;
    if (body.length > 100000) reject(new Error('Request is too large.'));
  });
  request.on('end', () => {
    try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON request.')); }
  });
  request.on('error', reject);
});
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const cookie = request => Object.fromEntries(String(request.headers.cookie || '').split(';').map(value => value.trim().split('=').map(decodeURIComponent)).filter(value => value.length === 2));
const sessionCookie = (token, maxAge = 28800) => `ds_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`;
const clean = (value, max = 500) => String(value || '').trim().slice(0, max);

export const databaseStatus = () => ({ configured: Boolean(pool) });

export async function initializeEnterpriseDatabase() {
  if (!pool) return false;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id uuid PRIMARY KEY, name varchar(160) NOT NULL, slug varchar(80) UNIQUE NOT NULL,
      settings jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
      user_id varchar(80) NOT NULL, email varchar(255) NOT NULL, name varchar(160) NOT NULL,
      password_hash varchar(255) NOT NULL, role varchar(20) NOT NULL CHECK (role IN ('user','support','admin')),
      active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, user_id), UNIQUE (organization_id, email)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash char(64) PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
    CREATE SEQUENCE IF NOT EXISTS docket_number_seq START 1000;
    CREATE TABLE IF NOT EXISTS dockets (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
      docket_number varchar(40) NOT NULL, mobile varchar(30) NOT NULL, customer_name varchar(160) NOT NULL,
      email varchar(255) NOT NULL, location varchar(255) NOT NULL, address text NOT NULL DEFAULT '',
      query text NOT NULL, remark text NOT NULL DEFAULT '', custom_values jsonb NOT NULL DEFAULT '{}'::jsonb,
      status varchar(30) NOT NULL DEFAULT 'New', email_status varchar(30) NOT NULL DEFAULT 'Not sent',
      email_error text NOT NULL DEFAULT '', created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, docket_number)
    );
    CREATE INDEX IF NOT EXISTS dockets_org_created_idx ON dockets(organization_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS dockets_org_status_idx ON dockets(organization_id, status, created_at DESC);
    CREATE TABLE IF NOT EXISTS docket_notes (
      id uuid PRIMARY KEY, docket_id uuid NOT NULL REFERENCES dockets(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id), note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS docket_notes_docket_idx ON docket_notes(docket_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS custom_fields (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
      label varchar(160) NOT NULL, type varchar(20) NOT NULL CHECK (type IN ('Dropdown','Checkbox')),
      options text NOT NULL DEFAULT '', enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS custom_fields_org_idx ON custom_fields(organization_id, id);
    CREATE TABLE IF NOT EXISTS audit_logs (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), user_id uuid REFERENCES users(id),
      action varchar(100) NOT NULL, status varchar(20) NOT NULL, docket_id varchar(80) NOT NULL DEFAULT '',
      details varchar(500) NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS audit_org_created_idx ON audit_logs(organization_id, created_at DESC);
  `);
  const organizationId = '00000000-0000-4000-8000-000000000001';
  await pool.query('INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3) ON CONFLICT (id) DO NOTHING', [organizationId, process.env.DEFAULT_ORG_NAME || 'Dhruv-Setu', 'default']);
  await pool.query(`UPDATE organizations SET settings = $2 WHERE id=$1 AND settings='{}'::jsonb`, [organizationId, {
    brand: { name: 'Dhruv-Setu', label: 'Customer Operations CRM', headline: 'Customer operations, simplified.', description: 'Capture enquiries, coordinate teams and resolve every request from one secure workspace.' },
    reportsAllowed: true,
    mailTemplate: { subject: 'Your request {{docket_number}}', body: 'Hello {{customer_name}},\n\nYour docket {{docket_number}} has been created for {{location}}.' }
  }]);
  const seeds = [
    ['00000000-0000-4000-8000-000000000101', 'user', 'user@dhruvsetu.in', 'Amit Kumar', process.env.SEED_USER_PASSWORD || 'user123', 'user'],
    ['00000000-0000-4000-8000-000000000102', 'support', 'support@dhruvsetu.in', 'Priya Support', process.env.SEED_SUPPORT_PASSWORD || 'support123', 'support'],
    ['00000000-0000-4000-8000-000000000103', 'admin', 'admin@dhruvsetu.in', 'Balram Admin', process.env.SEED_ADMIN_PASSWORD || 'admin123', 'admin']
  ];
  for (const [id, userId, email, name, password, role] of seeds) {
    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query(`INSERT INTO users(id,organization_id,user_id,email,name,password_hash,role)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`, [id, organizationId, userId, email, name, passwordHash, role]);
  }
  const fieldCount = Number((await pool.query('SELECT count(*) count FROM custom_fields WHERE organization_id=$1', [organizationId])).rows[0].count);
  if (!fieldCount) await pool.query(`INSERT INTO custom_fields(organization_id,label,type,options) VALUES
    ($1,'Preferred Hotel Category','Dropdown','3 Star, 4 Star, 5 Star'),($1,'Need Airport Pickup?','Checkbox','')`, [organizationId]);
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  return true;
}

async function authenticate(request) {
  if (!pool) return null;
  const token = cookie(request).ds_session;
  if (!token) return null;
  const { rows } = await pool.query(`SELECT u.id,u.organization_id,u.user_id,u.email,u.name,u.role
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true`, [tokenHash(token)]);
  return rows[0] || null;
}

const docketDto = row => ({
  id: row.docket_number, number: row.mobile, name: row.customer_name, email: row.email,
  location: row.location, address: row.address, query: row.query, remark: row.remark,
  status: row.status, emailStatus: row.email_status, emailError: row.email_error,
  created: row.created_at.toISOString().slice(0, 10), owner: row.owner_name || '', notes: row.notes || [],
  ...(row.custom_values || {})
});

export async function handleEnterprise(request, response, requestUrl) {
  if (!requestUrl.pathname.startsWith('/api/')) return false;
  if (!pool) {
    if (requestUrl.pathname.startsWith('/api/auth') || requestUrl.pathname.startsWith('/api/dockets') || requestUrl.pathname === '/api/bootstrap') {
      json(response, 503, { ok: false, error: 'Enterprise database is not configured. Set DATABASE_URL or use Docker Compose.' });
      return true;
    }
    return false;
  }

  if (requestUrl.pathname === '/api/auth/login' && request.method === 'POST') {
    const body = await readBody(request);
    const login = clean(body.login, 255).toLowerCase();
    const { rows } = await pool.query('SELECT * FROM users WHERE active=true AND (lower(user_id)=$1 OR lower(email)=$1) LIMIT 1', [login]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(String(body.password || ''), user.password_hash))) {
      await new Promise(resolve => setTimeout(resolve, 250));
      json(response, 401, { ok: false, error: 'Incorrect login ID or password.' });
      return true;
    }
    const token = randomBytes(32).toString('base64url');
    await pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval \'8 hours\')', [tokenHash(token), user.id]);
    await pool.query('INSERT INTO audit_logs(id,organization_id,user_id,action,status,details) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), user.organization_id, user.id, 'Login', 'success', 'User signed in']);
    json(response, 200, { ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } }, { 'set-cookie': sessionCookie(token) });
    return true;
  }

  const user = await authenticate(request);
  if (!user) {
    json(response, 401, { ok: false, error: 'Your session has expired. Please sign in again.' });
    return true;
  }
  request.crmUser = user;

  if (requestUrl.pathname === '/api/auth/me' && request.method === 'GET') {
    json(response, 200, { ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    return true;
  }
  if (requestUrl.pathname === '/api/auth/logout' && request.method === 'POST') {
    const token = cookie(request).ds_session;
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash(token)]);
    json(response, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
    return true;
  }
  if (requestUrl.pathname === '/api/bootstrap' && request.method === 'GET') {
    const [docketsResult, notesResult, fieldsResult, usersResult, organizationResult] = await Promise.all([
      pool.query(`SELECT d.*,u.name owner_name FROM dockets d JOIN users u ON u.id=d.created_by WHERE d.organization_id=$1 ORDER BY d.created_at DESC LIMIT 500`, [user.organization_id]),
      pool.query(`SELECT n.docket_id,n.note text,n.created_at date,u.name author FROM docket_notes n JOIN dockets d ON d.id=n.docket_id JOIN users u ON u.id=n.user_id WHERE d.organization_id=$1 ORDER BY n.created_at`, [user.organization_id]),
      pool.query('SELECT id,label,type,options,enabled FROM custom_fields WHERE organization_id=$1 ORDER BY id', [user.organization_id]),
      pool.query('SELECT id,name,email,role,active FROM users WHERE organization_id=$1 ORDER BY created_at', [user.organization_id]),
      pool.query('SELECT name,settings FROM organizations WHERE id=$1', [user.organization_id])
    ]);
    const notesByDocket = new Map();
    for (const note of notesResult.rows) {
      const list = notesByDocket.get(note.docket_id) || [];
      list.push({ text: note.text, author: note.author, date: note.date.toLocaleString('en-IN') });
      notesByDocket.set(note.docket_id, list);
    }
    const settings = organizationResult.rows[0]?.settings || {};
    json(response, 200, {
      ok: true,
      dockets: docketsResult.rows.map(row => docketDto({ ...row, notes: notesByDocket.get(row.id) || [] })),
      fields: fieldsResult.rows,
      team: usersResult.rows.map(member => ({ id: member.id, name: member.name, email: member.email, role: member.role[0].toUpperCase() + member.role.slice(1), status: member.active ? 'Active' : 'Inactive' })),
      brand: settings.brand,
      reportsAllowed: settings.reportsAllowed !== false,
      mailTemplate: settings.mailTemplate
    });
    return true;
  }
  if (requestUrl.pathname === '/api/dockets' && request.method === 'POST') {
    const body = await readBody(request);
    if (!clean(body.number, 30) || !clean(body.name, 160) || !clean(body.email, 255) || !clean(body.location, 255) || !clean(body.query, 5000)) {
      json(response, 400, { ok: false, error: 'Complete all required docket fields.' });
      return true;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sequence = (await client.query("SELECT nextval('docket_number_seq') value")).rows[0].value;
      const docketNumber = `DS-${new Date().toISOString().slice(2, 10).replaceAll('-', '')}-${sequence}`;
      const customValues = Object.fromEntries(Object.entries(body).filter(([key]) => key.startsWith('field_')).map(([key, value]) => [key, value]));
      const { rows } = await client.query(`INSERT INTO dockets(id,organization_id,docket_number,mobile,customer_name,email,location,address,query,remark,custom_values,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [randomUUID(), user.organization_id, docketNumber, clean(body.number, 30), clean(body.name, 160), clean(body.email, 255), clean(body.location, 255), clean(body.address, 5000), clean(body.query, 10000), clean(body.remark, 10000), customValues, user.id]);
      await client.query('INSERT INTO audit_logs(id,organization_id,user_id,action,status,docket_id,details) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), user.organization_id, user.id, 'Docket created', 'success', docketNumber, `${clean(body.name, 160)} - ${clean(body.location, 255)}`]);
      await client.query('COMMIT');
      json(response, 201, { ok: true, docket: docketDto({ ...rows[0], owner_name: user.name }) });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    return true;
  }

  const docketMatch = requestUrl.pathname.match(/^\/api\/dockets\/([^/]+)$/);
  if (docketMatch && request.method === 'PATCH') {
    const body = await readBody(request);
    const status = ['New', 'In Progress', 'Closed'].includes(body.status) ? body.status : null;
    if (!status) { json(response, 400, { ok: false, error: 'Invalid docket status.' }); return true; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('UPDATE dockets SET status=$1,updated_at=now() WHERE organization_id=$2 AND docket_number=$3 RETURNING id', [status, user.organization_id, decodeURIComponent(docketMatch[1])]);
      if (!rows[0]) { await client.query('ROLLBACK'); json(response, 404, { ok: false, error: 'Docket not found.' }); return true; }
      const note = clean(body.note, 5000);
      if (note) await client.query('INSERT INTO docket_notes(id,docket_id,user_id,note) VALUES($1,$2,$3,$4)', [randomUUID(), rows[0].id, user.id, note]);
      await client.query('INSERT INTO audit_logs(id,organization_id,user_id,action,status,docket_id,details) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), user.organization_id, user.id, 'Docket updated', 'success', decodeURIComponent(docketMatch[1]), `Status changed to ${status}`]);
      await client.query('COMMIT');
      json(response, 200, { ok: true });
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return true;
  }

  if (requestUrl.pathname === '/api/settings' && request.method === 'PUT') {
    if (user.role !== 'admin') { json(response, 403, { ok: false, error: 'Administrator access is required.' }); return true; }
    const body = await readBody(request);
    const allowed = {};
    if (body.brand) allowed.brand = { name: clean(body.brand.name, 160), label: clean(body.brand.label, 160), headline: clean(body.brand.headline, 200), description: clean(body.brand.description, 1000) };
    if (typeof body.reportsAllowed === 'boolean') allowed.reportsAllowed = body.reportsAllowed;
    if (body.mailTemplate) allowed.mailTemplate = { subject: clean(body.mailTemplate.subject, 180), body: clean(body.mailTemplate.body, 10000) };
    await pool.query('UPDATE organizations SET settings=settings || $1::jsonb, name=COALESCE(NULLIF($2,\'\'),name) WHERE id=$3', [JSON.stringify(allowed), allowed.brand?.name || '', user.organization_id]);
    json(response, 200, { ok: true });
    return true;
  }

  if (requestUrl.pathname === '/api/custom-fields' && request.method === 'POST') {
    if (user.role !== 'admin') { json(response, 403, { ok: false, error: 'Administrator access is required.' }); return true; }
    const body = await readBody(request);
    const type = ['Dropdown', 'Checkbox'].includes(body.type) ? body.type : null;
    if (!clean(body.label, 160) || !type) { json(response, 400, { ok: false, error: 'Field label and type are required.' }); return true; }
    const { rows } = await pool.query('INSERT INTO custom_fields(organization_id,label,type,options,enabled) VALUES($1,$2,$3,$4,true) RETURNING id,label,type,options,enabled', [user.organization_id, clean(body.label, 160), type, clean(body.options, 2000)]);
    json(response, 201, { ok: true, field: rows[0] }); return true;
  }
  const fieldMatch = requestUrl.pathname.match(/^\/api\/custom-fields\/(\d+)$/);
  if (fieldMatch && request.method === 'PUT') {
    if (user.role !== 'admin') { json(response, 403, { ok: false, error: 'Administrator access is required.' }); return true; }
    const body = await readBody(request);
    const type = ['Dropdown', 'Checkbox'].includes(body.type) ? body.type : null;
    const { rows } = await pool.query(`UPDATE custom_fields SET label=COALESCE($1,label),type=COALESCE($2,type),options=COALESCE($3,options),enabled=COALESCE($4,enabled)
      WHERE id=$5 AND organization_id=$6 RETURNING id,label,type,options,enabled`, [body.label === undefined ? null : clean(body.label, 160), type, body.options === undefined ? null : clean(body.options, 2000), typeof body.enabled === 'boolean' ? body.enabled : null, fieldMatch[1], user.organization_id]);
    if (!rows[0]) { json(response, 404, { ok: false, error: 'Custom field not found.' }); return true; }
    json(response, 200, { ok: true, field: rows[0] }); return true;
  }
  if (fieldMatch && request.method === 'DELETE') {
    if (user.role !== 'admin') { json(response, 403, { ok: false, error: 'Administrator access is required.' }); return true; }
    await pool.query('DELETE FROM custom_fields WHERE id=$1 AND organization_id=$2', [fieldMatch[1], user.organization_id]);
    json(response, 200, { ok: true }); return true;
  }

  if (requestUrl.pathname === '/api/users' && request.method === 'POST') {
    if (user.role !== 'admin') { json(response, 403, { ok: false, error: 'Administrator access is required.' }); return true; }
    const body = await readBody(request);
    const role = ['user', 'support', 'admin'].includes(String(body.role).toLowerCase()) ? String(body.role).toLowerCase() : null;
    if (!clean(body.name, 160) || !clean(body.email, 255) || !clean(body.password, 200) || !role) { json(response, 400, { ok: false, error: 'Complete all user fields.' }); return true; }
    const passwordHash = await bcrypt.hash(String(body.password), 12);
    try {
      const { rows } = await pool.query(`INSERT INTO users(id,organization_id,user_id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5,$6,$7)
        RETURNING id,name,email,role,active`, [randomUUID(), user.organization_id, clean(body.email, 255).toLowerCase(), clean(body.email, 255).toLowerCase(), clean(body.name, 160), passwordHash, role]);
      const member = rows[0];
      json(response, 201, { ok: true, user: { id: member.id, name: member.name, email: member.email, role: member.role[0].toUpperCase() + member.role.slice(1), status: 'Active' } });
    } catch (error) {
      if (error.code === '23505') { json(response, 409, { ok: false, error: 'This email or login ID already exists.' }); return true; }
      throw error;
    }
    return true;
  }
  const userMatch = requestUrl.pathname.match(/^\/api\/users\/([0-9a-f-]+)$/i);
  if (userMatch && request.method === 'PATCH') {
    if (user.role !== 'admin') { json(response, 403, { ok: false, error: 'Administrator access is required.' }); return true; }
    if (userMatch[1] === user.id) { json(response, 400, { ok: false, error: 'You cannot disable your own account.' }); return true; }
    const body = await readBody(request);
    await pool.query('UPDATE users SET active=$1 WHERE id=$2 AND organization_id=$3', [Boolean(body.active), userMatch[1], user.organization_id]);
    if (!body.active) await pool.query('DELETE FROM sessions WHERE user_id=$1', [userMatch[1]]);
    json(response, 200, { ok: true }); return true;
  }

  const adminOnly = ['/api/mail/config', '/api/mail/test'];
  if (adminOnly.includes(requestUrl.pathname) && user.role !== 'admin') {
    json(response, 403, { ok: false, error: 'Administrator access is required.' });
    return true;
  }
  if (requestUrl.pathname === '/api/audit' && request.method === 'POST') {
    const entry = await readBody(request);
    await pool.query('INSERT INTO audit_logs(id,organization_id,user_id,action,status,docket_id,details) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), user.organization_id, user.id, clean(entry.action || 'Unknown action', 100), ['success','failed','info'].includes(entry.status) ? entry.status : 'info', clean(entry.docketId, 80), clean(entry.details, 500)]);
    json(response, 201, { ok: true });
    return true;
  }
  if (requestUrl.pathname === '/api/audit' && request.method === 'GET') {
    if (user.role === 'user') { json(response, 403, { ok: false, error: 'Support or administrator access is required.' }); return true; }
    const { rows } = await pool.query(`SELECT a.created_at timestamp,a.action,a.status,a.docket_id "docketId",a.details,u.name "user",u.role
      FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.organization_id=$1 ORDER BY a.created_at DESC LIMIT 500`, [user.organization_id]);
    json(response, 200, { ok: true, logs: rows });
    return true;
  }
  return false;
}

export async function closeEnterpriseDatabase() { if (pool) await pool.end(); }

export async function updateDocketEmailStatus(organizationId, docketNumber, status, error = '') {
  if (!pool || !organizationId || !docketNumber) return;
  await pool.query('UPDATE dockets SET email_status=$1,email_error=$2,updated_at=now() WHERE organization_id=$3 AND docket_number=$4', [status, clean(error, 2000), organizationId, clean(docketNumber, 80)]);
}
