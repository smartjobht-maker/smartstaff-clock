/**
 * שעון נוכחות SmartStaff – צד השרת (Google Apps Script)
 * מחובר לגיליון "שעון נוכחות – קרגו".
 * לשוניות (באנגלית): Punches, Shifts, Workers, Settings, Monthly Summary.
 *
 * עמודות Shifts:  A Name · B Phone · C Site · D Shift date · E In · F Out · G Hours · H Break (min) · I Payable hours · J Status · K Notes
 * עמודות Workers: A Name · B Phone · C Site · D Registered · E Status · F Default break · G Device ID · H Notes · I Pending device
 * עמודות Punches: A Time · B Type · C Name · D Phone · E Site · F Location status · G Distance · H Lat · I Lng · J Notes · K Device ID
 */
var TZ = 'Asia/Jerusalem';
var SH = { punch: 'Punches', shifts: 'Shifts', workers: 'Workers', settings: 'Settings' };
var DUP_MS = 2 * 60 * 1000;           // הגנה מלחיצה כפולה: שתי דקות
var LATE_FLAG_MS = 5 * 60 * 1000;     // החתמה שהגיעה באיחור של יותר מ-5 דקות מסומנת Offline
var MAX_AGE_MS = 72 * 3600 * 1000;    // החתמה שנשמרה בנייד יותר מ-72 שעות לא נרשמת כמשמרת
var MAX_ACC_M = 1500;                 // דיוק GPS גרוע מזה נחשב "אין מיקום"
var LONG_SHIFT_H = 13;                // משמרת ארוכה מזה מופיעה בדוח היומי לבדיקה
var TAIL_PUNCH = 400, TAIL_OPEN = 2000, TAIL_MONTH = 6000;
var BLOCK_UNAPPROVED_DEVICE = false;  // true = נייד שלא אושר לא יכול להחתים בכלל. false = ההחתמה נרשמת ומסומנת לבדיקה
var FLAGS = ['Unverified', 'Offline', 'Unapproved device', 'Edited by admin', 'Added by admin', 'Edited manually'];

/* ---------- דפים ---------- */
function doGet(e) {
  var site = String((e && e.parameter && e.parameter.s) || '').replace(/[^a-z0-9_-]/gi, '');
  var page = (e && e.parameter && e.parameter.admin) ? 'admin' : 'index';
  var html = HtmlService.createHtmlOutputFromFile(page).getContent()
    .replace('{{API}}', ScriptApp.getService().getUrl())
    .replace('{{SITE}}', site);
  return HtmlService.createHtmlOutput(html)
    .setTitle(page === 'admin' ? 'ניהול נוכחות' : 'שעון נוכחות')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ---------- API ---------- */
function doPost(e) {
  var out;
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
    var req = JSON.parse(e.postData.contents);
    var handlers = { state: apiState, register: apiRegister, punch: apiPunch, forgot: apiForgot,
                     admin: apiAdmin, adminSave: apiAdminSave, adminAdd: apiAdminAdd, adminDevice: apiAdminDevice };
    var fn = handlers[req.action];
    out = fn ? fn(req) : { ok: false, error: 'bad action' };
  } catch (err) {
    out = { ok: false, error: String(err) };
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- עזרים ---------- */
function sh_(name) { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name); }
/** קורא את n השורות האחרונות (0 = הכול). מחזיר גם את מספר השורה הראשונה שנקראה. */
function tail_(sheet, n) {
  var last = sheet.getLastRow();
  if (last < 2) return { first: 2, rows: [] };
  var first = n ? Math.max(2, last - n + 1) : 2;
  return { first: first, rows: sheet.getRange(first, 1, last - first + 1, sheet.getLastColumn()).getValues() };
}
function rows_(sheet) { return tail_(sheet, 0).rows; }
function normPhone_(p) {
  var d = String(p == null ? '' : p).replace(/\D/g, '');
  if (d.indexOf('972') === 0) d = d.slice(3);
  return d.replace(/^0+/, '');
}
function showPhone_(p) { return '0' + normPhone_(p); }
function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }
function has_(status, flag) { return String(status || '').indexOf(flag) !== -1; }
function minutes_(startMs, endMs) { return Math.round((endMs - startMs) / 60000); }
function hours_(startMs, endMs) { return minutes_(startMs, endMs) / 60; }
function flagsOf_(status) { return FLAGS.filter(function (f) { return has_(status, f); }); }
function addFlag_(flags, f) { if (flags.indexOf(f) === -1) flags.push(f); return flags; }
function stamp_(d) { return Utilities.formatDate(d, TZ, 'dd/MM HH:mm'); }
function joinNote_(oldNote, add) { oldNote = String(oldNote || ''); return add ? (oldNote ? oldNote + ' · ' + add : add) : oldNote; }

