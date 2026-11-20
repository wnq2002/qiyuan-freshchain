'use strict';

/**
 * HTTP 服务：零框架，node:http 原生实现
 *
 * 路由：
 *   GET  /api/health                      健康检查
 *   GET  /api/dashboard                   质控看板（在途+已交付汇总、告警排序）
 *   GET  /api/waybills                    运单列表（可按 status 过滤）
 *   GET  /api/waybills/:no                运单详情（温度曲线+事件轴+判定结论）
 *   GET  /api/waybills/:no/judgement      仅判定结论（含证据链）
 *   GET  /api/waybills/:no/stream         SSE 温度实时推送
 *   GET  /api/track/:no                   客户问询（对外脱敏，同源同值）
 *   GET  /api/rules                       规则集说明（可解释性）
 *   POST /api/ingest                      设备数据接入（模拟设备上报）
 *
 * 设计约束：
 *   B5 对外结论与对内结论使用同一接口同一算法 —— /api/track 内部直接复用
 *      /api/waybills/:no/judgement 的判定函数，不复制逻辑
 *   B6 客户问询页不展示承运方内部成本、司机姓名 —— 在 toPublic() 统一裁剪
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { buildContext, judge, assessCompleteness } = require('./domain/analyze');
const { RULES, PARTY } = require('./domain/rules');
const { simulate } = require('./domain/simulator');

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, 'public');
const RULE_VERSION = 'v1.0';

// ---------- 业务编排（唯一判定入口） ----------

/** 对一票运单做完整分析：读数 + 事件 + 设备台账 → 上下文 → 判定 */
function analyzeWaybill(no) {
  const waybill = store.getWaybill(no);
  if (!waybill) return null;
  const readings = store.getReadings(no);
  const events = store.getEvents(no);
  const asset = store.getAsset(waybill.deviceId);
  const ctx = buildContext(waybill, readings, events, asset);
  const verdict = judge(ctx, RULE_VERSION);
  return { waybill, readings, events, asset, ctx, verdict };
}

/** 告警等级：按超温时长与幅度复合分级（S3） */
function alertLevel(ctx, verdict) {
  if (verdict.party === 'PENDING') {
    // 在途：有超温即按严重度报，无超温算正常
    if (ctx.excursions.length === 0) return 'ok';
    const m = ctx.excursions.reduce((a, x) => a + x.minutes, 0);
    return m >= 30 ? 'critical' : 'warning';
  }
  if (verdict.party === 'NONE') return 'ok';
  if (verdict.party === 'UNKNOWN') return 'unknown';
  const mins = ctx.excursions.reduce((a, x) => a + x.minutes, 0);
  const maxDev = ctx.excursions.length
    ? Math.max(...ctx.excursions.map((x) =>
        x.direction === 'high' ? x.peak - ctx.waybill.zoneMax : ctx.waybill.zoneMin - x.peak))
    : 0;
  if (mins >= 120 || maxDev >= 5) return 'critical';
  if (mins >= 30 || maxDev >= 2) return 'warning';
  return 'minor';
}

// ---------- 视图裁剪 ----------

/**
 * 对外视图（B6 脱敏）
 * 客户能看：结论、证据、温度曲线、事件类型与时间
 * 客户不能看：司机姓名、车牌全号、设备编号、内部置信度算法细节
 */
function toPublic(detail) {
  const { waybill, verdict, ctx } = detail;
  return {
    no: waybill.no,
    customer: waybill.customer,
    cargo: waybill.cargo,
    zoneLabel: waybill.zoneLabel,
    zoneMin: waybill.zoneMin,
    zoneMax: waybill.zoneMax,
    origin: waybill.origin,
    dest: waybill.dest,
    status: waybill.status,
    startTs: waybill.startTs,
    endTs: waybill.endTs,
    conclusion: {
      partyName: verdict.partyName,
      ruleId: verdict.ruleId,
      ruleName: verdict.ruleName,
      summary: verdict.summary,
      detail: verdict.detail,
      evidence: verdict.evidence,
      confidence: verdict.confidence,
      needManual: verdict.needManual,
    },
    series: seriesOf(ctx),
    excursions: ctx.excursions.map((x) => ({
      from: x.from, to: x.to, minutes: Math.round(x.minutes), peak: x.peak, direction: x.direction,
    })),
    stats: {
      count: ctx.readings.length,
      min: +ctx.stats.min.toFixed(1),
      max: +ctx.stats.max.toFixed(1),
      avg: +ctx.stats.avg.toFixed(1),
      excursionMinutes: Math.round(ctx.excursions.reduce((a, x) => a + x.minutes, 0)),
    },
    events: ctx.events.map((e) => ({ type: e.type, at: e.at, durationMin: e.durationMin, note: e.note })),
  };
}

