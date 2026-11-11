// Drives the real index.html and admin.html in Chromium against the real Code.gs (running on the in-memory mock).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { makeEnv, fmt } = require('./mock');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('FAIL: ' + name); } }
function eq(a, b, name) { ok(a === b, name + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
const H = 3600000, MIN = 60000;
const SITE = { latitude: 32.0096454, longitude: 34.802306, accuracy: 15 };
const FAR = { latitude: 32.08895, longitude: 34.80459, accuracy: 20 };
const API = 'https://api.example/exec';
const html = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace('{{API}}', API).replace('{{SITE}}', 'cargo');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function setup(browser, env, opts, hooks) {
  const context = await browser.newContext(Object.assign({ viewport: { width: 390, height: 800 }, locale: 'he-IL',
    timezoneId: 'Asia/Jerusalem', geolocation: SITE, permissions: ['geolocation'] }, opts || {}));
  const calls = [];
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith('https://app.example/admin')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html('admin.html') });
    if (url.startsWith('https://app.example/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html('index.html') });
    if (url.startsWith(API)) {
      if (hooks && hooks.down) return route.abort('internetdisconnected');   // phone has no connection
      const body = JSON.parse(route.request().postData());
      calls.push(body);
      let res = hooks && hooks.before ? await hooks.before(body) : null;
      if (!res) res = env.call(body);
      return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(res) });
    }
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  return { context, page, calls, errors };
}
const shifts = env => env.sheets.Shifts.data.slice(1);
const vis = (page, sel) => page.locator(sel).isVisible();
const txt = (page, sel) => page.locator(sel).innerText();
const queueLen = page => page.evaluate(() => JSON.parse(localStorage.getItem('ss-clock-cargo')).queue.length);