/** ממיר שעון-קיר ישראלי 'yyyy-MM-ddTHH:mm' לתאריך אמיתי, כולל מעבר שעון קיץ/חורף. */
function offMin_(ms) {
  var z = Utilities.formatDate(new Date(ms), TZ, 'Z');
  return (z.charAt(0) === '-' ? -1 : 1) * (Number(z.substr(1, 2)) * 60 + Number(z.substr(3, 2)));
}
function wall_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  var t2 = t - offMin_(t) * 60000;
  var off2 = offMin_(t2);
  if (off2 !== offMin_(t)) t2 = t - off2 * 60000;
  var d = new Date(t2);
  return isDate_(d) ? d : null;
}

function site_(code) {
  var rows = rows_(sh_(SH.settings));
  code = String(code || '').toLowerCase();
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r[7]).toLowerCase() === code) {
      return { name: r[0], lat: Number(r[2]), lng: Number(r[3]), radius: Number(r[4]) || 200,
               cap: Number(r[5]) || 15, he: r[8] || r[0] };
    }
  }
  return null;
}
function caps_() {
  var caps = {};
  rows_(sh_(SH.settings)).forEach(function (r) { caps[r[0]] = Number(r[5]) || 15; });
  return caps;
}
function findWorker_(phone) {
  var key = normPhone_(phone);
  if (!key) return null;
  var rows = rows_(sh_(SH.workers));
  for (var i = 0; i < rows.length; i++) {
    if (normPhone_(rows[i][1]) === key) {
      return { row: i + 2, name: rows[i][0], site: rows[i][2], breakMin: Math.max(0, Number(rows[i][5]) || 0),
               device: String(rows[i][6] || ''), notes: String(rows[i][7] || ''), pending: String(rows[i][8] || '') };
    }
  }
  return null;
}
/** משמרת פתוחה = יש כניסה, אין יציאה, לא בוטלה ולא סומנה כחסרת יציאה. */
function openShift_(phone) {
  var key = normPhone_(phone);
  var t = tail_(sh_(SH.shifts), TAIL_OPEN);
  for (var i = t.rows.length - 1; i >= 0; i--) {
    var r = t.rows[i];
    if (normPhone_(r[1]) !== key || !isDate_(r[4]) || r[5]) continue;
    if (has_(r[9], 'Cancelled') || has_(r[9], 'Missing OUT')) continue;
    return { row: t.first + i, start: r[4].getTime(), status: String(r[9] || ''), notes: String(r[10] || '') };
  }
  return null;
}
function lastPunch_(phone) {
  var key = normPhone_(phone);
  var rows = tail_(sh_(SH.punch), TAIL_PUNCH).rows;
  for (var i = rows.length - 1; i >= 0; i--) {
    var type = rows[i][1];
    if (normPhone_(rows[i][3]) === key && (type === 'IN' || type === 'OUT') && isDate_(rows[i][0])) return rows[i][0].getTime();
  }
  return null;
}
function monthTotals_(phone) {
  var key = normPhone_(phone);
  var ym = Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  var rows = tail_(sh_(SH.shifts), TAIL_MONTH).rows;
  var mins = 0, shifts = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (normPhone_(r[1]) !== key || !isDate_(r[4]) || !isDate_(r[5]) || has_(r[9], 'Cancelled')) continue;
    if (Utilities.formatDate(r[4], TZ, 'yyyy-MM') !== ym) continue;
    mins += Math.max(0, minutes_(r[4].getTime(), r[5].getTime()));
    shifts++;
  }
  return { minutes: mins, shifts: shifts };
}
function dist_(lat1, lng1, lat2, lng2) {
  var R = 6371000, toRad = Math.PI / 180;
  var dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}
