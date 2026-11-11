// In-memory stand-in for the Apps Script services Code.gs uses, so the real file can run under Node.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function fmt(date, tz, pattern) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' });
  const p = {};
  f.formatToParts(date).forEach(x => { p[x.type] = x.value; });
  if (p.hour === '24') p.hour = '00';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(p.timeZoneName) || [null, '+', '00', '00'];
  const map = { yyyy: p.year, MM: p.month, dd: p.day, HH: p.hour, H: String(Number(p.hour)), mm: p.minute, ss: p.second,
                Z: m[1] + m[2] + m[3] };
  return pattern.replace(/'([^']*)'|yyyy|MM|dd|HH|H|mm|ss|Z/g, (t, lit) => (lit !== undefined ? lit : map[t]));
}

class Sheet {
  constructor(name, header) { this.name = name; this.data = [header.slice()]; this.formats = {}; }
  getName() { return this.name; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, r.length), 0); }
  _cell(r, c) { const row = this.data[r - 1] || []; const v = row[c - 1]; return v === undefined ? '' : v; }
  _set(r, c, v) {
    while (this.data.length < r) this.data.push([]);
    const row = this.data[r - 1];
    while (row.length < c) row.push('');
    row[c - 1] = v;
  }
  appendRow(vals) { this.data.push(vals.map(v => (v === undefined || v === null ? '' : v))); }
  getRange(r, c, nr, nc) {
    const sheet = this; nr = nr || 1; nc = nc || 1;
    const range = {
      getRow: () => r, getColumn: () => c, getNumRows: () => nr, getNumColumns: () => nc, getSheet: () => sheet,
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => sheet._cell(r + i, c + j))),
      getValue: () => sheet._cell(r, c),
      setValue: v => { sheet._set(r, c, v); return range; },
      setFormula: f => { sheet._set(r, c, f); return range; },
      setNumberFormat: f => { sheet.formats[r + ':' + c] = f; return range; },
    };
    return range;
  }
}

function makeEnv(startMs) {
  const clock = { now: startMs };
  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(clock.now); else super(...a); }
    static now() { return clock.now; }
  }
  const sheets = {
    Punches: new Sheet('Punches', ['Time', 'Type', 'Name', 'Phone', 'Site', 'Location status', 'Distance', 'Lat', 'Lng', 'Notes', 'Device ID']),
    Shifts: new Sheet('Shifts', ['Name', 'Phone', 'Site', 'Shift date', 'In', 'Out', 'Hours', 'Break (min)', 'Payable hours', 'Status', 'Notes']),
    Workers: new Sheet('Workers', ['Name', 'Phone', 'Site', 'Registered', 'Status', 'Default break (min)', 'Device ID', 'Notes', 'Pending device']),
    Settings: new Sheet('Settings', ['Site', 'Address', 'Latitude', 'Longitude', 'Allowed radius (m)', 'Shift cap (hours)', 'Daily report time', 'Site code', 'Hebrew name', 'Admin code']),
  };
  sheets.Settings.appendRow(['Cargo', 'HaOrgim 23, Holon', 32.0096454, 34.802306, 200, 15, '07:00', 'cargo', 'קרגו', '4821']);
  const cache = {};
  const mails = [];
  const ss = { getSheetByName: n => sheets[n] || null, getUrl: () => 'https://sheet.example', setSpreadsheetTimeZone() {}, setSpreadsheetLocale() {} };
  const ctx = {
    Date: FakeDate, JSON, Math, Number, String, Object, Array, isNaN, isFinite, parseInt, console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; } }) },
    Utilities: { formatDate: (d, tz, p) => fmt(d, tz, p) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    MailApp: { sendEmail: m => mails.push(m) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    ScriptApp: { getProjectTriggers: () => [], getService: () => ({ getUrl: () => 'https://api.example/exec' }) },
    HtmlService: {},
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
  const call = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return { ctx, clock, sheets, cache, mails, call, fmt };
}
module.exports = { makeEnv, fmt };
