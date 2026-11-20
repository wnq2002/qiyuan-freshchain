'use strict';

/**
 * 集成测试：HTTP 层 + 数据层 + 领域层端到端串联
 * 每个用例启动独立进程内服务（随机端口），使用临时数据库，互不污染。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

// 用临时库，避免污染开发数据。必须在 require 任何业务模块之前设置，
// 因为 store.js 在首次 open() 时会缓存 DB_PATH（集成测试首轮踩过此坑）。
const TMP_DB = path.join(os.tmpdir(), `freshchain-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;

const store = require('../src/store');
const { seed } = require('../scripts/seed');
const { server } = require('../src/server');

let baseUrl;

function get(p) {
  return new Promise((resolve, reject) => {
    http.get(baseUrl + p, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, body: buf, json });
      });
    }).on('error', reject);
  });
}

function post(p, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const u = new URL(baseUrl + p);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { /* */ }
          resolve({ status: res.statusCode, body: buf, json });
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test.before(async () => {
  store.open();
  seed();
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
});

// ---------- 健康与静态资源 ----------

test('GET /api/health 返回规则版本与条数', async () => {
  const r = await get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.rules, 10);
  assert.ok(r.json.ruleVersion);
});

test('GET / 返回 HTML 页面', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('<!DOCTYPE html>'));
});

test('GET /style.css 返回 CSS', async () => {
  const r = await get('/style.css');
  assert.equal(r.status, 200);
  assert.ok(r.body.length > 1000);
});

// ---------- 看板 ----------

test('GET /api/dashboard 返回汇总与排序后的运单', async () => {
  const r = await get('/api/dashboard');
  assert.equal(r.status, 200);
  const { stats, rows } = r.json;
  assert.equal(rows.length, 12);
  assert.equal(stats.transit, 2);
  // 严重告警必须排在合格之前
  const idxCritical = rows.findIndex((x) => x.level === 'critical');
  const idxOk = rows.findIndex((x) => x.level === 'ok');
  assert.ok(idxCritical < idxOk, '严重告警必须排在合格之前');
});

test('看板：每票运单都有判定规则编号', async () => {
  const { json } = await get('/api/dashboard');
  for (const r of json.rows) {
    assert.ok(r.ruleId, `${r.no} 缺 ruleId`);
    assert.ok(r.partyName, `${r.no} 缺 partyName`);
  }
});

// ---------- 运单详情 ----------

test('GET /api/waybills/:no 返回曲线、事件、判定', async () => {
  const r = await get('/api/waybills/LT20261118003');
  assert.equal(r.status, 200);
  assert.ok(r.json.readings.length > 50, '应有足够温度读数');
  assert.ok(r.json.events.length >= 4, '应有事件记录');
  assert.equal(r.json.verdict.ruleId, 'R02');
  assert.equal(r.json.verdict.party, 'SHIP');
  assert.ok(Array.isArray(r.json.verdict.evidence));
  assert.ok(r.json.verdict.evidence.length >= 4, '证据项应可逐条追溯');
});

test('GET /api/waybills/不存在 返回 404', async () => {
  const r = await get('/api/waybills/NOT_EXIST');
  assert.equal(r.status, 404);
});

test('GET /api/waybills/:no/judgement 只返回判定结论', async () => {
  const r = await get('/api/waybills/LT20261118006/judgement');
  assert.equal(r.status, 200);
  assert.equal(r.json.ruleId, 'R05');
  assert.equal(r.json.party, 'EQUIP');
  // 不应包含运单主体字段（说明是"仅结论"接口）
  assert.equal(r.json.readings, undefined, 'judgement 不应返回温度读数');
  assert.equal(r.json.events, undefined, 'judgement 不应返回事件');
});

// ---------- 客户问询（同源同值 + 脱敏） ----------

