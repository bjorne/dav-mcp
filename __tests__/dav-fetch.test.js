import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { createServer } from 'node:http';
import { createDavFetch, createTokenFetch } from '../src/dav-fetch.js';
import { tsdavManager } from '../src/tsdav-client.js';
import { updateCalendar } from '../src/tools/calendar/update-calendar.js';

// These tests use the installed tsdav build and real HTTP, not mocked client methods.
let trusted, foreign, trustedUrl, foreignUrl;
let trustedRequests = [], foreignRequests = [], mode;
const dummyConfig = { username: 'test-user', password: 'test-password' };
const xml = (href, props) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="urn:ietf:params:xml:ns:carddav"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});
const close = (server) => new Promise(resolve => {
  if (!server) return resolve();
  server.close(resolve);
  server.closeAllConnections();
});

beforeAll(async () => {
  foreign = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    foreignRequests.push({ url: req.url, headers: req.headers, body });
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'token-redirect') {
      res.writeHead(307, { Location: `${trustedUrl}/stolen-token` });
      res.end();
    } else res.end(JSON.stringify({ access_token: 'dummy-access-token' }));
  });
  foreignUrl = await listen(foreign);
  trusted = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    trustedRequests.push({ url: req.url, method: req.method, headers: req.headers, body });
    if (req.url.startsWith('/redirect/')) {
      res.writeHead(Number(req.url.split('/')[2]), { Location: `${foreignUrl}/stolen` });
      res.end();
    } else if (req.url.startsWith('/.well-known/')) {
      res.writeHead(302, { Location: mode === 'discovery-redirect' ? foreignUrl : '/dav/' });
      res.end();
    } else if (req.url === '/dav/') {
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(xml('/dav/', `<d:current-user-principal><d:href>${mode === 'principal' ? foreignUrl : trustedUrl}/principal/</d:href></d:current-user-principal>`));
    } else if (req.url === '/principal/') {
      const home = mode === 'home' ? foreignUrl : trustedUrl;
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(xml('/principal/', `<c:calendar-home-set><d:href>${home}/cal/</d:href></c:calendar-home-set><a:addressbook-home-set><d:href>${home}/cards/</d:href></a:addressbook-home-set>`));
    } else if (req.method === 'PROPFIND' || req.method === 'REPORT') {
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(mode === 'object'
        ? xml(`${foreignUrl}/object.ics`, '<d:getetag>"1"</d:getetag><c:calendar-data>BEGIN:VCALENDAR\r\nEND:VCALENDAR</c:calendar-data>')
        : '<d:multistatus xmlns:d="DAV:"/>');
    } else {
      res.writeHead(204, { ETag: '"2"' });
      res.end();
    }
  });
  trustedUrl = await listen(trusted);
});
afterAll(async () => { await Promise.all([close(trusted), close(foreign)]); });
beforeEach(() => { trustedRequests = []; foreignRequests = []; mode = 'normal'; });

async function initialize(extra = {}) {
  await tsdavManager.initialize({ ...dummyConfig, serverUrl: `${trustedUrl}/dav/`, ...extra });
}

const operations = [
  ['updateCalendarObject', url => ({ calendarObject: { url, etag: '"1"', data: 'private event' } })],
  ['deleteCalendarObject', url => ({ calendarObject: { url, etag: '"1"' } })],
  ['createCalendarObject', url => ({ calendar: { url }, filename: 'event.ics', iCalString: 'UID:1' })],
  ['fetchCalendarObjects', url => ({ calendar: { url } })],
  ['calendarQuery', url => ({ url, props: {} })],
  ['calendarMultiGet', url => ({ url, props: {}, objectUrls: [`${url}/event.ics`] })],
  ['updateVCard', url => ({ vCard: { url, etag: '"1"', data: 'private contact' } })],
  ['deleteVCard', url => ({ vCard: { url, etag: '"1"' } })],
  ['createVCard', url => ({ addressBook: { url }, filename: 'contact.vcf', vCardString: 'UID:1' })],
  ['fetchVCards', url => ({ addressBook: { url } })],
  ['addressBookQuery', url => ({ url, props: {} })],
  ['addressBookMultiGet', url => ({ url, props: {}, objectUrls: [`${url}/contact.vcf`] })],
  ['updateTodo', url => ({ calendarObject: { url, etag: '"1"', data: 'private task' } })],
  ['deleteTodo', url => ({ calendarObject: { url, etag: '"1"' } })],
  ['createTodo', url => ({ calendar: { url }, filename: 'task.ics', iCalString: 'UID:1' })],
  ['fetchTodos', url => ({ calendar: { url } })],
  ['todoQuery', url => ({ url, props: {} })],
  ['todoMultiGet', url => ({ url, props: {}, objectUrls: [`${url}/task.ics`] })],
  ['makeCalendar', url => ({ url, props: {} })],
  ['makeAddressBook', url => ({ url, props: {} })],
  ['deleteObject', url => ({ url })],
];