/** מחליט אם המיקום מאומת, לא מאומת, או רחוק מדי. */
function locCheck_(req, site) {
  var ok = typeof req.lat === 'number' && typeof req.lng === 'number' && isFinite(req.lat) && isFinite(req.lng);
  if (!ok) return { status: 'Unverified', d: '', lat: '', lng: '', note: '' };
  var d = Math.round(dist_(req.lat, req.lng, site.lat, site.lng));
  var acc = Math.max(0, Number(req.acc) || 0);
  var res = { status: 'Verified', d: d, lat: req.lat, lng: req.lng, note: '' };
  if (d <= site.radius) return res;
  if (acc > MAX_ACC_M || d - acc <= site.radius) {
    res.status = 'Unverified';
    res.note = 'Low GPS accuracy (' + Math.round(acc) + ' m)';
    return res;
  }
  res.status = 'Too far';
  return res;
}
function textCell_(sheet, row, col, text) {
  sheet.getRange(row, col).setNumberFormat('@').setValue(String(text));
}
function logPunch_(when, kind, name, phone, siteName, loc, notes, device) {
  var sheet = sh_(SH.punch);
  sheet.appendRow([when, kind, name, '', siteName, loc.status, loc.d, loc.lat, loc.lng, notes, String(device || '')]);
  textCell_(sheet, sheet.getLastRow(), 4, showPhone_(phone));
}
/** פותח שורת משמרת חדשה ומחזיר את מספר השורה. */
function newShift_(name, phone, siteName, inDate, outDate, breakMin, status, notes) {
  var shifts = sh_(SH.shifts);
  shifts.appendRow([name, '', siteName, '', inDate, outDate || '',
                    outDate ? hours_(inDate.getTime(), outDate.getTime()) : '', breakMin, '', status, notes || '']);
  var r = shifts.getLastRow();
  textCell_(shifts, r, 2, showPhone_(phone));
  shifts.getRange(r, 4).setFormula('=INT(E' + r + ')');
  shifts.getRange(r, 9).setFormula('=IF(G' + r + '="","",MAX(0,G' + r + '-H' + r + '/60))');
  return r;
}

/* ---------- פעולות העובד ---------- */
function apiState(req) {
  var site = site_(req.site);
  if (!site) return { ok: false, error: 'site' };
  var res = { ok: true, known: false,
              site: { he: site.he, en: site.name, lat: site.lat, lng: site.lng, radius: site.radius, cap: site.cap } };
  var w = findWorker_(req.phone);
  if (!w) return res;
  res.known = true;
  res.name = w.name;
  var open = openShift_(req.phone);
  res.openSince = open ? open.start : null;
  res.stale = !!(open && (Date.now() - open.start > site.cap * 3600000));
  // סיכום חודשי מוצג רק למכשיר שרשום על העובד
  if (!w.device || w.device === String(req.device || '')) res.month = monthTotals_(req.phone);
  res.devicePending = !!(w.device && req.device && w.device !== String(req.device));
  return res;
}

