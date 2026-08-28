import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const dir = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(dir, '..');
const fixtureHtml = fs.readFileSync(path.join(dir, 'fixtures.html'), 'utf8')
  .replace(/<link rel="stylesheet"[^>]*>/, '')
  .replace(/<script src="\.\.\/content\.js"><\/script>/, '')
  .replace(/<script src="assert\.js"><\/script>/, '');
const contentJs = fs.readFileSync(path.join(extDir, 'content.js'), 'utf8');
const assertJs = fs.readFileSync(path.join(dir, 'assert.js'), 'utf8');

async function runOn(url) {
  const dom = new JSDOM(fixtureHtml, {
    url,
    pretendToBeVisual: true,
    runScripts: 'dangerously'
  });
  const { window } = dom;
  window.chrome = {
    storage: {
      local: {
        get(keys, cb) { cb({ renzo_api_key: 'renzo_test_key' }); },
        set(vals, cb) { if (cb) cb(); }
      }
    }
  };
  window.__renzoLastFetch = null;
  window.fetch = async (url, opts) => {
    window.__renzoLastFetch = { url, opts };
    return {
      ok: true,
      json: async () => ({ message: 'Hi there — just wanted to reconnect.' })
    };
  };
  window.eval(contentJs);
  window.eval(assertJs);

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const raw = window.document.getElementById('renzo-test-results')?.textContent || '';
    if (raw && raw !== 'running…' && raw.startsWith('{')) {
      return JSON.parse(raw);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Timed out on ' + url + ': ' + window.document.getElementById('renzo-test-results')?.textContent);
}

const gmail = await runOn('https://mail.google.com/mail/u/0/#inbox?compose=new');
const linkedin = await runOn('https://www.linkedin.com/messaging/');

const gmailResults = gmail.results.filter((r) => r.name.startsWith('gmail:') || r.name.startsWith('re-inject:'));
const linkedinResults = linkedin.results.filter((r) => r.name.startsWith('linkedin') || r.name.startsWith('re-inject:'));
// Keep one re-inject result from each host
const results = [
  ...gmail.results.filter((r) => r.name.startsWith('gmail:')),
  ...linkedin.results.filter((r) => r.name.startsWith('linkedin')),
  gmail.results.find((r) => r.name.startsWith('re-inject:')),
  linkedin.results.find((r) => r.name.startsWith('re-inject:'))
].filter(Boolean).map((r, i, arr) => {
  if (r.name.startsWith('re-inject:') && i === arr.length - 1) {
    return { ...r, name: 're-inject: button returns after host removes it (linkedin)' };
  }
  return r;
});

const summary = {
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results
};
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.failed ? 1 : 0);
