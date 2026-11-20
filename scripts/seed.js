'use strict';

/**
 * 数据初始化：把场景库落成数据库里的运单 / 读数 / 事件 / 设备台账 / 判定快照。
 *
 * 这份脚本同时扮演两个角色：
 *   ① 演示数据生成器（评审打开系统就能看到东西）
 *   ② 「设备数据接入」的参考实现 —— 真实实施时，把 simulate() 换成设备厂商的
 *      读数拉取即可，其余链路（落库 → 判定 → 展示）完全不变。
 *
 * 用法：node scripts/seed.js
 */

const store = require('../src/store');
const { SCENARIOS, ZONES, BASE, M } = require('../src/domain/scenarios');
const { simulate } = require('../src/domain/simulator');
const { buildContext, judge } = require('../src/domain/analyze');

function seed() {
  store.reset();

  let ok = 0;
  let mismatch = 0;
  const results = [];

  for (const s of SCENARIOS) {
    const startTs = BASE + s.startOffsetH * 3600000;
    const z = ZONES[s.zone];
    const sim = s.sim;

    const readings = simulate({
      startTs,
      minutes: s.durationMin,
      setPoint: sim.setPoint,
      seed: sim.seed,
      doors: sim.doors || [],
      stops: sim.stops || [],
      preloadOffset: sim.preloadOffset || 0,
      cargoHeat: sim.cargoHeat || null,
      drift: sim.drift || 0,
      gaps: sim.gaps || [],
      secondProbe: sim.secondProbe,
    });

    const events = s.events.map((e) => ({
      type: e.type,
      at: startTs + e.atMin * M,
      durationMin: e.durationMin || 0,
      actor: e.actor,
      note: e.note,
    }));

    const endTs = s.status === 'transit'
      ? startTs + Math.round(s.durationMin * 0.55) * M  // 在途：只到中途
      : startTs + s.durationMin * M;

    const waybill = {
      no: s.no,
      customer: s.customer,
      cargo: s.cargo,
      zoneLabel: z.label,
      zoneMin: z.zoneMin,
      zoneMax: z.zoneMax,
      origin: s.origin,
      dest: s.dest,
      plate: s.plate,
      driver: s.driver,
      deviceId: s.deviceId,
      status: s.status,
      startTs,
      endTs,
    };

    store.insertWaybill(waybill);

    // 在途运单只落已产生的读数与事件
    const visReadings = readings.filter((r) => r.ts <= endTs);
    const visEvents = events.filter((e) => e.at <= endTs);
    store.insertReadings(s.no, visReadings);
    store.insertEvents(s.no, visEvents);

    const asset = s.asset
      ? { deviceId: s.deviceId, plate: s.plate, lastMaintainedAt: startTs + (s.asset.lastMaintainedAtOffsetDays || 0) * 86400000 }
      : { deviceId: s.deviceId, plate: s.plate, lastMaintainedAt: startTs - 45 * 86400000 };
    store.upsertAsset(asset);

    // 已交付运单落判定快照；在途运单不判定
    if (s.status !== 'transit') {
      const ctx = buildContext(waybill, visReadings, visEvents, asset);
      const v = judge(ctx);
      const metrics = {
        excursionCount: ctx.excursions.length,
        excursionMinutes: Math.round(ctx.excursions.reduce((a, x) => a + x.minutes, 0)),
      };
      store.saveSnapshot(s.no, v, metrics);

      if (s.expect.ruleId && v.ruleId !== s.expect.ruleId) mismatch++;
      else ok++;
      results.push({ no: s.no, expect: s.expect.ruleId, actual: v.ruleId, party: v.partyName });
    } else {
      results.push({ no: s.no, expect: '在途', actual: '在途', party: '—' });
    }
  }

  console.log(`数据库: ${store.DB_PATH}`);
  console.log(`运单 ${SCENARIOS.length} 票（已交付 ${SCENARIOS.filter(s=>s.status!=='transit').length} / 在途 ${SCENARIOS.filter(s=>s.status==='transit').length}）`);
  console.log('');
  console.log('运单号              期望   实际   责任主体');
  for (const r of results) {
    const mark = r.expect === r.actual ? ' ' : '!';
    console.log(`${mark}${r.no}  ${String(r.expect).padEnd(6)}${String(r.actual).padEnd(7)}${r.party}`);
  }
  console.log('');
  console.log(mismatch === 0 ? '全部命中真值 ✔' : `有 ${mismatch} 票与真值不一致 ✘`);
  return mismatch;
}

if (require.main === module) {
  const mismatch = seed();
  process.exit(mismatch === 0 ? 0 : 1);
}

module.exports = { seed };
