'use strict';

const { RULES, PARTY } = require('./rules');
const { regressWindow } = require('./rule-utils');

const TOLERANCE = 0.5;          // 仪表误差容差 ℃（B2）
const MIN_EXCURSION_MIN = 5;    // 超温区间最短持续（去抖，B3）
const GAP_MIN = 20;             // 采样空洞阈值 分钟（R06）
const GAP_NEAR_MIN = 30;        // 空洞与超温"紧邻"阈值 分钟

/**
 * 构建判定上下文：把原始读数与事件加工成规则可直接消费的结构
 * 纯函数：同样输入必然同样输出（无当前时间依赖、无随机）
 */
function buildContext(waybill, readings, events, asset) {
  const rs = [...readings].sort((a, b) => a.ts - b.ts);
  const evs = [...events].sort((a, b) => a.ts - b.ts);

  const stats = computeStats(rs);
  const excursions = findExcursions(rs, waybill);
  const gaps = findGaps(rs);
  const risingWindows = computeRisingWindows(rs, evs);

  const readAt = (ts, tolMin = 10) => {
    let best = null;
    let bestDiff = Infinity;
    for (const r of rs) {
      const diff = Math.abs(r.ts - ts);
      if (diff < bestDiff) { bestDiff = diff; best = r; }
    }
    return best && bestDiff <= tolMin * 60000 ? best : null;
  };

  const depart = evs.find((e) => e.type === 'depart');
  const { coverage, dataComplete } = assessCompleteness(rs);

  // 空洞是否与超温重叠 / 紧邻
  for (const g of gaps) {
    g.overlapsExcursion = excursions.some((x) => g.from < x.to && x.from < g.to);
    g.nearExcursion = excursions.some(
      (x) => g.to >= x.from - GAP_NEAR_MIN * 60000 && g.from <= x.to + GAP_NEAR_MIN * 60000
    );
  }

  // 设备维保：停机时刻前 90 天内是否有维保记录
  let unitMaintainedRecently = false;
  if (asset && asset.lastMaintainedAt) {
    const ref = evs.find((e) => e.type === 'unit_stop');
    const refTs = ref ? ref.at : (rs.length ? rs[rs.length - 1].ts : Date.now());
    unitMaintainedRecently = refTs - asset.lastMaintainedAt <= 90 * 86400000;
  }

  return {
    waybill,
    readings: rs,
    events: evs,
    asset: asset || null,
    stats,
    excursions,
    gaps,
    risingWindows,
    readAt,
    departRead: depart ? readAt(depart.at, 15) : null,
    unitMaintainedRecently,
    coverage,
    dataComplete,
  };
}

/**
 * 数据完整性判据（R08 放行的前置条件）
 * 覆盖率 = 实际读数 / 应有读数（按 5 分钟理论采样）
 * 判定「完整」需同时满足：
 *   ① 覆盖率 ≥ 60%      —— 数据密度足够，不是零星几条
 *   ② 无 > 20 分钟空洞  —— 无长时间断档
 *   ③ 读数 ≥ 10 条      —— 绝对下限
 * 三条缺一不可，避免用"刚好卡线"的数据为一方免责。
 */
function assessCompleteness(rs) {
  if (rs.length === 0) return { coverage: 0, dataComplete: false };
  const span = rs[rs.length - 1].ts - rs[0].ts;
  const expected = Math.floor(span / (5 * 60000)) + 1;
  const coverage = expected > 0 ? rs.length / expected : 0;
  const gaps = findGaps(rs);
  const hasBigGap = gaps.some((g) => g.minutes > GAP_MIN);
  const dataComplete = coverage >= 0.6 && !hasBigGap && rs.length >= 10;
  return { coverage, dataComplete };
}

function computeStats(rs) {
  if (rs.length === 0) return { min: NaN, max: NaN, avg: NaN, count: 0 };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const r of rs) {
    if (r.temp < min) min = r.temp;
    if (r.temp > max) max = r.temp;
    sum += r.temp;
  }
  return { min, max, avg: sum / rs.length, count: rs.length };
}

