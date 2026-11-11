const { makeEnv } = require('./mock');
let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('FAIL: ' + name); } }
function eq(a, b, name) { ok(a === b, name + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
const near = (a, b) => Math.abs(a - b) < 1e-9;
const H = 3600000, MIN = 60000;
const SITE = { lat: 32.0096454, lng: 34.802306 };
const FAR = { lat: 32.08895, lng: 34.80459 };          // ~8.8 km away
const T0 = Date.parse('2026-11-12T12:00:00Z');          // 14:00 Israel time
const P1 = '0521234567', P2 = '0549876543';
const punch = (env, phone, extra) => env.call(Object.assign({ action: 'punch', site: 'cargo', phone, device: 'dev-' + phone }, SITE, extra || {}));
const reg = (env, phone, name) => env.call({ action: 'register', site: 'cargo', phone, name: name || 'Worker ' + phone.slice(-2), device: 'dev-' + phone });
const shiftRows = env => env.sheets.Shifts.data.slice(1);
const punchRows = env => env.sheets.Punches.data.slice(1);
const admin = (env, body) => env.call(Object.assign({ pin: '4821' }, body));

// 1. registration and phone validation
(function () {
  const env = makeEnv(T0);
  eq(reg(env, '0312345678').error, 'input', 'landline rejected');
  eq(reg(env, '052123456').error, 'input', 'short number rejected');
  eq(reg(env, '05212345678').error, 'input', 'long number rejected');
  eq(reg(env, '0721234567').error, 'input', '07x rejected');
  eq(reg(env, P1, 'A').error, 'input', 'one-letter name rejected');
  ok(reg(env, '+972521234567', 'Dana').ok, '+972 accepted');
  eq(env.sheets.Workers.data[1][1], '0521234567', 'stored as 05X text');
  eq(env.sheets.Workers.formats['2:2'], '@', 'phone cell is text');
  eq(reg(env, P1, 'Someone else').name, 'Dana', 'same phone keeps the original worker');
  eq(env.sheets.Workers.data.length, 2, 'no duplicate worker row');
  eq(env.call({ action: 'state', site: 'nope', phone: P1 }).error, 'site', 'unknown site code');
  eq(punch(env, P2).result, 'unknown', 'punch from unregistered phone');
})();

// 2. night shift 14:00 -> 02:00, exact minutes, month totals
(function () {
  const env = makeEnv(T0); reg(env, P1);
  const a = punch(env, P1);
  eq(a.result, 'in', 'IN recorded'); eq(a.verified, true, 'IN verified on site');
  let st = env.call({ action: 'state', site: 'cargo', phone: P1, device: 'dev-' + P1 });
  eq(st.openSince, T0, 'state shows the open shift'); eq(st.stale, false, 'not stale');
  env.clock.now = T0 + 12 * H;
  const b = punch(env, P1);
  eq(b.result, 'out', 'OUT after 12h crosses midnight');
  const r = shiftRows(env)[0];
  eq(shiftRows(env).length, 1, 'one shift row, not two halves');
  ok(near(r[6], 12), 'hours = 12');
  eq(r[9], 'OK', 'status OK');
  eq(r[3], '=INT(E2)', 'shift date follows the start day');
  eq(r[8], '=IF(G2="","",MAX(0,G2-H2/60))', 'payable formula');
  st = env.call({ action: 'state', site: 'cargo', phone: P1, device: 'dev-' + P1 });
  eq(st.month.minutes, 720, 'worker sees 12:00 this month'); eq(st.month.shifts, 1, 'one shift this month');
  eq(env.call({ action: 'state', site: 'cargo', phone: P1, device: 'someone-else' }).month, undefined, 'totals hidden from another device');
  // exact minute
  env.clock.now = T0 + 24 * H + 20000; punch(env, P1);
  env.clock.now = T0 + 24 * H + 8 * H + 7 * MIN + 50000; punch(env, P1);
  ok(near(shiftRows(env)[1][6] * 60, 488), '8h 7.5m rounds to 488 whole minutes');
})();

// 3. double press, retry of the same punch
(function () {
  const env = makeEnv(T0); reg(env, P1);
  punch(env, P1);
  env.clock.now += 30000;
  eq(punch(env, P1).result, 'dup', 'second press within 2 minutes ignored');
  eq(shiftRows(env)[0][5], '', 'shift still open after duplicate');
  eq(punchRows(env).length, 1, 'no extra punch logged');
  env.clock.now += 3 * MIN;
  eq(punch(env, P1).result, 'out', 'press after 2 minutes counts');
  // same queued punch delivered twice (network retry)
  const env2 = makeEnv(T0); reg(env2, P1);
  eq(punch(env2, P1, { queued: true, age: 60000, kind: 'in' }).result, 'in', 'queued IN');
  env2.clock.now += 10 * MIN;
  eq(punch(env2, P1, { queued: true, age: 60000 + 10 * MIN, kind: 'in' }).result, 'dup', 'same queued punch resent later is a duplicate');
  eq(shiftRows(env2).length, 1, 'still one shift');
})();

// 4. location rules
(function () {
  const env = makeEnv(T0); reg(env, P1); reg(env, P2);
  const f = punch(env, P1, Object.assign({}, FAR, { acc: 30 }));
  eq(f.result, 'far', 'far away is blocked'); eq(shiftRows(env).length, 0, 'blocked punch opens no shift');
  eq(punchRows(env)[0][1], 'BLOCKED', 'blocked attempt is logged');
  eq(punch(env, P1, { lat: SITE.lat + 0.0036, lng: SITE.lng, acc: 300 }).result, 'in', '400 m away with 300 m accuracy is accepted');
  eq(shiftRows(env)[0][9], 'Open · Unverified', 'but marked unverified');
  env.clock.now += 5 * MIN;
  eq(punch(env, P1, { lat: SITE.lat + 0.0036, lng: SITE.lng, acc: 20 }).result, 'far', '400 m away with good accuracy is blocked');
  eq(punch(env, P2, { lat: undefined, lng: undefined }).result, 'in', 'no location is accepted');
  eq(shiftRows(env)[1][9], 'Open · Unverified', 'no location marked unverified');
  env.clock.now += 8 * H;
  punch(env, P2);
  eq(shiftRows(env)[1][9], 'Unverified', 'shift stays unverified even if OUT was verified');
  eq(punch(env, P1, Object.assign({}, FAR, { acc: 5000 })).result, 'out', 'useless accuracy is treated as no location');
  eq(shiftRows(env)[0][9], 'Unverified', 'and marked unverified');
})();

// 5. forgot to clock out (online)
(function () {
  const env = makeEnv(T0); reg(env, P1);
  punch(env, P1);
  env.clock.now = T0 + 20 * H;
  const s = punch(env, P1);
  eq(s.result, 'stale', 'punch after the cap asks when the shift ended'); eq(s.openSince, T0, 'returns the open start');
  eq(shiftRows(env)[0][5], '', 'nothing written yet');
  const f = b => env.call(Object.assign({ action: 'forgot', site: 'cargo', phone: P1, device: 'dev-' + P1 }, b));
  eq(f({ endTs: T0 + 16 * H }).error, 'time', 'end beyond the cap rejected');
  eq(f({ endTs: T0 - H }).error, 'time', 'end before start rejected');
  eq(f({ endTs: T0 + 30 * H }).error, 'time', 'future end rejected');
  eq(f({ endTs: T0 + 12 * H }).result, 'closed', 'valid end accepted');
  ok(near(shiftRows(env)[0][6], 12), 'self-reported hours = 12');
  eq(shiftRows(env)[0][9], 'Self-reported · Pending approval', 'marked for approval');
  eq(punch(env, P1).result, 'in', 'next press starts a new shift');
  eq(shiftRows(env).length, 2, 'two shifts');
})();

// 6. offline queue: time comes from elapsed age, not the phone clock
(function () {
  const env = makeEnv(T0); reg(env, P1);
  let r = punch(env, P1, { queued: true, age: 3 * MIN, kind: 'in' });
  eq(r.ts, T0 - 3 * MIN, 'time = arrival minus age'); eq(shiftRows(env)[0][9], 'Open', 'short delay not flagged');
  env.clock.now = T0 + 10 * H;
  r = punch(env, P1, { queued: true, age: 2 * H, kind: 'out' });
  eq(r.result, 'out', 'queued OUT'); eq(r.ts, T0 + 8 * H, 'OUT time = arrival minus 2h');
  ok(near(shiftRows(env)[0][6], 8 + 3 / 60), 'hours 8:03'); eq(shiftRows(env)[0][9], 'Offline', 'long delay flagged Offline');
  ok(/Sent late \(offline 120 min\)/.test(shiftRows(env)[0][10]), 'delay written in notes');
  env.clock.now += H;
  r = punch(env, P1, { queued: true, age: -50000, kind: 'in' });
  eq(r.ts, env.clock.now, 'negative age falls back to arrival time');
  env.clock.now += 9 * H; punch(env, P1);
  r = punch(env, P1, { queued: true, age: 80 * H, kind: 'in' });
  eq(r.result, 'expired', 'punch older than 72h not recorded as a shift');
  eq(punchRows(env).slice(-1)[0][1], 'EXPIRED', 'but logged');
  eq(shiftRows(env).length, 2, 'no shift from the expired punch');
})();

// 7. queued punch arriving while an old shift is still open
(function () {
  const env = makeEnv(T0); reg(env, P1);
  punch(env, P1);
  env.clock.now = T0 + 24 * H;
  eq(punch(env, P1, { queued: true, age: 60000, kind: 'in' }).result, 'in', 'queued IN starts a new shift');
  eq(shiftRows(env)[0][9], 'Open · Missing OUT', 'old shift flagged missing OUT'); eq(shiftRows(env)[0][6], '', 'old shift has no hours');
  eq(env.call({ action: 'state', site: 'cargo', phone: P1 }).openSince, T0 + 24 * H - 60000, 'state points at the new shift');
  const env2 = makeEnv(T0); reg(env2, P1);
  punch(env2, P1);
  env2.clock.now = T0 + 17 * H;
  eq(punch(env2, P1, { queued: true, age: 0, kind: 'out' }).result, 'missing', 'queued OUT after the cap is not used to close');
  eq(shiftRows(env2)[0][5], '', 'old shift not closed with a wrong time');
  eq(punchRows(env2).slice(-1)[0][1], 'IGNORED', 'logged as ignored');
  env2.clock.now += 7 * H;
  eq(punch(env2, P1).result, 'in', 'worker can start the next shift');
})();

// 8. daylight-saving nights
(function () {
  const env = makeEnv(Date.parse('2026-10-24T17:00:00Z')); reg(env, P1);   // 20:00 summer time
  punch(env, P1);
  env.clock.now = Date.parse('2026-10-25T02:00:00Z');                       // 04:00 winter time, 9 real hours later
  punch(env, P1);
  ok(near(shiftRows(env)[0][6], 9), 'clock-change night pays the 9 hours really worked');
  const w = s => env.ctx.wall_(s).toISOString();
  eq(w('2026-10-24T20:00'), '2026-10-24T17:00:00.000Z', 'wall time in summer');
  eq(w('2026-10-25T04:00'), '2026-10-25T02:00:00.000Z', 'wall time after the change');
  eq(w('2026-07-01T12:00'), '2026-07-01T09:00:00.000Z', 'July');
  eq(w('2026-01-15T23:30'), '2026-01-15T21:30:00.000Z', 'January');
  eq(w('2026-03-27T08:00'), '2026-03-27T05:00:00.000Z', 'morning after spring change');
  eq(env.ctx.wall_('nonsense'), null, 'bad time string rejected');
})();

// 9. admin: pin
(function () {
  const env = makeEnv(T0);
  eq(env.call({ action: 'admin', pin: '0000' }).error, 'pin', 'wrong pin');
  eq(env.call({ action: 'adminSave', pin: 'x' }).error, 'pin', 'save needs pin');
  eq(env.call({ action: 'adminAdd' }).error, 'pin', 'add needs pin');
  for (let i = 0; i < 6; i++) env.call({ action: 'admin', pin: 'bad' + i });
  eq(env.call({ action: 'admin', pin: '4821' }).error, 'locked', 'locked after 8 wrong tries, even with the right pin');
  const env2 = makeEnv(T0); env2.sheets.Settings.data[1][9] = '';
  eq(env2.call({ action: 'admin', pin: '' }).error, 'nopin', 'no pin configured');
  const env3 = makeEnv(T0); env3.sheets.Settings.data[1][9] = 4821;
  ok(env3.call({ action: 'admin', pin: '4821' }).ok, 'numeric pin cell works');
})();

// 10. admin: edit, close, cancel, add
(function () {
  const env = makeEnv(T0); reg(env, P1, 'Dana'); reg(env, P2, 'Ravi');
  env.sheets.Workers.data[2][5] = 30;                          // Ravi has a 30-minute default break
  punch(env, P1); punch(env, P2);
  eq(shiftRows(env)[1][7], 30, 'default break copied to the shift');
  env.clock.now = T0 + 12 * H; punch(env, P1);                 // Dana 14:00-02:00, Ravi still open
  let list = admin(env, { action: 'admin', ym: '2026-11' });
  eq(list.open.length, 1, 'one open shift'); eq(list.shifts.length, 2, 'two shifts in November');
  const dana = list.shifts.filter(s => s[1] === P1)[0], ravi = list.open[0];
  eq(dana[7], 2, 'row number sent'); eq(ravi[7], 3, 'row number sent');

  // close Ravi's open shift
  let r = admin(env, { action: 'adminSave', row: ravi[7], phone: ravi[1], start0: ravi[3], inStr: '2026-11-12T14:00', outStr: '2026-11-12T22:30', breakMin: 30 });
  ok(r.ok, 'admin closes an open shift');
  let row = shiftRows(env)[1];
  ok(near(row[6], 8.5), 'hours 8.5'); eq(row[9], 'Edited by admin', 'flagged as edited'); eq(row[7], 30, 'break kept');
  ok(/Admin edit .*was 12\/11 14:00–open/.test(row[10]), 'old values kept in notes');
  eq(env.call({ action: 'state', site: 'cargo', phone: P2 }).openSince, null, 'worker no longer in a shift');

  // edit Dana's times
  r = admin(env, { action: 'adminSave', row: dana[7], phone: dana[1], start0: dana[3], inStr: '2026-11-12T13:45', outStr: '2026-11-13T02:00', breakMin: 45 });
  ok(r.ok, 'admin edits in/out');
  row = shiftRows(env)[0];
  ok(near(row[6], 12.25), 'hours recalculated to 12.25'); eq(row[7], 45, 'break updated');
  eq(row[4].toISOString(), '2026-11-12T11:45:00.000Z', 'new start stored as Israel wall time');

  // stale reference after the edit (start changed) is rejected
  eq(admin(env, { action: 'adminSave', row: dana[7], phone: dana[1], start0: dana[3], inStr: '2026-11-12T13:00', outStr: '2026-11-12T20:00', breakMin: 0 }).error, 'changed', 'edit with outdated data rejected');
  list = admin(env, { action: 'admin', ym: '2026-11' });
  const d2 = list.shifts.filter(s => s[1] === P1)[0];
  const save = extra => admin(env, Object.assign({ action: 'adminSave', row: d2[7], phone: d2[1], start0: d2[3], breakMin: 0 }, extra));
  eq(save({ inStr: '2026-11-12T14:00', outStr: '2026-11-12T13:00' }).error, 'time', 'out before in rejected');
  eq(save({ inStr: '2026-11-12T14:00', outStr: '2026-11-13T15:00' }).error, 'time', 'more than 24h rejected');
  eq(save({ inStr: '2026-11-12T14:00', outStr: '2026-11-14T02:00' }).error, 'time', 'far too long rejected');
  eq(save({ inStr: '2026-11-13T10:00', outStr: '2026-11-13T12:00' }).error, 'future', 'future times rejected');
  eq(save({ inStr: 'garbage', outStr: '' }).error, 'time', 'bad input rejected');
  eq(save({ inStr: '2026-11-12T14:00', outStr: '2026-11-12T20:00', breakMin: 900 }).error, 'break', 'absurd break rejected');
  ok(near(shiftRows(env)[0][6], 12.25), 'rejected edits changed nothing');

  // rows shifted in the sheet (someone inserted a row): the edit still lands on the right shift
  env.sheets.Shifts.data.splice(1, 0, ['X', '0500000000', 'Cargo', '', new Date(T0 - 100 * H), new Date(T0 - 95 * H), 5, 0, '', 'OK', '']);
  ok(save({ inStr: '2026-11-12T14:00', outStr: '2026-11-13T02:00' }).ok, 'edit follows the shift after rows moved');
  ok(near(shiftRows(env)[1][6], 12), 'right row updated'); ok(near(shiftRows(env)[0][6], 5), 'other row untouched');

  // add a shift by hand; overlap protection
  const add = extra => admin(env, Object.assign({ action: 'adminAdd', phone: P1, breakMin: 0 }, extra));
  eq(add({ inStr: '2026-11-12T20:00', outStr: '2026-11-12T23:00' }).error, 'overlap', 'overlapping shift rejected');
  eq(add({ phone: '0599999999', inStr: '2026-11-11T08:00', outStr: '2026-11-11T16:00' }).error, 'worker', 'unknown worker rejected');
  ok(add({ inStr: '2026-11-11T08:00', outStr: '2026-11-11T16:00' }).ok, 'non-overlapping shift added');
  row = shiftRows(env).slice(-1)[0];
  ok(near(row[6], 8), 'added shift has 8 hours'); eq(row[9], 'Added by admin', 'flagged as added'); eq(row[2], 'Cargo', 'site from the worker record');
  const d3 = admin(env, { action: 'admin', ym: '2026-11' }).shifts.filter(s => s[1] === P1 && s[6].indexOf('Edited') !== -1)[0];
  eq(admin(env, { action: 'adminSave', row: d3[7], phone: d3[1], start0: d3[3], breakMin: 0, inStr: '2026-11-11T15:00', outStr: '2026-11-12T02:00' }).error, 'overlap', 'editing into an overlap rejected');

  // cancel
  list = admin(env, { action: 'admin', ym: '2026-11' });
  const added = list.shifts.filter(s => s[6] === 'Added by admin')[0];
  ok(admin(env, { action: 'adminSave', cancel: true, row: added[7], phone: added[1], start0: added[3] }).ok, 'cancel works');
  row = shiftRows(env).slice(-1)[0];
  eq(row[9], 'Cancelled', 'status Cancelled'); eq(row[6], '', 'hours cleared so it is not paid');
  list = admin(env, { action: 'admin', ym: '2026-11' });
  eq(list.shifts.filter(s => s[1] === P1).length, 1, 'cancelled shift not listed');
  env.clock.now = T0 + 13 * H;
  eq(env.call({ action: 'state', site: 'cargo', phone: P1, device: 'dev-' + P1 }).month.minutes, 720, 'worker total excludes the cancelled shift');
})();

// 11. admin reopens / cancels an open shift; month boundary
(function () {
  const start = Date.parse('2026-11-30T12:00:00Z');
  const env = makeEnv(start); reg(env, P1);
  punch(env, P1); env.clock.now = start + 12 * H; punch(env, P1);             // 30 Nov 14:00 -> 1 Dec 02:00
  eq(admin(env, { action: 'admin', ym: '2026-11' }).shifts.length, 1, 'night shift belongs to the month it started in');
  eq(admin(env, { action: 'admin', ym: '2026-12' }).shifts.length, 0, 'and not to the next month');
  env.clock.now += 6 * H; punch(env, P1);
  const o = admin(env, { action: 'admin' }).open[0];
  ok(admin(env, { action: 'adminSave', cancel: true, row: o[7], phone: o[1], start0: o[3] }).ok, 'cancel an open shift');
  eq(env.call({ action: 'state', site: 'cargo', phone: P1 }).openSince, null, 'cancelled shift is not open for the worker');
  env.clock.now += 5 * MIN;
  eq(punch(env, P1).result, 'in', 'worker can clock in again');
})();

// 12. manual edit in the sheet recalculates hours
(function () {
  const env = makeEnv(T0); reg(env, P1);
  punch(env, P1); env.clock.now = T0 + 8 * H; punch(env, P1);
  const sh = env.sheets.Shifts;
  sh._set(2, 6, new Date(T0 + 9.5 * H));
  env.ctx.onEdit({ range: sh.getRange(2, 6) });
  ok(near(shiftRows(env)[0][6], 9.5), 'hours follow a manual edit'); eq(shiftRows(env)[0][9], 'OK · Edited manually', 'manual edit flagged');
  sh._set(2, 6, '');
  env.ctx.onEdit({ range: sh.getRange(2, 6) });
  eq(shiftRows(env)[0][6], '', 'clearing OUT clears the hours');
  env.ctx.onEdit({ range: sh.getRange(2, 8) });
  eq(shiftRows(env)[0][9], 'OK · Edited manually', 'editing the break does not add flags twice');
})();

// 13. daily report
(function () {
  const env = makeEnv(T0); reg(env, P1, 'Dana'); reg(env, P2, 'Ravi');
  punch(env, P1, { device: 'shared' }); punch(env, P2, { device: 'shared', lat: undefined, lng: undefined });
  env.clock.now = T0 + 14 * H; punch(env, P1, { device: 'shared' });
  env.clock.now = T0 + 18 * H;
  env.ctx.dailyReport();
  const m = env.mails[0];
  ok(m && m.to === 'owner@example.com', 'report mailed to the owner');
  ok(/חסרה יציאה \(1\)/.test(m.htmlBody), 'missing OUT listed');
  ok(/אותו נייד החתים כמה עובדים \(1\)/.test(m.htmlBody), 'shared device listed');
  ok(/משמרות ארוכות מ-13 שעות \(1\)/.test(m.htmlBody), 'long shift listed');
  ok(/החתמות לבדיקה: בלי מיקום מאומת, באיחור, או מנייד לא מאושר \(2\)/.test(m.htmlBody), 'punches to review listed (both used an unapproved phone)');
  ok(/עובדים חדשים שעוד לא קושרו \(2\)/.test(m.htmlBody), 'new workers listed');
  ok(/7 דברים לבדיקה/.test(m.subject), 'subject counts issues: ' + m.subject);
})();

// 14. two workers do not affect each other; device change is noted
(function () {
  const env = makeEnv(T0); reg(env, P1); reg(env, P2);
  punch(env, P1);
  eq(punch(env, P2).result, 'in', 'second worker starts independently');
  env.clock.now += 6 * H;
  eq(punch(env, P2).result, 'out', 'second worker ends'); eq(shiftRows(env)[0][5], '', 'first worker still open');
  eq(punch(env, P1, { device: 'another-phone' }).result, 'out', 'punch from another device is recorded');
  ok(/Unapproved device/.test(shiftRows(env)[0][10]), 'and noted');
  eq(shiftRows(env)[0][9], 'Unapproved device', 'and the shift is flagged for review');
  // device change needs the manager
  let r = env.call({ action: 'register', site: 'cargo', phone: P1, name: 'x y', device: 'new-phone' });
  eq(r.devicePending, true, 're-registering from another phone waits for approval');
  eq(env.sheets.Workers.data[1][6], 'dev-' + P1, 'registered device NOT replaced');
  eq(env.sheets.Workers.data[1][8], 'new-phone', 'request stored');
  eq(env.call({ action: 'state', site: 'cargo', phone: P1, device: 'new-phone' }).devicePending, true, 'new phone told it is pending');
  eq(env.call({ action: 'state', site: 'cargo', phone: P1, device: 'new-phone' }).month, undefined, 'pending phone cannot see hours');
  eq(env.call({ action: 'state', site: 'cargo', phone: P1, device: 'dev-' + P1 }).devicePending, false, 'original phone unaffected');
  eq(admin(env, { action: 'admin' }).workers[0][6], true, 'admin sees the request');
  eq(env.call({ action: 'adminDevice', pin: 'bad', phone: P1, approve: true }).error, 'pin', 'approval needs the admin code');
  ok(admin(env, { action: 'adminDevice', phone: P1, approve: false }).ok, 'reject');
  eq(env.sheets.Workers.data[1][6], 'dev-' + P1, 'rejected: device unchanged'); eq(env.sheets.Workers.data[1][8], '', 'request cleared');
  env.call({ action: 'register', site: 'cargo', phone: P1, name: 'x y', device: 'new-phone' });
  ok(admin(env, { action: 'adminDevice', phone: P1, approve: true }).ok, 'approve');
  eq(env.sheets.Workers.data[1][6], 'new-phone', 'approved: device replaced');
  env.clock.now += 10 * MIN;
  eq(punch(env, P1, { device: 'new-phone' }).result, 'in', 'approved phone punches normally');
  eq(shiftRows(env).slice(-1)[0][9], 'Open', 'with no flag');
  eq(admin(env, { action: 'adminDevice', phone: P1, approve: true }).error, 'changed', 'nothing left to approve');
  // strict mode
  env.ctx.BLOCK_UNAPPROVED_DEVICE = true;
  env.clock.now += 10 * MIN;
  eq(punch(env, P1, { device: 'stranger' }).result, 'device', 'strict mode refuses an unapproved phone');
  eq(shiftRows(env).slice(-1)[0][5], '', 'and the shift is untouched');
})();

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
