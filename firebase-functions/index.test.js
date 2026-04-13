/* global jest, describe, it, expect, beforeAll, beforeEach, afterEach */

// ── Mocks ────────────────────────────────────────────────────────────────────

// Capture the Express app that gets passed to onRequest
let capturedApp;
jest.mock('firebase-functions/v2/https', () => ({
  onRequest: (_opts, app) => {
    capturedApp = app;
    return app;
  },
}));

jest.mock('firebase-functions/params', () => ({
  defineSecret: () => ({ value: () => '' }),
}));

jest.mock('firebase-functions/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('@google-cloud/recaptcha-enterprise', () => ({
  RecaptchaEnterpriseServiceClient: jest.fn(),
}));

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: jest.fn() })),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const http = require('http');

/** Minimal supertest-like helper using http.get (avoids globalThis.fetch mock) */
function request(app) {
  const server = http.createServer(app);
  return {
    get(urlPath) {
      return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address();
          http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              server.close();
              let body = null;
              try { body = JSON.parse(data); } catch (_) { /* ignore */ }
              resolve({ status: res.statusCode, body, headers: res.headers });
            });
          }).on('error', (err) => {
            server.close();
            reject(err);
          });
        });
      });
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('proxyJson auth behaviour', () => {
  let originalFetch;
  let fetchSpy;

  beforeAll(() => {
    // Set the API key env var so authenticated routes can work
    process.env.DISCOURSE_API_KEY = 'test-api-key-123';
    process.env.DISCOURSE_API_BASE = 'https://forums.jtechforums.org';
    // Require after mocks are in place
    require('./index');
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ users: [{ id: 1, username: 'alice' }] }),
      text: async () => '',
    });
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('leaderboard route does NOT send Api-Key / Api-Username headers', async () => {
    const res = await request(capturedApp).get('/forum/leaderboard/6?period=monthly');

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [, fetchOpts] = fetchSpy.mock.calls[0];
    expect(fetchOpts.headers).not.toHaveProperty('Api-Key');
    expect(fetchOpts.headers).not.toHaveProperty('Api-Username');
    expect(fetchOpts.headers).toHaveProperty('Accept', 'application/json');
  });

  it('leaderboard route builds the correct Discourse URL', async () => {
    await request(capturedApp).get('/forum/leaderboard/6?period=monthly');

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://forums.jtechforums.org/leaderboard/6.json?period=monthly');
  });

  it('/forum/latest route DOES send Api-Key and Api-Username headers', async () => {
    const res = await request(capturedApp).get('/forum/latest');

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [, fetchOpts] = fetchSpy.mock.calls[0];
    expect(fetchOpts.headers).toHaveProperty('Api-Key', 'test-api-key-123');
    expect(fetchOpts.headers).toHaveProperty('Api-Username', 'system');
  });

  it('/forum/about route DOES send Api-Key and Api-Username headers', async () => {
    const res = await request(capturedApp).get('/forum/about');

    expect(res.status).toBe(200);
    const [, fetchOpts] = fetchSpy.mock.calls[0];
    expect(fetchOpts.headers).toHaveProperty('Api-Key', 'test-api-key-123');
    expect(fetchOpts.headers).toHaveProperty('Api-Username', 'system');
  });

  it('/forum/topic/:id route DOES send Api-Key and Api-Username headers', async () => {
    const res = await request(capturedApp).get('/forum/topic/42');

    expect(res.status).toBe(200);
    const [, fetchOpts] = fetchSpy.mock.calls[0];
    expect(fetchOpts.headers).toHaveProperty('Api-Key', 'test-api-key-123');
  });

  it('leaderboard still works even without DISCOURSE_API_KEY', async () => {
    const saved = process.env.DISCOURSE_API_KEY;
    delete process.env.DISCOURSE_API_KEY;

    const res = await request(capturedApp).get('/forum/leaderboard/6');

    // Should succeed because auth is false — no key needed
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, fetchOpts] = fetchSpy.mock.calls[0];
    expect(fetchOpts.headers).not.toHaveProperty('Api-Key');

    process.env.DISCOURSE_API_KEY = saved;
  });

  it('authenticated route returns 500 when API key is missing', async () => {
    const saved = process.env.DISCOURSE_API_KEY;
    delete process.env.DISCOURSE_API_KEY;

    const res = await request(capturedApp).get('/forum/latest');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/not configured/i);
    // fetch should NOT have been called
    expect(fetchSpy).not.toHaveBeenCalled();

    process.env.DISCOURSE_API_KEY = saved;
  });

  it('leaderboard returns 400 for invalid id', async () => {
    const res = await request(capturedApp).get('/forum/leaderboard/abc');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