function apiRegister(req) {
  var site = site_(req.site);
  if (!site) return { ok: false, error: 'site' };
  var name = String(req.name || '').trim().slice(0, 60);
  var key = normPhone_(req.phone);
  if (name.length < 2 || !/^5\d{8}$/.test(key)) return { ok: false, error: 'input' };   // רק נייד ישראלי: 05X-XXXXXXX
  var device = String(req.device || '').slice(0, 64);
  var sheet = sh_(SH.workers);
  var w = findWorker_(req.phone);
  if (w) {
    if (device && !w.device) {
      sheet.getRange(w.row, 7).setValue(device);            // עובד שנוסף ידנית לגיליון: הנייד הראשון נרשם עליו
    } else if (device && w.device !== device) {
      // נייד אחר מבקש להירשם על עובד קיים: לא מחליפים לבד, מחכים לאישור מנהל
      if (w.pending !== device) sheet.getRange(w.row, 9).setValue(device);
      var note = 'Device change requested ' + Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy');
      if (!has_(w.notes, note)) sheet.getRange(w.row, 8).setValue(joinNote_(w.notes, note));
      return { ok: true, name: w.name, devicePending: true };
    }
    return { ok: true, name: w.name };
  }
  sheet.appendRow([name, '', site.name, new Date(), 'New', '', device, '', '']);
  textCell_(sheet, sheet.getLastRow(), 2, showPhone_(req.phone));
  return { ok: true, name: name };
}

function apiPunch(req) {
  var site = site_(req.site);
  if (!site) return { ok: false, error: 'site' };
  var w = findWorker_(req.phone);
  if (!w) return { ok: true, result: 'unknown' };

  var now = Date.now(), whenMs = now, late = false;
  var loc = locCheck_(req, site);
  var notes = [];
  if (loc.note) notes.push(loc.note);
  var otherDevice = !!(w.device && w.device !== String(req.device || ''));
  if (otherDevice && BLOCK_UNAPPROVED_DEVICE) return { ok: true, result: 'device' };
  if (otherDevice) notes.push('Unapproved device');

  // החתמה שנשמרה בנייד: הזמן נקבע לפי כמה זמן עבר מאז הלחיצה, לא לפי השעון של הנייד
  if (req.queued) {
    var age = Number(req.age);
    if (!(age >= 0)) age = 0;
    if (age > MAX_AGE_MS) {
      logPunch_(new Date(now), 'EXPIRED', w.name, req.phone, site.name, loc,
                'Saved on phone more than 72h ago, not recorded', req.device);
      return { ok: true, result: 'expired' };
    }
    whenMs = now - age;
    if (age > LATE_FLAG_MS) {
      late = true;
      notes.push('Sent late (offline ' + Math.round(age / 60000) + ' min)');
    }
  }
  var when = new Date(whenMs);
  var noteText = notes.join(' · ');

  var shifts = sh_(SH.shifts);
  var open = openShift_(req.phone);
  if (open && whenMs - open.start > site.cap * 3600000) {
    // משמרת פתוחה מעבר לתקרה: אונליין שואלים את העובד מתי סיים. החתמה מהתור לא יכולה לחכות לתשובה.
    if (!req.queued) return { ok: true, result: 'stale', openSince: open.start };
    shifts.getRange(open.row, 10).setValue(joinNote_(open.status, 'Missing OUT'));
    if (req.kind === 'out') {
      logPunch_(when, 'IGNORED', w.name, req.phone, site.name, loc, joinNote_(noteText, 'OUT after shift cap'), req.device);
      return { ok: true, result: 'missing' };
    }
    open = null;
  }
  if (open && whenMs <= open.start) return { ok: true, result: 'dup', ts: open.start };
  var last = lastPunch_(req.phone);
  if (last && Math.abs(whenMs - last) < DUP_MS) return { ok: true, result: 'dup', ts: last };

  if (loc.status === 'Too far') {
    logPunch_(when, 'BLOCKED', w.name, req.phone, site.name, loc, noteText, req.device);
    return { ok: true, result: 'far', dist: loc.d };
  }
  var verified = loc.status === 'Verified';
  logPunch_(when, open ? 'OUT' : 'IN', w.name, req.phone, site.name, loc, noteText, req.device);

  var flags = open ? flagsOf_(open.status) : [];
  if (!verified) addFlag_(flags, 'Unverified');
  if (late) addFlag_(flags, 'Offline');
  if (otherDevice) addFlag_(flags, 'Unapproved device');

  if (!open) {
    newShift_(w.name, req.phone, site.name, when, null, w.breakMin, ['Open'].concat(flags).join(' · '), noteText);
    return { ok: true, result: 'in', ts: whenMs, verified: verified };
  }
  shifts.getRange(open.row, 6).setValue(when);
  shifts.getRange(open.row, 7).setValue(hours_(open.start, whenMs));
  shifts.getRange(open.row, 10).setValue(flags.length ? flags.join(' · ') : 'OK');
  if (noteText) shifts.getRange(open.row, 11).setValue(joinNote_(open.notes, noteText));
  return { ok: true, result: 'out', ts: whenMs, verified: verified };
}