/**
 * 超温区间识别
 * 出界判定含 0.5℃ 容差；区间起止用线性插值定位真实越界时刻；
 * 持续时间 < 5 分钟视为抖动丢弃。
 */
function findExcursions(rs, waybill) {
  if (!rs.length || waybill.zoneMin == null) return [];
  const lo = waybill.zoneMin - TOLERANCE;
  const hi = waybill.zoneMax + TOLERANCE;
  const out = (t) => t > hi || t < lo;

  const groups = [];
  let cur = null;
  for (let i = 0; i < rs.length; i++) {
    if (!out(rs[i].temp)) { cur = null; continue; }
    if (cur && rs[i].ts - cur.lastTs <= 12 * 60000) {
      cur.idx.push(i);
      cur.lastTs = rs[i].ts;
    } else {
      cur = { idx: [i], lastTs: rs[i].ts };
      groups.push(cur);
    }
  }

  return groups.map((g) => {
    const first = g.idx[0];
    const last = g.idx[g.idx.length - 1];
    // 去抖：单个样本越界视为传感器抖动，不构成超温区间。
    // 物理依据：真实超温有热惯性，不可能只持续一个采样周期就立即回落。
    if (g.idx.length < 2) return null;
    const from = crossTime(rs, first, out, 'start');
    const to = crossTime(rs, last, out, 'end');
    const temps = g.idx.map((i) => rs[i]);
    const peak = temps.reduce((m, r) => (Math.abs(r.temp - center(waybill)) > Math.abs(m.temp - center(waybill)) ? r : m), temps[0]);
    return {
      from,
      to,
      minutes: Math.max(0, (to - from) / 60000),
      peak: peak.temp,
      peakAt: peak.ts,
      direction: peak.temp > hi ? 'high' : 'low',
      samples: temps.length,
    };
  }).filter((x) => x !== null && x.minutes >= MIN_EXCURSION_MIN);
}

function center(w) {
  return (w.zoneMin + w.zoneMax) / 2;
}

/** 在前一条（区间内）读数之间线性插值出穿越阈值时刻 */
function crossTime(rs, i, out, mode) {
  if (mode === 'start') {
    if (i === 0) return rs[i].ts;
    const prev = rs[i - 1];
    if (out(prev.temp)) return rs[i].ts;
    // 真实越界点在 prev 与 rs[i] 之间，取中点（无更多信息时的最小假设）
    return prev.ts + (rs[i].ts - prev.ts) * 0.5;
  }
  if (i === rs.length - 1) return rs[i].ts;
  const next = rs[i + 1];
  if (out(next.temp)) return rs[i].ts;
  return rs[i].ts + (next.ts - rs[i].ts) * 0.5;
}

/** 采样空洞：相邻读数间隔 > 20 分钟 */
function findGaps(rs) {
  const gaps = [];
  for (let i = 1; i < rs.length; i++) {
    const m = (rs[i].ts - rs[i - 1].ts) / 60000;
    if (m > GAP_MIN) {
      gaps.push({ from: rs[i - 1].ts, to: rs[i].ts, minutes: m, before: rs[i - 1].temp, after: rs[i].temp });
    }
  }
  return gaps;
}

/**
 * 升温窗口：线性回归求 ℃/小时 斜率
 * 来源：① 出发后 30 分钟  ② 每次机组停机期间  ③ 全程 30 分钟滚动窗
 */
function computeRisingWindows(rs, evs) {
  const wins = [];
  const depart = evs.find((e) => e.type === 'depart');
  if (depart) {
    const w = regressWindow(rs, depart.at, depart.at + 30 * 60000);
    if (w) wins.push({ ...w, kind: 'after_depart' });
  }
  for (const s of evs.filter((e) => e.type === 'unit_stop')) {
    const end = s.to || s.at + (s.durationMin || 60) * 60000;
    const w = regressWindow(rs, s.at, end);
    if (w && w.minutes >= 10) wins.push({ ...w, kind: 'unit_stop' });
  }
  // 滚动窗：每 15 分钟起一个 30 分钟窗
  if (rs.length >= 3) {
    const start = rs[0].ts;
    const end = rs[rs.length - 1].ts;
    for (let t = start; t < end; t += 15 * 60000) {
      const w = regressWindow(rs, t, t + 30 * 60000);
      if (w && w.minutes >= 10 && w.slope > 0.3) wins.push({ ...w, kind: 'rolling' });
    }
  }
  return wins;
}