function seriesOf(ctx) {
  return ctx.readings.map((r) => [r.ts, r.temp, r.probe]);
}

// ---------- HTTP ----------

function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA 兜底：非静态资源且无扩展名，回 index.html
      if (!path.extname(rel)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
          if (e2) return send(res, 404, { error: 'not found' });
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        });
      }
      return send(res, 404, { error: 'not found' });
    }
    const ext = path.extname(file);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.json': 'application/json; charset=utf-8',
      '.ico': 'image/x-icon',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

function buildDashboard() {
  const all = store.listWaybills();
  const rows = [];
  for (const w of all) {
    const d = analyzeWaybill(w.no);
    if (!d) continue;
    const level = alertLevel(d.ctx, d.verdict);
    rows.push({
      no: w.no,
      customer: w.customer,
      cargo: w.cargo,
      plate: w.plate,
      driver: w.driver,
      status: w.status,
      zoneLabel: w.zoneLabel,
      zoneMin: w.zoneMin,
      zoneMax: w.zoneMax,
      origin: w.origin,
      dest: w.dest,
      startTs: w.startTs,
      endTs: w.endTs,
      level,
      ruleId: d.verdict.ruleId,
      ruleName: d.verdict.ruleName,
      party: d.verdict.party,
      partyName: d.verdict.partyName,
      summary: d.verdict.summary,
      needManual: d.verdict.needManual,
      confidence: d.verdict.confidence,
      excursionCount: d.ctx.excursions.length,
      excursionMinutes: Math.round(d.ctx.excursions.reduce((a, x) => a + x.minutes, 0)),
      latestTemp: d.ctx.readings.length ? d.ctx.readings[d.ctx.readings.length - 1].temp : null,
      latestTs: d.ctx.readings.length ? d.ctx.readings[d.ctx.readings.length - 1].ts : null,
      coverage: +(d.ctx.coverage * 100).toFixed(0),
    });
  }

  // 告警排序：critical → warning → minor → unknown → ok，同级别按超温时长降序
  const order = { critical: 0, warning: 1, minor: 2, unknown: 3, ok: 4 };
  rows.sort((a, b) => {
    const d = order[a.level] - order[b.level];
    if (d !== 0) return d;
    return b.excursionMinutes - a.excursionMinutes;
  });

  const stats = {
    total: rows.length,
    transit: rows.filter((r) => r.status === 'transit').length,
    critical: rows.filter((r) => r.level === 'critical').length,
    warning: rows.filter((r) => r.level === 'warning').length,
    needManual: rows.filter((r) => r.needManual).length,
    byParty: {},
  };
  for (const r of rows) {
    if (r.party === 'NONE' || r.party === 'UNKNOWN' || r.party === 'PENDING') continue;
    stats.byParty[r.partyName] = (stats.byParty[r.partyName] || 0) + 1;
  }

  return { stats, rows };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (p === '/api/health') {
      return send(res, 200, { ok: true, ruleVersion: RULE_VERSION, rules: RULES.length, ts: Date.now() });
    }

    if (p === '/api/dashboard') {
      return send(res, 200, buildDashboard());
    }

    if (p === '/api/rules') {
      return send(res, 200, {
        version: RULE_VERSION,
        parties: PARTY,
        rules: [...RULES].sort((a, b) => a.priority - b.priority).map((r) => ({
          id: r.id, name: r.name, priority: r.priority,
          party: typeof r.party === 'function' ? '按条件判定' : r.party,
          partyName: typeof r.party === 'function' ? '按条件判定' : PARTY[r.party].name,
          why: r.why,
        })),
      });
    }

    if (p === '/api/waybills') {
      const status = url.searchParams.get('status') || undefined;
      return send(res, 200, store.listWaybills({ status }));
    }

    // /api/waybills/:no           运单详情（内部视图，含司机车牌）
    // /api/waybills/:no/judgement 判定结论
    // /api/waybills/:no/stream    SSE
    const mWb = p.match(/^\/api\/waybills\/([^/]+)(\/judgement|\/stream)?$/);
    if (mWb) {
      const no = decodeURIComponent(mWb[1]);
      const sub = mWb[2];

      if (sub === '/stream') return handleStream(req, res, no);

      const d = analyzeWaybill(no);
      if (!d) return send(res, 404, { error: '运单不存在' });

      const base = {
        waybill: d.waybill,
        readings: d.ctx.readings,
        events: d.ctx.events,
        excursions: d.ctx.excursions,
        stats: d.ctx.stats,
        coverage: d.ctx.coverage,
        dataComplete: d.ctx.dataComplete,
        level: alertLevel(d.ctx, d.verdict),
        verdict: { ...d.verdict, judgedAt: Date.now() },
      };
      if (sub === '/judgement') return send(res, 200, base.verdict);
      return send(res, 200, base);
    }

    // 客户问询：对外脱敏视图，与内部同源同值
    const mTrack = p.match(/^\/api\/track\/([^/]+)$/);
    if (mTrack) {
      const no = decodeURIComponent(mTrack[1]);
      const d = analyzeWaybill(no);
      if (!d) return send(res, 404, { error: '运单不存在' });
      return send(res, 200, toPublic(d));
    }

    if (p === '/api/ingest' && req.method === 'POST') {
      return handleIngest(req, res);
    }

    if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

    return serveStatic(req, res, p);
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message });
  }
});

