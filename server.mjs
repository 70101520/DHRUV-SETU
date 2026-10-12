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
        response.end(JSON.stringify({ ok: false, error: error.message || 'SMTP connection failed.' }));
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