/**
 * 判定：按优先级短路求值，首个命中即返回
 * 返回结构稳定，可直接落盘为判定快照
 */
function judge(ctx, ruleVersion = 'v1.0') {
  // 在途运单只做「当下状态」判定，不出最终责任结论：
  // 责任认定需要完整行程（到货、卸货结束），在途给结论等于提前定罪。
  if (ctx.waybill && ctx.waybill.status === 'transit') {
    return {
      ruleId: 'IN_TRANSIT',
      ruleName: '在途监测',
      party: 'PENDING',
      partyName: '在途未定责',
      why: '运单尚未完成，责任认定需等全程温度与事件齐备后再判，当前仅做过程监测。',
      confidence: null,
      detail: ctx.excursions.length
        ? `在途已出现 ${ctx.excursions.length} 段超温，累计 ${Math.round(ctx.excursions.reduce((a, x) => a + x.minutes, 0))} 分钟，请立即联系司机核实。`
        : '在途温度处于温区内，暂无异常。',
      evidence: [
        { label: '最新温度', value: ctx.readings.length ? `${ctx.readings[ctx.readings.length - 1].temp.toFixed(1)}℃` : '—' },
        { label: '已产生超温', value: `${ctx.excursions.length} 段` },
        { label: '温区要求', value: `[${ctx.waybill.zoneMin}, ${ctx.waybill.zoneMax}]℃` },
        { label: '定责时点', value: '到货并卸货完成后自动判定' },
      ],
      needManual: false,
      ruleVersion,
      judgedAt: null,
      summary: ctx.excursions.length
        ? `在途超温 ${ctx.excursions.length} 段，待完成后定责`
        : '在途正常，待完成后定责',
    };
  }

  const ordered = [...RULES].sort((a, b) => a.priority - b.priority);
  for (const rule of ordered) {
    const hit = rule.test(ctx);
    if (!hit) continue;
    const partyCode = typeof rule.party === 'function' ? rule.party(ctx) : rule.party;
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      party: partyCode,
      partyName: PARTY[partyCode].name,
      why: rule.why,
      confidence: hit.confidence,
      detail: hit.detail,
      evidence: hit.evidence,
      needManual: !!hit.needManual,
      ruleVersion,
      judgedAt: null, // 由调用方写入，保持 judge 纯函数
      summary: buildSummary(ctx, rule, partyCode, hit),
    };
  }
  // 规则表被破坏时的兜底（不应发生，R10 必然命中）
  return {
    ruleId: 'R10',
    ruleName: '证据不足',
    party: 'UNKNOWN',
    partyName: PARTY.UNKNOWN.name,
    why: PARTY.UNKNOWN.desc,
    confidence: 0.3,
    detail: '未匹配任何规则，需人工介入。',
    evidence: [],
    needManual: true,
    ruleVersion,
    judgedAt: null,
    summary: '需人工介入',
  };
}

/** 一句话结论（对外可直接贴给客户） */
function buildSummary(ctx, rule, partyCode, hit) {
  if (partyCode === 'NONE') return `温控合格，无责任方（${rule.id}）`;
  if (partyCode === 'UNKNOWN') return `证据不足，需人工介入（${rule.id}）`;
  const peak = ctx.excursions.length
    ? `峰值 ${Math.max(...ctx.excursions.map((x) => (x.direction === 'high' ? x.peak : -x.peak))).toFixed(1)}℃`
    : '无超温';
  return `${PARTY[partyCode].name}责任 · ${rule.name}（${rule.id}）· ${ctx.excursions.length} 段超温 · ${peak}`;
}

module.exports = { buildContext, judge, assessCompleteness, findExcursions, findGaps, regressWindow, TOLERANCE, MIN_EXCURSION_MIN, GAP_MIN };