(async () => {
  const browser = await chromium.launch();

  /* ---------------- worker page ---------------- */
  {
    const env = makeEnv(Date.now());
    const hooks = {};
    const { context, page, errors } = await setup(browser, env, null, hooks);
    await page.goto('https://app.example/');
    await page.waitForSelector('#reg:not([hidden])');
    eq(await txt(page, '#logo'), 'קרגו', 'site name shown');
    eq(await page.locator('#langs button').allInnerTexts().then(a => a.join('|')), 'עברית|English|Русский|සිංහල', 'languages: Sinhala, no Hindi');

    await page.fill('#inName', 'דנה כהן');
    for (const bad of ['031234567', '0521234', '05212345678', '0721234567', 'abc']) {
      await page.fill('#inPhone', bad); await page.click('#btnSave');
      ok(await vis(page, '#regErr'), 'invalid phone rejected: ' + bad);
    }
    eq(env.sheets.Workers.data.length, 1, 'nothing registered with invalid phones');
    await page.fill('#inPhone', '052-123 4567'); await page.click('#btnSave');
    await page.waitForSelector('#clock:not([hidden])');
    eq(env.sheets.Workers.data[1][1], '0521234567', 'registered with a clean number');
    ok((await txt(page, '#hello')).includes('דנה כהן'), 'greets the worker by name');
    ok((await txt(page, '#punch')).includes('כניסה'), 'green start button');

    // IN
    const t0 = env.clock.now;
    await page.click('#punch');
    await page.waitForSelector('#flash.in:not([hidden])');
    eq(shifts(env).length, 1, 'IN created one shift');
    eq(shifts(env)[0][9], 'Open', 'verified on site');
    await page.click('#flash');
    await page.waitForFunction(() => document.querySelector('#punch').textContent.includes('יציאה'));
    ok(true, 'button turned to end');

    // double press
    await page.click('#punch');
    await page.waitForSelector('#note.warn:not([hidden])');
    ok((await txt(page, '#note')).includes('כבר נרשם'), 'double press shows already recorded');
    eq(shifts(env)[0][5], '', 'shift still open');

    // far from site
    env.clock.now = t0 + 5 * MIN;
    await context.setGeolocation(FAR);
    await page.click('#punch');
    await page.waitForSelector('#note.bad:not([hidden])');
    ok((await txt(page, '#note')).includes('אתם לא באתר'), 'blocked away from the site');
    eq(shifts(env)[0][5], '', 'far punch did not close the shift');

    // OUT after 12h, page left open the whole time (no rescan)
    await context.setGeolocation(SITE);
    env.clock.now = t0 + 12 * H;
    await page.click('#punch');
    await page.waitForSelector('#flash.out:not([hidden])');
    ok(Math.abs(shifts(env)[0][6] - 12) < 1e-9, 'OUT from the still-open page gives 12 hours');
    await page.click('#flash');
    await page.waitForSelector('#month:not([hidden])');
    eq(await txt(page, '#monthHours'), '12:00', 'worker sees monthly hours');

    // identity survives closing and reopening (rescan)
    await page.reload();
    await page.waitForSelector('#clock:not([hidden])');
    ok((await txt(page, '#punch')).includes('כניסה'), 'after rescan: recognised, ready to start');

    // offline: saved on the phone, sent when back online, with the press time
    env.clock.now = t0 + 20 * H;
    hooks.down = true;
    await page.click('#punch');
    await page.waitForSelector('#flash.in:not([hidden])');
    ok((await txt(page, '#flashS')).includes('נשמר בנייד'), 'offline punch says it was saved');
    eq(shifts(env).length, 1, 'nothing reached the server while offline');
    eq(await queueLen(page), 1, 'one punch waiting on the phone');
    await page.click('#flash');
    env.clock.now = t0 + 20 * H + 40 * MIN;                    // 40 minutes pass on the server too
    await page.evaluate(m => {                                  // ...and on the phone
      const s = JSON.parse(localStorage.getItem('ss-clock-cargo')); s.queue[0].clientTs -= m;
      localStorage.setItem('ss-clock-cargo', JSON.stringify(s));
    }, 40 * MIN);
    await page.reload();                                        // page reopened later, still offline
    await page.waitForSelector('#clock:not([hidden])');
    eq(await queueLen(page), 1, 'queued punch survives closing the page');
    hooks.down = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('ss-clock-cargo')).queue.length === 0);
    eq(shifts(env).length, 2, 'queued punch delivered');
    ok(Math.abs(shifts(env)[1][4].getTime() - (t0 + 20 * H)) < 5000, 'recorded at the time of the press, not the time of sending');
    eq(shifts(env)[1][9], 'Open · Offline', 'flagged as sent late');

    // server busy once: punch must not be lost, and must not be doubled
    env.clock.now = t0 + 28 * H;
    let failOnce = true;
    hooks.before = body => { if (body.action === 'punch' && failOnce) { failOnce = false; return { ok: false, error: 'Exception: Lock timeout' }; } return null; };
    await page.waitForFunction(() => document.querySelector('#punch').textContent.includes('יציאה'));
    await page.click('#punch');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('ss-clock-cargo')).queue.length === 0);
    await sleep(300);
    ok(Math.abs(shifts(env)[1][6] - 8) < 0.01, 'busy server: OUT retried automatically, 8 hours');
    eq(env.sheets.Punches.data.filter(r => r[1] === 'OUT').length, 2, 'exactly one OUT recorded for it');
    hooks.before = null;

    // several sync triggers at once with a slow server: each queued punch sent exactly once, in order
    env.clock.now = t0 + 40 * H;
    await page.click('#flash').catch(() => {});
    hooks.down = true;
    await page.waitForFunction(() => document.querySelector('#punch').textContent.includes('כניסה'));
    await page.click('#punch'); await page.waitForSelector('#flash.in:not([hidden])'); await page.click('#flash');
    await page.evaluate(m => { const s = JSON.parse(localStorage.getItem('ss-clock-cargo')); s.queue[0].clientTs -= m; localStorage.setItem('ss-clock-cargo', JSON.stringify(s)); }, 9 * H);
    await page.reload(); await page.waitForSelector('#clock:not([hidden])');
    await page.click('#punch'); await page.waitForSelector('#flash.out:not([hidden])'); await page.click('#flash');
    eq(await queueLen(page), 2, 'IN and OUT both waiting');
    env.clock.now = t0 + 49 * H;
    hooks.before = async () => { await sleep(250); return null; };
    hooks.down = false;
    await page.evaluate(() => { for (let i = 0; i < 6; i++) window.dispatchEvent(new Event('online')); });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('ss-clock-cargo')).queue.length === 0, null, { timeout: 15000 });
    await sleep(600);
    hooks.before = null;
    eq(shifts(env).length, 3, 'one new shift from the queued pair');
    ok(Math.abs(shifts(env)[2][6] - 9) < 0.01, 'queued IN+OUT give 9 hours');
    eq(env.sheets.Punches.data.filter(r => r[1] === 'IN').length, 3, 'no duplicate IN from parallel sends');
    eq(env.sheets.Punches.data.filter(r => r[1] === 'OUT').length, 3, 'no duplicate OUT from parallel sends');

    // forgot to clock out
    env.clock.now = t0 + 60 * H;
    await page.reload(); await page.waitForSelector('#clock:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#punch').textContent.includes('כניסה'));
    await page.click('#punch'); await page.waitForSelector('#flash.in:not([hidden])'); await page.click('#flash');
    const start = shifts(env)[3][4].getTime();
    env.clock.now = start + 21 * H;
    await page.reload();
    await page.waitForSelector('#forgot:not([hidden])');
    ok(!(await vis(page, '#punch')), 'big button hidden until the old shift is closed');
    const endWall = fmt(new Date(start + 11 * H), 'Asia/Jerusalem', 'HH:mm');
    await page.fill('#fTime', endWall); await page.click('#fSave');
    await page.waitForSelector('#forgot', { state: 'hidden' });
    ok(Math.abs(shifts(env)[3][6] - 11) < 0.02, 'self-reported end gives 11 hours');
    eq(shifts(env)[3][9], 'Self-reported · Pending approval', 'self report waits for approval');
    ok(await vis(page, '#punch'), 'can start the next shift');

    // language
    await page.click('#langs button[data-l="si"]');
    eq(await page.evaluate(() => document.documentElement.dir), 'ltr', 'Sinhala is left-to-right');
    ok((await txt(page, '#punch')).includes('ආරම්භය'), 'Sinhala button text');
    eq(errors.length, 0, 'no script errors on the worker page ' + errors.join(' | '));
    await context.close();
  }

  /* ---------------- admin page (phone set to New York time on purpose) ---------------- */
  {
    const real = Date.now();
    const base = Date.parse(fmt(new Date(real - 40 * H), 'Asia/Jerusalem', "yyyy-MM-dd'T'HH:00:00") + 'Z') ;   // a whole hour ~40h ago
    const env = makeEnv(base);
    const reg = (p, n) => env.call({ action: 'register', site: 'cargo', phone: p, name: n, device: 'd' + p });
    const punch = p => env.call({ action: 'punch', site: 'cargo', phone: p, device: 'd' + p, lat: SITE.latitude, lng: SITE.longitude, acc: 10 });
    reg('0521234567', 'דנה כהן'); reg('0549876543', 'Ravi Perera');
    punch('0521234567'); env.clock.now = base + 12 * H; punch('0521234567');       // Dana: closed, 12h
    env.clock.now = real - 3 * H; punch('0549876543');                              // Ravi: open for 3h
    env.clock.now = real;
    env.call({ action: 'register', site: 'cargo', phone: '0521234567', name: 'מישהו אחר', device: 'another-phone' });   // device change request

    const { context, page, errors } = await setup(browser, env, { timezoneId: 'America/New_York' });
    await page.goto('https://app.example/admin');
    await page.waitForSelector('#login:not([hidden])');
    await page.fill('#pin', '1111'); await page.click('#loginBtn');
    await page.waitForSelector('#loginErr:not([hidden])');
    ok((await txt(page, '#loginErr')).includes('שגוי'), 'wrong admin code refused');
    await page.fill('#pin', '4821'); await page.click('#loginBtn');
    await page.waitForSelector('#tabs:not([hidden])');

    // device change request: shown first, approved with one press
    const reqSec = page.locator('#view section', { hasText: 'בקשות להחלפת נייד' });
    ok((await reqSec.innerText()).includes('דנה כהן'), 'device change request shown to the manager');
    eq(env.sheets.Workers.data[1][6], 'd0521234567', 'device not replaced before approval');
    await reqSec.locator('button', { hasText: 'אישור' }).click();
    await page.waitForFunction(() => !document.querySelector('#view').textContent.includes('בקשות להחלפת נייד'));
    eq(env.sheets.Workers.data[1][6], 'another-phone', 'approved device saved');

    // open shift shown with Israel time even though the phone is on New York time
    const raviIn = fmt(shifts(env)[1][4], 'Asia/Jerusalem', 'HH:mm');
    const openRow = page.locator('#view section', { hasText: 'משמרות פתוחות' }).locator('button.row');
    eq(await openRow.count(), 1, 'one open shift listed');
    ok((await openRow.innerText()).includes(raviIn + '–…'), 'open shift shows Israel time ' + raviIn);

    // close it with "now"
    await openRow.click();
    await page.waitForSelector('#sheet:not([hidden])');
    eq(await page.inputValue('#eIn'), fmt(shifts(env)[1][4], 'Asia/Jerusalem', "yyyy-MM-dd'T'HH:mm"), 'edit form prefilled in Israel time');
    await page.click('#eNow');
    await page.click('#eSave');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    ok(Math.abs(shifts(env)[1][6] - 3) < 0.03, 'admin closed the open shift at now: 3 hours');
    eq(shifts(env)[1][9], 'Edited by admin', 'closed shift flagged as edited');
    await page.waitForFunction(() => document.querySelectorAll('#view section')[0].querySelectorAll('button.row').length === 0);
    ok(true, 'open list is empty after closing');

    // month tab: totals and editing a shift
    const ym = fmt(new Date(base), 'Asia/Jerusalem', 'yyyy-MM');
    const curYm = fmt(new Date(real), 'Asia/Jerusalem', 'yyyy-MM');
    await page.click('#tabs button[data-t="month"]');
    if (ym !== curYm) { await page.click('.monthnav button[aria-label="החודש הקודם"]'); await sleep(400); }
    await page.waitForSelector('.stats');
    const danaRow = page.locator('button.row', { hasText: 'דנה כהן' });
    ok((await danaRow.innerText()).includes('12:00'), 'month view: Dana has 12:00');
    await danaRow.click();
    await page.locator('.detail button').first().click();
    await page.waitForSelector('#sheet:not([hidden])');
    const newOut = fmt(new Date(base + 10 * H + 30 * MIN), 'Asia/Jerusalem', "yyyy-MM-dd'T'HH:mm");
    await page.fill('#eOut', newOut); await page.fill('#eBreak', '30');
    ok((await txt(page, '#eCalc')).includes('10:30') && (await txt(page, '#eCalc')).includes('10:00'), 'form previews duration and payable');
    await page.click('#eSave');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    ok(Math.abs(shifts(env)[0][6] - 10.5) < 1e-9, 'edited shift is 10.5 hours'); eq(shifts(env)[0][7], 30, 'break saved');
    await page.waitForFunction(() => [...document.querySelectorAll('button.row')].some(b => b.textContent.includes('דנה כהן') && b.textContent.includes('10:30') && b.textContent.includes('10:00')));
    ok(true, 'month view shows 10:30 worked, 10:00 payable');

    // invalid edit shows a clear message and saves nothing
    await page.locator('button.row', { hasText: 'דנה כהן' }).click().catch(() => {});
    if (!(await page.locator('.detail button').count())) await page.locator('button.row', { hasText: 'דנה כהן' }).click();
    await page.locator('.detail button').first().click();
    await page.waitForSelector('#sheet:not([hidden])');
    await page.fill('#eOut', fmt(new Date(base - H), 'Asia/Jerusalem', "yyyy-MM-dd'T'HH:mm"));
    await page.click('#eSave');
    await page.waitForSelector('#eErr:not([hidden])');
    ok((await txt(page, '#eErr')).includes('היציאה חייבת'), 'out-before-in refused with a message');
    ok(Math.abs(shifts(env)[0][6] - 10.5) < 1e-9, 'nothing changed by the refused edit');
    await page.click('#eClose');

    // add a manual shift, then an overlapping one
    await page.click('#tabs button[data-t="now"]');
    const addShift = async (inMs, outMs) => {
      await page.locator('button.btn', { hasText: 'הוספת משמרת ידנית' }).click();
      await page.waitForSelector('#sheet:not([hidden])');
      await page.selectOption('#eWorker', '0549876543');
      await page.fill('#eIn', fmt(new Date(inMs), 'Asia/Jerusalem', "yyyy-MM-dd'T'HH:mm"));
      await page.fill('#eOut', fmt(new Date(outMs), 'Asia/Jerusalem', "yyyy-MM-dd'T'HH:mm"));
      await page.click('#eSave');
    };
    await addShift(base + 2 * H, base + 10 * H);
    await page.waitForSelector('#sheet', { state: 'hidden' });
    eq(shifts(env).length, 3, 'manual shift added');
    ok(Math.abs(shifts(env)[2][6] - 8) < 1e-9, 'manual shift is 8 hours'); eq(shifts(env)[2][0], 'Ravi Perera', 'for the chosen worker');
    await addShift(base + 5 * H, base + 12 * H);
    await page.waitForSelector('#eErr:not([hidden])');
    ok((await txt(page, '#eErr')).includes('חופפת'), 'overlapping manual shift refused');
    eq(shifts(env).length, 3, 'no overlapping shift created');
    await page.click('#eClose');

    // cancel needs a second, explicit press
    await page.click('#tabs button[data-t="month"]');
    if (ym !== curYm) { await page.click('.monthnav button[aria-label="החודש הקודם"]'); await sleep(400); }
    await page.locator('button.row', { hasText: 'Ravi Perera' }).click();
    const lines = page.locator('.detail button');
    const n = await lines.count();
    for (let i = 0; i < n; i++) if ((await lines.nth(i).innerText()).includes('נוסף')) { await lines.nth(i).click(); break; }
    await page.waitForSelector('#sheet:not([hidden])');
    await page.click('#eCancelShift');
    eq(shifts(env)[2][9], 'Added by admin', 'first press does not cancel yet');
    await page.click('#eCancelSure');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    eq(shifts(env)[2][9], 'Cancelled', 'second press cancels'); eq(shifts(env)[2][6], '', 'cancelled shift has no hours');

    // workers tab
    await page.click('#tabs button[data-t="workers"]');
    const wt = await txt(page, '#view');
    ok(wt.includes('דנה כהן') && wt.includes('Ravi Perera') && wt.includes('0549876543'), 'workers tab lists who registered');
    eq(errors.length, 0, 'no script errors on the admin page ' + errors.join(' | '));
    await context.close();
  }

  await browser.close();
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