test('客户问询与内部判定：结论必须同源同值', async () => {
  const no = 'LT20261118004';
  const inner = await get(`/api/waybills/${no}/judgement`);
  const outer = await get(`/api/track/${no}`);
  assert.equal(outer.status, 200);
  assert.equal(outer.json.conclusion.ruleId, inner.json.ruleId, '对外与对内规则必须一致');
  assert.equal(outer.json.conclusion.partyName, inner.json.partyName, '对外与对内责任主体必须一致');
  assert.equal(outer.json.conclusion.confidence, inner.json.confidence, '置信度必须一致');
});

test('客户问询：必须脱敏，不暴露司机姓名与设备编号', async () => {
  const r = await get('/api/track/LT20261118004');
  const raw = r.body;
  // 司机姓名"陆文斌"与设备编号"RC-2023-0460"不得出现在对外响应中
  assert.ok(!raw.includes('陆文斌'), '对外响应不得含司机姓名');
  assert.ok(!raw.includes('RC-2023-0460'), '对外响应不得含设备编号');
  assert.ok(!raw.includes('桂A·D6650'), '对外响应不得含完整车牌');
});

test('客户问询：温度曲线数据点完整', async () => {
  const r = await get('/api/track/LT20261118001');
  assert.equal(r.status, 200);
  assert.ok(r.json.series.length > 50);
  // 每个点是 [ts, temp, probe]
  assert.equal(r.json.series[0].length, 3);
});

// ---------- 在途运单 ----------

test('在途运单不出最终责任结论', async () => {
  const r = await get('/api/waybills/LT20261118011');
  assert.equal(r.status, 200);
  assert.equal(r.json.verdict.party, 'PENDING');
  assert.equal(r.json.verdict.ruleId, 'IN_TRANSIT');
  assert.equal(r.json.verdict.confidence, null);
});

test('在途运单正在超温时应报到严重告警', async () => {
  const r = await get('/api/waybills/LT20261118012');
  assert.equal(r.status, 200);
  assert.ok(['critical', 'warning'].includes(r.json.level), '在途超温应产生告警');
});

// ---------- 规则集 ----------

test('GET /api/rules 返回 10 条规则且带业务含义', async () => {
  const r = await get('/api/rules');
  assert.equal(r.status, 200);
  assert.equal(r.json.rules.length, 10);
  for (const x of r.json.rules) {
    assert.ok(x.id && x.name && x.why, '规则需含编号/名称/业务含义');
  }
  // 优先级必须递增（短路顺序）
  const prios = r.json.rules.map((x) => x.priority);
  assert.deepEqual(prios, [...prios].sort((a, b) => a - b));
});

// ---------- 数据接入 ----------

test('POST /api/ingest 接受设备上报并即时复判', async () => {
  const no = 'LT20261118011';
  const before = await get(`/api/waybills/${no}`);
  const ts = Date.now();
  const r = await post('/api/ingest', {
    waybillNo: no,
    readings: [
      { ts, temp: 9.5, probe: 'REAR-1' },
      { ts: ts + 300000, temp: 9.8, probe: 'REAR-1' },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.accepted, 2);
  const after = await get(`/api/waybills/${no}`);
  assert.ok(after.json.readings.length > before.json.readings.length, '新读数应已入库');
});

test('POST /api/ingest 拒绝非法数据', async () => {
  const r1 = await post('/api/ingest', { waybillNo: 'X' });
  assert.equal(r1.status, 400);
  const r2 = await post('/api/ingest', { waybillNo: 'NOT_EXIST', readings: [{ ts: 1, temp: 1 }] });
  assert.equal(r2.status, 404);
  const r3 = await post('/api/ingest', { waybillNo: 'LT20261118001', readings: [{ ts: 'abc', temp: 'x' }] });
  assert.equal(r3.status, 400);
});

// ---------- 一致性：库里判定快照与实时判定一致 ----------

test('判定快照与实时判定一致（记录与展示一致）', async () => {
  const no = 'LT20261118008';
  const snap = store.latestSnapshot(no);
  const live = await get(`/api/waybills/${no}/judgement`);
  assert.ok(snap, '应有落盘快照');
  assert.equal(live.json.ruleId, snap.ruleId, '实时判定与落盘快照规则必须一致');
  assert.equal(live.json.party, snap.party, '实时判定与落盘快照责任必须一致');
});