/**
 * SSE 实时推送：每 3 秒推一次在途运单的最新读数与告警状态。
 * 说明：演示环境下"实时"由模拟器按当前时刻推进产生，生产环境应改为
 * 订阅设备上报流（见 docs/04 §接入契约）。
 */
function handleStream(req, res, no) {
  const wb = store.getWaybill(no);
  if (!wb) return send(res, 404, { error: '运单不存在' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let tick = 0;
  const send = () => {
    const d = analyzeWaybill(no);
    const last = d.ctx.readings[d.ctx.readings.length - 1];
    // 演示推进：每 tick 追加一个"新读数"，模拟在途实时升温
    const projected = last ? +(last.temp + Math.sin(tick / 3) * 0.15).toFixed(1) : null;
    res.write(`data: ${JSON.stringify({
      no,
      ts: Date.now(),
      lastTemp: last ? last.temp : null,
      projected,
      excursionCount: d.ctx.excursions.length,
      party: d.verdict.party,
      partyName: d.verdict.partyName,
      level: alertLevel(d.ctx, d.verdict),
    })}\n\n`);
    tick++;
  };

  send();
  const timer = setInterval(send, 3000);
  req.on('close', () => clearInterval(timer));
}

/** 设备数据接入（真实对接时替换为厂商协议适配器） */
function handleIngest(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); } catch { return send(res, 400, { error: 'invalid json' }); }
    const { waybillNo, readings } = payload || {};
    if (!waybillNo || !Array.isArray(readings) || readings.length === 0) {
      return send(res, 400, { error: 'waybillNo 与 readings 必填' });
    }
    if (!store.getWaybill(waybillNo)) return send(res, 404, { error: '运单不存在' });
    const normalized = readings.map((r) => ({
      ts: Number(r.ts), temp: Number(r.temp), probe: String(r.probe || 'REAR-1'),
    }));
    const bad = normalized.find((r) => !Number.isFinite(r.ts) || !Number.isFinite(r.temp));
    if (bad) return send(res, 400, { error: '读数格式错误' });
    store.insertReadings(waybillNo, normalized);
    const d = analyzeWaybill(waybillNo);
    return send(res, 200, {
      accepted: normalized.length,
      verdict: d.verdict,
      excursions: d.ctx.excursions.length,
    });
  });
}

if (require.main === module) {
  store.open();
  server.listen(PORT, () => {
    console.log(`冷鲜通冷链监控系统已启动: http://localhost:${PORT}`);
    console.log(`规则版本 ${RULE_VERSION} · 内置规则 ${RULES.length} 条`);
    console.log('如无数据，请先执行: node scripts/seed.js');
  });
}

module.exports = { server, analyzeWaybill, buildDashboard, alertLevel, toPublic };
