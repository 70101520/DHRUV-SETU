import { createServer } from 'node:http';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'dist');
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';
let activeMailConfig = null;
const dataDirectory = join(fileURLToPath(new URL('.', import.meta.url)), '.data');
const mailLogFile = join(dataDirectory, 'mail-delivery.jsonl');
const auditLogFile = join(dataDirectory, 'audit.jsonl');
const mailKeyFile = join(dataDirectory, 'mail-config.key');
const mailConfigFile = join(dataDirectory, 'mail-config.enc');
mkdirSync(dataDirectory, { recursive: true });
const mailEncryptionKey = process.env.MAIL_CONFIG_KEY
  ? Buffer.from(process.env.MAIL_CONFIG_KEY, 'base64')
  : existsSync(mailKeyFile)
    ? Buffer.from(readFileSync(mailKeyFile, 'utf8'), 'base64')
    : randomBytes(32);
if (!process.env.MAIL_CONFIG_KEY && !existsSync(mailKeyFile)) writeFileSync(mailKeyFile, mailEncryptionKey.toString('base64'), { encoding: 'utf8', mode: 0o600 });
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const readJson = request => new Promise((resolve, reject) => {
  let body = '';
  request.on('data', chunk => {
    body += chunk;
    if (body.length > 20000) reject(new Error('Request is too large.'));
  });
  request.on('end', () => {
    try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON request.')); }
  });
  request.on('error', reject);
});

const smtpErrorMessage = (error, host = '') => {
  const text = String(error?.message || 'SMTP connection failed.');
  if (error?.code === 'EAUTH' || /535|BadCredentials|Username and Password not accepted/i.test(text)) {
    if (/gmail/i.test(host)) return 'Gmail rejected the login. Use a Google App Password, not your normal Gmail password. Enable 2-Step Verification first, then create an App Password.';
    if (/office365|outlook/i.test(host)) return 'Microsoft rejected the login. Confirm SMTP AUTH is enabled for this mailbox and use the password or app password allowed by your organization.';
    if (/zoho/i.test(host)) return 'Zoho rejected the login. Check the mailbox username, app-specific password and the SMTP host for your Zoho data center.';
    return 'The mail provider rejected the login. Check the SMTP username, password or app password, and confirm SMTP access is enabled.';
  }
  if (/wrong version number|ssl routines/i.test(text)) {
    return 'Security and port do not match. Use STARTTLS with port 587, or SSL/TLS with port 465.';
  }
  if (error?.code === 'ECONNECTION' || error?.code === 'ETIMEDOUT') {
    return 'Could not connect to the SMTP server. Check the host, port, firewall and internet connection.';
  }
  if (/certificate/i.test(text)) return 'SMTP certificate verification failed. Check the server hostname and security mode.';
  return 'SMTP test failed. Check the server details and credentials.';
};

const createMailTransport = config => nodemailer.createTransport({
  host: config.host,
  port: Number(config.port),
  secure: config.security === 'SSL/TLS' || Number(config.port) === 465,
  auth: { user: config.username, pass: config.password },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000
});