describe('every DAV operation uses the confined transport', () => {
  test.each(operations)('%s blocks a foreign destination before sending anything', async (method, args) => {
    await initialize();
    await expect(tsdavManager.getCalDavClient()[method](args(`${foreignUrl}/private/`)))
      .rejects.toThrow('DAV URL is not allowed');
    expect(foreignRequests).toEqual([]);
  });

  test.each(operations)('%s still reaches the configured origin', async (method, args) => {
    await initialize();
    trustedRequests = [];
    await tsdavManager.getCalDavClient()[method](args(`${trustedUrl}/private/`));
    expect(trustedRequests.length).toBeGreaterThan(0);
    expect(trustedRequests.every(r => r.headers.authorization === `Basic ${Buffer.from('test-user:test-password').toString('base64')}`)).toBe(true);
    expect(foreignRequests).toEqual([]);
  });

  test('direct calendar PROPPATCH cannot bypass confinement', async () => {
    await initialize();
    await expect(updateCalendar.handler({ calendar_url: `${foreignUrl}/cal/`, display_name: 'Private' }))
      .rejects.toThrow('DAV URL is not allowed');
    expect(foreignRequests).toEqual([]);
  });

  test.each([301, 302, 303, 307, 308])('does not follow HTTP %s, even with explicit follow options', async status => {
    await initialize();
    await expect(tsdavManager.getCalDavClient().updateCalendarObject({
      calendarObject: { url: `${trustedUrl}/redirect/${status}`, etag: '"1"', data: 'private' },
      fetchOptions: { redirect: 'follow' },
    })).rejects.toThrow('redirects are not allowed');
    expect(foreignRequests).toEqual([]);
  });
});

describe('discovery and returned URLs', () => {
  test('valid login stays on origin, with different discovery and collection paths', async () => {
    await initialize();
    expect(tsdavManager.getCalDavClient().account.homeUrl).toBe(`${trustedUrl}/cal/`);
    expect(tsdavManager.getCardDavClient().account.homeUrl).toBe(`${trustedUrl}/cards/`);
    expect(trustedRequests.some(r => r.url === '/.well-known/caldav')).toBe(true);
  });
  test('a hostile discovery redirect is never followed', async () => {
    mode = 'discovery-redirect';
    // tsdav falls back to the configured URL after discovery failure.
    await initialize();
    expect(foreignRequests).toEqual([]);
  });
  test('a hostile principal is blocked during login', async () => {
    mode = 'principal';
    await expect(initialize()).rejects.toThrow('DAV URL is not allowed');
    expect(foreignRequests).toEqual([]);
  });
  test('foreign calendar and addressbook homes cannot be used', async () => {
    mode = 'home';
    await initialize();
    await expect(tsdavManager.getCalDavClient().fetchCalendars()).rejects.toThrow('DAV URL is not allowed');
    await expect(tsdavManager.getCardDavClient().fetchAddressBooks()).rejects.toThrow('DAV URL is not allowed');
    expect(foreignRequests).toEqual([]);
  });
  test('a returned object URL cannot receive credentials on a subsequent update', async () => {
    await initialize();
    mode = 'object';
    const client = tsdavManager.getCalDavClient();
    const [object] = await client.fetchCalendarObjects({ calendar: { url: `${trustedUrl}/cal/` } });
    expect(object.url).toBe(`${foreignUrl}/object.ics`);
    await expect(client.updateCalendarObject({ calendarObject: object })).rejects.toThrow('DAV URL is not allowed');
    expect(foreignRequests).toEqual([]);
  });
});

describe('OAuth endpoints are separate from DAV origins', () => {
  const oauth = () => ({ authMethod: 'OAuth', clientId: 'dummy-client', clientSecret: 'dummy-secret', refreshToken: 'dummy-refresh', tokenUrl: `${foreignUrl}/token` });
  test('token exchange works without granting DAV access to the token endpoint', async () => {
    await initialize(oauth());
    expect(foreignRequests.length).toBe(2);
    expect(foreignRequests.every(r => r.url === '/token' && !r.headers.authorization && r.body.includes('dummy-refresh'))).toBe(true);
    expect(trustedRequests.every(r => r.headers.authorization === 'Bearer dummy-access-token')).toBe(true);
    foreignRequests = [];
    await expect(tsdavManager.getCalDavClient().updateCalendarObject({
      calendarObject: { url: `${foreignUrl}/token`, etag: '"1"', data: 'private' },
    })).rejects.toThrow('DAV URL is not allowed');
    expect(foreignRequests).toEqual([]);
  });
  test('token redirects do not forward the client secret or refresh token', async () => {
    mode = 'token-redirect';
    await expect(initialize(oauth())).rejects.toThrow('redirects are not allowed');
    expect(trustedRequests).toEqual([]);
  });
  test('token policy rejects a different path on the configured origin', async () => {
    await expect(createTokenFetch(`${foreignUrl}/token`)(`${foreignUrl}/other`, { method: 'POST', body: 'secret' }))
      .rejects.toThrow('DAV URL is not allowed');
    expect(foreignRequests).toEqual([]);
  });
});

describe('URL parsing', () => {
  test.each([
    'https://dav.example.com.attacker.invalid/',
    'https://dav.example.com@attacker.invalid/',
    'https://user:secret@dav.example.com/',
    'https://dav.example.com:8443/',
    'http://dav.example.com/',
    'file:///etc/passwd',
    'data:text/plain,private',
    '//dav.example.com/path',
    '/relative',
    'not a URL',
  ])('rejects %s before fetch', async target => {
    const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('unexpected fetch'); });
    try {
      await expect(createDavFetch('https://dav.example.com/dav/')(target)).rejects.toThrow('DAV URL is not allowed');
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  test('URL normalization accepts case and the default port', async () => {
    const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    try {
      await createDavFetch('https://DAV.EXAMPLE.COM:443/dav/')('https://dav.example.com/cal/');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });
  test('URL and Request objects obey the same restrictions', async () => {
    const guarded = createDavFetch(trustedUrl);
    await expect(guarded(new URL(foreignUrl))).rejects.toThrow('DAV URL is not allowed');
    await expect(guarded(new Request(foreignUrl))).rejects.toThrow('DAV URL is not allowed');
    expect(foreignRequests).toEqual([]);
  });
  test.each(['ftp://dav.example.com', 'https://user:secret@dav.example.com', 'invalid'])('rejects unsafe configuration %s', value => {
    expect(() => createDavFetch(value)).toThrow('DAV URL is not allowed');
  });
});