function apiForgot(req) {
  var site = site_(req.site);
  if (!site) return { ok: false, error: 'site' };
  var w = findWorker_(req.phone);
  var open = openShift_(req.phone);
  if (!w || !open) return { ok: true, result: 'none' };
  var end = new Date(Number(req.endTs));
  var span = isDate_(end) ? end.getTime() - open.start : 0;
  if (span <= 0 || span > site.cap * 3600000 || end.getTime() > Date.now()) return { ok: false, error: 'time' };
  var shifts = sh_(SH.shifts);
  shifts.getRange(open.row, 6).setValue(end);
  shifts.getRange(open.row, 7).setValue(hours_(open.start, end.getTime()));
  shifts.getRange(open.row, 10).setValue('Self-reported · Pending approval');
  logPunch_(end, 'OUT', w.name, req.phone, site.name, { status: 'Self-reported', d: '', lat: '', lng: '' },
            'End time reported by worker', req.device);
  return { ok: true, result: 'closed' };
}

/* ---------- מסך מנהל ---------- */
function checkPin_(req) {
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('adminFails') || 0);
  if (fails >= 8) return { ok: false, error: 'locked' };
  var settings = rows_(sh_(SH.settings));
  var pin = settings.length ? String(settings[0][9] == null ? '' : settings[0][9]).trim() : '';
  if (pin.length < 4) return { ok: false, error: 'nopin' };
  if (String(req.pin == null ? '' : req.pin).trim() !== pin) {
    cache.put('adminFails', String(fails + 1), 900);
    return { ok: false, error: 'pin' };
  }
  return null;
}

function apiAdmin(req) {
  var err = checkPin_(req);
  if (err) return err;
  var ym = /^\d{4}-\d{2}$/.test(String(req.ym || '')) ? String(req.ym) : Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  var now = Date.now(), shifts = [], open = [], recent = [];
  var t = tail_(sh_(SH.shifts), 0);
  t.rows.forEach(function (r, i) {
    if (!isDate_(r[4]) || has_(r[9], 'Cancelled')) return;
    var s = r[4].getTime(), e = isDate_(r[5]) ? r[5].getTime() : null;
    // [שם, טלפון, אתר, כניסה, יציאה, הפסקה, סטטוס, שורה]
    var item = [r[0], showPhone_(r[1]), r[2], s, e, Math.max(0, Number(r[7]) || 0), String(r[9] || ''), t.first + i];
    if (!e) open.push(item);
    if (s >= now - 48 * 3600000) recent.push(item);
    if (Utilities.formatDate(r[4], TZ, 'yyyy-MM') === ym) shifts.push(item);
  });
  var workers = rows_(sh_(SH.workers)).map(function (r) {
    // [שם, טלפון, אתר, נרשם, סטטוס, הפסקה קבועה, יש בקשה להחלפת נייד]
    return [r[0], showPhone_(r[1]), r[2], isDate_(r[3]) ? r[3].getTime() : null, String(r[4] || ''),
            Math.max(0, Number(r[5]) || 0), !!String(r[8] || '')];
  });
  return { ok: true, ym: ym, now: now, open: open, recent: recent, shifts: shifts, workers: workers, caps: caps_() };
}

