import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'dist');
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';
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

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (requestUrl.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ status: 'ok', service: 'dhruv-setu-crm' }));
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
        const transport = nodemailer.createTransport({
          host,
          port: Number(port),
          secure: security === 'SSL/TLS' || Number(port) === 465,
          auth: { user: username, pass: password },
          connectionTimeout: 10000,
          greetingTimeout: 10000,
          socketTimeout: 15000
        });
        await transport.verify();
        const result = await transport.sendMail({
          from: sender,
          to: recipient,
          subject: 'Dhruv-Setu CRM - SMTP test successful',
          text: 'Your SMTP configuration is working correctly. This test was sent from Dhruv-Setu CRM.'
        });
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: true, messageId: result.messageId }));
      } catch (error) {
        response.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: false, error: smtpErrorMessage(error, host) }));
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
