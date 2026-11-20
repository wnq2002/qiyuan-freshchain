'use strict';

/**
 * 数据层：node:sqlite 内置驱动，零 npm 依赖
 * 设计要点：
 *   1. 所有时间为 ISO8601 UTC 毫秒存储（B7）
 *   2. 判定结果落盘快照表 judge_snapshots，含规则版本号（B4），事后可复现
 *   3. 温度读数量大，建 (waybill_no, ts) 复合索引
 */

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DB_DIR, 'freshchain.db');

let db = null;

function open() {
  if (db) return db;
  if (DB_PATH !== ':memory:') fs.mkdirSync(DB_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS waybills (
      no            TEXT PRIMARY KEY,
      customer      TEXT NOT NULL,
      cargo         TEXT NOT NULL,
      zone_label    TEXT NOT NULL,
      zone_min      REAL NOT NULL,
      zone_max      REAL NOT NULL,
      origin        TEXT NOT NULL,
      dest          TEXT NOT NULL,
      plate         TEXT NOT NULL,
      driver        TEXT NOT NULL,
      device_id     TEXT NOT NULL,
      status        TEXT NOT NULL,
      start_ts      INTEGER NOT NULL,
      end_ts        INTEGER,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS readings (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      waybill_no TEXT NOT NULL REFERENCES waybills(no) ON DELETE CASCADE,
      ts        INTEGER NOT NULL,
      temp      REAL NOT NULL,
      probe     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_readings_wb_ts ON readings(waybill_no, ts);

    CREATE TABLE IF NOT EXISTS events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      waybill_no TEXT NOT NULL REFERENCES waybills(no) ON DELETE CASCADE,
      type      TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      duration_min INTEGER DEFAULT 0,
      actor     TEXT,
      note      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_wb_ts ON events(waybill_no, ts);

    CREATE TABLE IF NOT EXISTS assets (
      device_id     TEXT PRIMARY KEY,
      plate         TEXT,
      last_maintained_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS judge_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      waybill_no    TEXT NOT NULL REFERENCES waybills(no) ON DELETE CASCADE,
      rule_id       TEXT NOT NULL,
      rule_name     TEXT NOT NULL,
      rule_version  TEXT NOT NULL,
      party         TEXT NOT NULL,
      party_name    TEXT NOT NULL,
      confidence    REAL NOT NULL,
      detail        TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      summary       TEXT NOT NULL,
      need_manual   INTEGER NOT NULL DEFAULT 0,
      excursion_count INTEGER NOT NULL DEFAULT 0,
      excursion_minutes REAL NOT NULL DEFAULT 0,
      judged_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snap_wb ON judge_snapshots(waybill_no, judged_at DESC);
  `);
}

// ---------- 写入 ----------

function reset() {
  const d = open();
  d.exec('DELETE FROM judge_snapshots; DELETE FROM readings; DELETE FROM events; DELETE FROM waybills; DELETE FROM assets;');
}

function insertWaybill(w) {
  open()
    .prepare(
      `INSERT INTO waybills (no,customer,cargo,zone_label,zone_min,zone_max,origin,dest,plate,driver,device_id,status,start_ts,end_ts,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      w.no, w.customer, w.cargo, w.zoneLabel, w.zoneMin, w.zoneMax,
      w.origin, w.dest, w.plate, w.driver, w.deviceId, w.status,
      w.startTs, w.endTs ?? null, Date.now()
    );
}

function insertReadings(waybillNo, readings) {
  const d = open();
  const stmt = d.prepare('INSERT INTO readings (waybill_no, ts, temp, probe) VALUES (?,?,?,?)');
  d.exec('BEGIN');
  for (const r of readings) stmt.run(waybillNo, r.ts, r.temp, r.probe);
  d.exec('COMMIT');
}

function insertEvents(waybillNo, events) {
  const d = open();
  const stmt = d.prepare(
    'INSERT INTO events (waybill_no, type, ts, duration_min, actor, note) VALUES (?,?,?,?,?,?)'
  );
  d.exec('BEGIN');
  for (const e of events) stmt.run(waybillNo, e.type, e.at, e.durationMin || 0, e.actor || null, e.note || null);
  d.exec('COMMIT');
}

function upsertAsset(a) {
  open()
    .prepare('INSERT INTO assets (device_id, plate, last_maintained_at) VALUES (?,?,?) ON CONFLICT(device_id) DO UPDATE SET plate=excluded.plate, last_maintained_at=excluded.last_maintained_at')
    .run(a.deviceId, a.plate || null, a.lastMaintainedAt || null);
}

function saveSnapshot(waybillNo, verdict, metrics) {
  open()
    .prepare(
      `INSERT INTO judge_snapshots (waybill_no,rule_id,rule_name,rule_version,party,party_name,confidence,detail,evidence_json,summary,need_manual,excursion_count,excursion_minutes,judged_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      waybillNo, verdict.ruleId, verdict.ruleName, verdict.ruleVersion, verdict.party, verdict.partyName,
      verdict.confidence, verdict.detail, JSON.stringify(verdict.evidence), verdict.summary,
      verdict.needManual ? 1 : 0, metrics.excursionCount, metrics.excursionMinutes, Date.now()
    );
}

// ---------- 读取 ----------

function listWaybills({ status } = {}) {
  const d = open();
  const sql = status
    ? 'SELECT * FROM waybills WHERE status = ? ORDER BY start_ts DESC'
    : 'SELECT * FROM waybills ORDER BY start_ts DESC';
  return (status ? d.prepare(sql).all(status) : d.prepare(sql).all()).map(mapWaybill);
}

function getWaybill(no) {
  const row = open().prepare('SELECT * FROM waybills WHERE no = ?').get(no);
  return row ? mapWaybill(row) : null;
}

function getReadings(no, { from, to } = {}) {
  const d = open();
  let sql = 'SELECT ts, temp, probe FROM readings WHERE waybill_no = ?';
  const args = [no];
  if (from != null) { sql += ' AND ts >= ?'; args.push(from); }
  if (to != null) { sql += ' AND ts <= ?'; args.push(to); }
  sql += ' ORDER BY ts ASC';
  return d.prepare(sql).all(...args);
}

function getEvents(no) {
  return open()
    .prepare('SELECT type, ts, duration_min, actor, note FROM events WHERE waybill_no = ? ORDER BY ts ASC')
    .all(no)
    .map((e) => ({
      type: e.type, at: e.ts, durationMin: e.duration_min, actor: e.actor, note: e.note,
      to: e.duration_min ? e.ts + e.duration_min * 60000 : undefined,
    }));
}

function getAsset(deviceId) {
  const row = open().prepare('SELECT * FROM assets WHERE device_id = ?').get(deviceId);
  return row ? { deviceId: row.device_id, plate: row.plate, lastMaintainedAt: row.last_maintained_at } : null;
}

function latestSnapshot(no) {
  const row = open()
    .prepare('SELECT * FROM judge_snapshots WHERE waybill_no = ? ORDER BY judged_at DESC, id DESC LIMIT 1')
    .get(no);
  if (!row) return null;
  return {
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    ruleVersion: row.rule_version,
    party: row.party,
    partyName: row.party_name,
    confidence: row.confidence,
    detail: row.detail,
    evidence: JSON.parse(row.evidence_json),
    summary: row.summary,
    needManual: !!row.need_manual,
    excursionCount: row.excursion_count,
    excursionMinutes: row.excursion_minutes,
    judgedAt: row.judged_at,
  };
}

function mapWaybill(r) {
  return {
    no: r.no, customer: r.customer, cargo: r.cargo,
    zoneLabel: r.zone_label, zoneMin: r.zone_min, zoneMax: r.zone_max,
    origin: r.origin, dest: r.dest, plate: r.plate, driver: r.driver,
    deviceId: r.device_id, status: r.status, startTs: r.start_ts, endTs: r.end_ts,
  };
}

module.exports = {
  open, reset, insertWaybill, insertReadings, insertEvents, upsertAsset, saveSnapshot,
  listWaybills, getWaybill, getReadings, getEvents, getAsset, latestSnapshot, DB_PATH,
};