/** מוודא שהשורה שהמנהל ערך היא עדיין אותה משמרת (למקרה שמחקו או מיינו שורות בגיליון). */
function locate_(sheet, row, phone, start0) {
  var key = normPhone_(phone), s0 = Number(start0);
  var match = function (r) { return normPhone_(r[1]) === key && isDate_(r[4]) && r[4].getTime() === s0; };
  row = Number(row);
  if (row >= 2 && row <= sheet.getLastRow()) {
    if (match(sheet.getRange(row, 1, 1, 11).getValues()[0])) return row;
  }
  var t = tail_(sheet, 0);
  for (var i = t.rows.length - 1; i >= 0; i--) if (match(t.rows[i])) return t.first + i;
  return 0;
}
/** בודק חפיפה עם משמרת אחרת של אותו עובד, כדי שלא ישולמו אותן שעות פעמיים. */
function overlap_(sheet, phone, inMs, outMs, skipRow) {
  var key = normPhone_(phone), now = Date.now();
  var t = tail_(sheet, 0);
  for (var i = 0; i < t.rows.length; i++) {
    var r = t.rows[i];
    if (t.first + i === skipRow || normPhone_(r[1]) !== key || !isDate_(r[4]) || has_(r[9], 'Cancelled')) continue;
    var s = r[4].getTime();
    var e = isDate_(r[5]) ? r[5].getTime() : (has_(r[9], 'Missing OUT') ? s : Math.max(s, now));
    if (inMs < e && (outMs == null ? Math.max(inMs, now) : outMs) > s) return true;
  }
  return false;
}
function times_(req) {
  var inD = wall_(req.inStr);
  var outD = req.outStr ? wall_(req.outStr) : null;
  var now = Date.now();
  if (!inD || (req.outStr && !outD)) return { error: 'time' };
  if (inD.getTime() > now + 60000) return { error: 'future' };
  if (outD) {
    var span = outD.getTime() - inD.getTime();
    if (span <= 0 || span > 24 * 3600000) return { error: 'time' };
    if (outD.getTime() > now + 60000) return { error: 'future' };
  }
  var b = Math.round(Number(req.breakMin) || 0);
  if (b < 0 || b > 600) return { error: 'break' };
  return { inD: inD, outD: outD, breakMin: b };
}

function apiAdminSave(req) {
  var err = checkPin_(req);
  if (err) return err;
  var sheet = sh_(SH.shifts);
  var row = locate_(sheet, req.row, req.phone, req.start0);
  if (!row) return { ok: false, error: 'changed' };
  var cur = sheet.getRange(row, 1, 1, 11).getValues()[0];
  var was = stamp_(cur[4]) + '–' + (isDate_(cur[5]) ? stamp_(cur[5]) : 'open');
  var by = ' ' + stamp_(new Date());

  if (req.cancel) {
    sheet.getRange(row, 7).setValue('');
    sheet.getRange(row, 10).setValue('Cancelled');
    sheet.getRange(row, 11).setValue(joinNote_(cur[10], 'Cancelled by admin' + by + ' (was ' + was + ')'));
    return { ok: true };
  }
  var t = times_(req);
  if (t.error) return { ok: false, error: t.error };
  if (overlap_(sheet, req.phone, t.inD.getTime(), t.outD ? t.outD.getTime() : null, row)) return { ok: false, error: 'overlap' };

  var flags = flagsOf_(cur[9]).filter(function (f) { return f !== 'Unverified' && f !== 'Offline'; });
  addFlag_(flags, 'Edited by admin');
  sheet.getRange(row, 5).setValue(t.inD);
  sheet.getRange(row, 6).setValue(t.outD || '');
  sheet.getRange(row, 7).setValue(t.outD ? hours_(t.inD.getTime(), t.outD.getTime()) : '');
  sheet.getRange(row, 8).setValue(t.breakMin);
  sheet.getRange(row, 10).setValue((t.outD ? flags : ['Open'].concat(flags)).join(' · '));
  sheet.getRange(row, 11).setValue(joinNote_(cur[10], 'Admin edit' + by + ' (was ' + was + ', break ' + (Number(cur[7]) || 0) + ')'));
  return { ok: true };
}