const saveMailConfig = config => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', mailEncryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  writeFileSync(mailConfigFile, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }), { encoding: 'utf8', mode: 0o600 });
};
const loadMailConfig = () => {
  if (!existsSync(mailConfigFile)) return null;
  try {
    const saved = JSON.parse(readFileSync(mailConfigFile, 'utf8'));
    const decipher = createDecipheriv('aes-256-gcm', mailEncryptionKey, Buffer.from(saved.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch { return null; }
};
activeMailConfig = loadMailConfig();

const applyMailVariables = (template, values) => String(template || '').replace(/{{(customer_name|docket_number|location|mobile_number)}}/g, (_, key) => values[key] || '');
const writeMailLog = entry => appendFileSync(mailLogFile, `${JSON.stringify({ id: randomUUID(), timestamp: new Date().toISOString(), ...entry })}\n`, 'utf8');
const readMailLogs = () => {
  if (!existsSync(mailLogFile)) return [];
  return readFileSync(mailLogFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(-100).reverse().map(line => JSON.parse(line));
};
const writeAuditLog = entry => appendFileSync(auditLogFile, `${JSON.stringify({ id: randomUUID(), timestamp: new Date().toISOString(), ...entry })}\n`, 'utf8');
const readAuditLogs = () => {
  if (!existsSync(auditLogFile)) return [];
  return readFileSync(auditLogFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(-500).reverse().map(line => JSON.parse(line));
};

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (requestUrl.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ status: 'ok', service: 'dhruv-setu-crm' }));
    return;
  }

  if (requestUrl.pathname === '/api/mail/logs' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ ok: true, smtpActive: Boolean(activeMailConfig), logs: readMailLogs() }));
    return;
  }

  if (requestUrl.pathname === '/api/audit' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ ok: true, logs: readAuditLogs() }));
    return;
  }

  if (requestUrl.pathname === '/api/audit' && request.method === 'POST') {
    readJson(request).then(entry => {
      writeAuditLog({
        action: String(entry.action || 'Unknown action').slice(0, 100),
        status: ['success', 'failed', 'info'].includes(entry.status) ? entry.status : 'info',
        user: String(entry.user || 'System').slice(0, 100),
        role: String(entry.role || 'System').slice(0, 40),
        docketId: String(entry.docketId || '').slice(0, 80),
        details: String(entry.details || '').slice(0, 500)
      });
      response.writeHead(201, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: true }));
    }).catch(error => {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: error.message }));
    });
    return;
  }

  if (requestUrl.pathname === '/api/mail/test' && request.method === 'POST') {
    readJson(request).then(async config => {
      const { host, port, security, username, password, sender, recipient } = config;
      if (!host || !port || !username || !password || !sender || !recipient) {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: false, error: 'Complete all SMTP and test recipient fields.' }));
        return;
      }
      if ((Number(port) === 587 && security !== 'STARTTLS') || (Number(port) === 465 && security !== 'SSL/TLS')) {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: false, error: 'Use STARTTLS with port 587, or SSL/TLS with port 465.' }));
        return;
      }
      try {
        const normalizedUsername = String(username).trim();
        const normalizedPassword = /gmail/i.test(host) ? String(password).replace(/\s+/g, '') : String(password);
        const smtpConfig = { host, port, security, username: normalizedUsername, password: normalizedPassword, sender };
        const transport = createMailTransport(smtpConfig);
        await transport.verify();
        const result = await transport.sendMail({
          from: sender,
          to: recipient,
          subject: 'Dhruv-Setu CRM - SMTP test successful',
          text: 'Your SMTP configuration is working correctly. This test was sent from Dhruv-Setu CRM.'
        });
        activeMailConfig = smtpConfig;
        saveMailConfig(smtpConfig);
        writeMailLog({ type: 'smtp-test', status: 'sent', recipient, provider: host, messageId: result.messageId });
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: true, messageId: result.messageId }));
      } catch (error) {
        writeMailLog({ type: 'smtp-test', status: 'failed', recipient, provider: host, error: smtpErrorMessage(error, host) });
        response.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: false, error: smtpErrorMessage(error, host) }));
      }
    }).catch(error => {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: error.message }));
    });
    return;
  }

  if (requestUrl.pathname === '/api/mail/send-docket' && request.method === 'POST') {
    readJson(request).then(async payload => {
      if (!activeMailConfig) {
        writeMailLog({ type: 'docket-confirmation', status: 'failed', recipient: payload.email || '', docketId: payload.id || '', error: 'SMTP is not active.' });
        response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: false, error: 'SMTP is not active. Open Mail Configuration and send a successful test email first.' }));
        return;
      }
      const recipient = String(payload.email || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: false, error: 'Customer email address is invalid.' }));
        return;
      }
      const values = {
        customer_name: String(payload.name || ''),
        docket_number: String(payload.id || ''),
        location: String(payload.location || ''),
        mobile_number: String(payload.number || '')
      };
      try {
        const transport = createMailTransport(activeMailConfig);
        const subject = applyMailVariables(payload.subject || 'Your docket {{docket_number}}', values).replace(/[\r\n]+/g, ' ').slice(0, 180);
        const text = applyMailVariables(payload.body || 'Hello {{customer_name}}, your docket {{docket_number}} has been created.', values);
        const result = await transport.sendMail({ from: activeMailConfig.sender, to: recipient, subject, text });
        writeMailLog({ type: 'docket-confirmation', status: 'sent', recipient, docketId: values.docket_number, provider: activeMailConfig.host, messageId: result.messageId });
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: true, messageId: result.messageId }));
      } catch (error) {
        writeMailLog({ type: 'docket-confirmation', status: 'failed', recipient, docketId: values.docket_number, provider: activeMailConfig.host, error: smtpErrorMessage(error, activeMailConfig.host) });
        response.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: false, error: smtpErrorMessage(error, activeMailConfig.host) }));
      }
    }).catch(error => {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: error.message }));
    });
    return;
  }

  const decoded = decodeURIComponent(requestUrl.pathname);
  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  let file = join(root, relative || 'index.html');

  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(root, 'index.html');
  }

  response.writeHead(200, {
    'content-type': mime[extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store, max-age=0',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
    'referrer-policy': 'strict-origin-when-cross-origin'
  });
  createReadStream(file).pipe(response);
});

server.listen(port, host, () => {
  console.log(`Dhruv-Setu CRM is running at http://localhost:${port}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
