'use strict';

/**
 * 规则引擎真值校验：拿场景库的「期望规则」与引擎实际输出逐条比对。
 * 这是本项目最关键的一份证据 —— 规则不是拍脑袋写的，是拿真值验过的。
 *
 * 用法：node scripts/verify-rules.js
 */

const path = require('path');
const { SCENARIOS, ZONES, BASE, M } = require('../src/domain/scenarios');
const { simulate } = require('../src/domain/simulator');
const { buildContext, judge } = require('../src/domain/analyze');

function buildScenario(s, opts = {}) {
  const startTs = BASE + s.startOffsetH * 3600000;
  const dur = opts.durationMin ?? s.durationMin;
  const sim = s.sim;
  const readings = simulate({
    startTs,
    minutes: dur,
    setPoint: sim.setPoint,
    seed: sim.seed,
    doors: sim.doors || [],
    stops: sim.stops || [],
    preloadOffset: sim.preloadOffset || 0,
    cargoHeat: sim.cargoHeat || null,
    warmRate: sim.warmRate || 0,
    gaps: sim.gaps || [],
    drift: sim.drift || 0,
    secondProbe: sim.secondProbe,
  });
  const events = s.events
    .filter((e) => e.atMin <= dur)
    .map((e) => ({
      type: e.type,
      at: startTs + e.atMin * M,
      durationMin: e.durationMin || 0,
      to: e.durationMin ? startTs + e.atMin * M + e.durationMin * M : undefined,
      actor: e.actor,
      note: e.note,
    }));
  const z = ZONES[s.zone];
  const waybill = {
    no: s.no,
    zoneMin: z.zoneMin,
    zoneMax: z.zoneMax,
    zoneLabel: z.label,
  };
  const asset = s.asset
    ? { lastMaintainedAt: startTs + (s.asset.lastMaintainedAtOffsetDays || 0) * 86400000 }
    : null;
  return { startTs, readings, events, waybill, asset };
}

function run() {
  let pass = 0;
  let fail = 0;
  const rows = [];

  for (const s of SCENARIOS) {
    if (!s.expect.ruleId) continue;
    const { readings, events, waybill, asset } = buildScenario(s);
    const ctx = buildContext(waybill, readings, events, asset);
    const r = judge(ctx);
    const ok = r.ruleId === s.expect.ruleId && r.party === s.expect.party;
    ok ? pass++ : fail++;
    rows.push({
      no: s.no,
      expect: `${s.expect.ruleId}/${s.expect.party}`,
      actual: `${r.ruleId}/${r.party}`,
      ok,
      readings: readings.length,
      excursions: ctx.excursions.length,
      excursionMin: Math.round(ctx.excursions.reduce((a, x) => a + x.minutes, 0)),
      gaps: ctx.gaps.length,
      confidence: r.confidence,
      summary: r.summary,
    });
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${s.no}  期望 ${s.expect.ruleId}/${s.expect.party}  实得 ${r.ruleId}/${r.party}  ` +
        `读数${readings.length} 超温${ctx.excursions.length}段/${Math.round(ctx.excursions.reduce((a, x) => a + x.minutes, 0))}min 空洞${ctx.gaps.length}`
    );
    console.log(`      ${r.ruleName} · ${r.detail}`);
    if (!ok) console.log(`      真值说明: ${s.expect.note}`);
  }

  console.log(`\n========== 规则引擎真值校验 ==========`);
  console.log(`通过 ${pass} / ${pass + fail}`);
  return { pass, fail, rows };
}

if (require.main === module) {
  const { fail } = run();
  process.exit(fail === 0 ? 0 : 1);
}

module.exports = { buildScenario, run };