function apiAdminAdd(req) {
  var err = checkPin_(req);
  if (err) return err;
  var w = findWorker_(req.phone);
  if (!w) return { ok: false, error: 'worker' };
  var t = times_(req);
  if (t.error) return { ok: false, error: t.error };
  var sheet = sh_(SH.shifts);
  if (overlap_(sheet, req.phone, t.inD.getTime(), t.outD ? t.outD.getTime() : null, 0)) return { ok: false, error: 'overlap' };
  newShift_(w.name, req.phone, w.site, t.inD, t.outD, t.breakMin,
            t.outD ? 'Added by admin' : 'Open · Added by admin', 'Added by admin ' + stamp_(new Date()));
  return { ok: true };
}

/** אישור או דחייה של בקשה להחלפת נייד. */
function apiAdminDevice(req) {
  var err = checkPin_(req);
  if (err) return err;
  var w = findWorker_(req.phone);
  if (!w) return { ok: false, error: 'worker' };
  if (!w.pending) return { ok: false, error: 'changed' };
  var sheet = sh_(SH.workers);
  if (req.approve) sheet.getRange(w.row, 7).setValue(w.pending);
  sheet.getRange(w.row, 9).setValue('');
  sheet.getRange(w.row, 8).setValue(joinNote_(w.notes, (req.approve ? 'Device approved ' : 'Device rejected ') + stamp_(new Date())));
  return { ok: true };
}

/* ---------- עריכה ידנית בגיליון: מחשב שעות מחדש ומסמן ---------- */
function onEdit(e) {
  try {
    var range = e.range, sheet = range.getSheet();
    if (sheet.getName() !== SH.shifts) return;
    var c1 = range.getColumn(), c2 = c1 + range.getNumColumns() - 1;
    if (c2 < 5 || c1 > 6) return;   // רק כניסה או יציאה
    var r1 = Math.max(2, range.getRow()), r2 = range.getRow() + range.getNumRows() - 1;
    for (var r = r1; r <= r2; r++) {
      var v = sheet.getRange(r, 5, 1, 6).getValues()[0];   // E..J
      var ok = isDate_(v[0]) && isDate_(v[1]) && v[1].getTime() > v[0].getTime();
      sheet.getRange(r, 7).setValue(ok ? hours_(v[0].getTime(), v[1].getTime()) : '');
      var s = String(v[5] || '');
      if (!has_(s, 'Edited manually')) sheet.getRange(r, 10).setValue(joinNote_(s, 'Edited manually'));
    }
  } catch (x) {}
}

/* ---------- דוח יומי ---------- */
function dailyReport() {
  var now = Date.now(), dayAgo = now - 24 * 3600000;
  var caps = caps_();
  var started = 0, done = 0, check = [], self = [], missing = [], long = [];
  rows_(sh_(SH.shifts)).forEach(function (r) {
    if (!isDate_(r[4]) || has_(r[9], 'Cancelled')) return;
    var t = r[4].getTime(), status = String(r[9] || ''), closed = isDate_(r[5]);
    var line = r[0] + ' (' + showPhone_(r[1]) + '), ' + r[2] + ', כניסה ' + stamp_(r[4]) + (closed ? ', יציאה ' + stamp_(r[5]) : '');
    if (!closed && (has_(status, 'Missing OUT') || now - t > (caps[r[2]] || 15) * 3600000)) missing.push(line);
    if (t < dayAgo) return;
    started++;
    if (closed) done++;
    if (has_(status, 'Unverified') || has_(status, 'Offline') || has_(status, 'Unapproved device')) check.push(line + ' [' + status + ']');
    if (has_(status, 'Self-reported')) self.push(line);
    if (closed && r[5].getTime() - t > LONG_SHIFT_H * 3600000) long.push(line);
  });
  var blocked = [], byDevice = {};
  tail_(sh_(SH.punch), 3000).rows.forEach(function (r) {
    if (!isDate_(r[0]) || r[0].getTime() < dayAgo) return;
    if (r[1] === 'BLOCKED') blocked.push(r[2] + ' (' + showPhone_(r[3]) + '), ' + stamp_(r[0]) + ', ' + r[6] + ' מטר מהאתר');
    var dev = String(r[10] || '');
    if (dev && (r[1] === 'IN' || r[1] === 'OUT')) {
      byDevice[dev] = byDevice[dev] || {};
      byDevice[dev][showPhone_(r[3])] = r[2];
    }
  });
  var shared = [];
  Object.keys(byDevice).forEach(function (dev) {
    var phones = Object.keys(byDevice[dev]);
    if (phones.length > 1) shared.push(phones.map(function (p) { return byDevice[dev][p] + ' (' + p + ')'; }).join(' + '));
  });
  var fresh = [], pendingDev = [];
  rows_(sh_(SH.workers)).forEach(function (r) {
    if (String(r[4]) === 'New') fresh.push(r[0] + ' (' + showPhone_(r[1]) + '), ' + r[2]);
    if (String(r[8] || '')) pendingDev.push(r[0] + ' (' + showPhone_(r[1]) + ')');
  });

  var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); };
  var section = function (title, list) {
    if (!list.length) return '';
    return '<h3>' + title + ' (' + list.length + ')</h3><ul>' +
           list.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
  };
  var body = '<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px">' +
    '<p>ב-24 השעות האחרונות התחילו ' + started + ' משמרות, מתוכן ' + done + ' נסגרו.</p>' +
    section('חסרה יציאה', missing) +
    section('אותו נייד החתים כמה עובדים', shared) +
    section('משמרות ארוכות מ-' + LONG_SHIFT_H + ' שעות', long) +
    section('בקשות להחלפת נייד שמחכות לאישור', pendingDev) +
    section('החתמות לבדיקה: בלי מיקום מאומת, באיחור, או מנייד לא מאושר', check) +
    section('יציאה בדיווח עצמי, ממתין לאישור', self) +
    section('ניסיונות שנחסמו (רחוק מהאתר)', blocked) +
    section('עובדים חדשים שעוד לא קושרו', fresh) +
    '<p><a href="' + SpreadsheetApp.getActiveSpreadsheet().getUrl() + '">לפתיחת הגיליון</a></p></div>';
  var issues = pendingDev.length + missing.length + shared.length + long.length + check.length + self.length + blocked.length + fresh.length;
  MailApp.sendEmail({
    to: Session.getEffectiveUser().getEmail(),
    subject: 'שעון נוכחות: ' + (issues ? issues + ' דברים לבדיקה' : 'הכול תקין') + ' · ' +
             Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy'),
    htmlBody: body
  });
}

/* ---------- התקנה חד-פעמית: להריץ פעם אחת מהעורך ---------- */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(TZ);
  ss.setSpreadsheetLocale('en_US');   // הנוסחאות שהסקריפט כותב תלויות בזה
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyReport') ScriptApp.deleteTrigger(t);
  });
  var hour = 7;
  var rows = rows_(sh_(SH.settings));
  if (rows.length) {
    var v = rows[0][6];
    var h = isDate_(v) ? Number(Utilities.formatDate(v, TZ, 'H')) : parseInt(String(v), 10);
    if (!isNaN(h) && h >= 0 && h <= 23) hour = h;
  }
  ScriptApp.newTrigger('dailyReport').timeBased().everyDays(1).atHour(hour).inTimezone(TZ).create();
}
