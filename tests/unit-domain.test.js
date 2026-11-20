'use strict';

/**
 * 单元测试：领域层
 * 覆盖：超温区间识别、容差边界、去抖、采样空洞、斜率回归、数据完整性、规则优先级
 *
 * 运行：node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert');
const { buildContext, judge, findExcursions, findGaps, assessCompleteness, TOLERANCE, MIN_EXCURSION_MIN } = require('../src/domain/analyze');
const { regressWindow, overlaps } = require('../src/domain/rule-utils');
const { RULES, PARTY } = require('../src/domain/rules');

const M = 60000;
const T0 = Date.UTC(2026, 10, 18, 0, 0, 0);

/** 造一段读数：从 T0 开始，每 5 分钟一条 */
function makeReadings(temps, step = 5) {
  return temps.map((t, i) => ({ ts: T0 + i * step * M, temp: t, probe: 'REAR-1' }));
}

const WB_CHILLED = { no: 'T001', zoneMin: 0, zoneMax: 4, status: 'delivered' };

test('findExcursions: 平稳在温区内不产生区间', () => {
  const rs = makeReadings(Array(20).fill(2));
  const ex = findExcursions(rs, WB_CHILLED);
  assert.equal(ex.length, 0);
});

test('findExcursions: 容差内(±0.5℃)不算超温', () => {
  // 上限 4，容差 0.5 → 4.4 不算超温
  const rs = makeReadings(Array(20).fill(4.4));
  assert.equal(findExcursions(rs, WB_CHILLED).length, 0);
});

test('findExcursions: 超出容差即判超温', () => {
  const rs = makeReadings(Array(20).fill(4.6));
  const ex = findExcursions(rs, WB_CHILLED);
  assert.ok(ex.length >= 1, '4.6℃ 应判超温');
  assert.equal(ex[0].direction, 'high');
});

test('findExcursions: 低于下限同样判超温', () => {
  const rs = makeReadings(Array(20).fill(-1));
  const ex = findExcursions(rs, WB_CHILLED);
  assert.ok(ex.length >= 1);
  assert.equal(ex[0].direction, 'low');
});

test(`findExcursions: 短于 ${MIN_EXCURSION_MIN} 分钟的抖动被去抖丢弃`, () => {
  // 构造单点尖峰（5 分钟），应被丢弃
  const temps = Array(20).fill(2);
  temps[10] = 6;
  const ex = findExcursions(makeReadings(temps), WB_CHILLED);
  assert.equal(ex.length, 0, '单点尖峰应被去抖');
});

test('findExcursions: 持续超温被正确识别并计算时长', () => {
  const temps = [...Array(10).fill(2), ...Array(12).fill(6), ...Array(10).fill(2)];
  const ex = findExcursions(makeReadings(temps), WB_CHILLED);
  assert.equal(ex.length, 1);
  assert.ok(ex[0].minutes > 40 && ex[0].minutes < 80, `时长应约 60 分钟，实际 ${ex[0].minutes}`);
  assert.equal(ex[0].peak, 6);
});

test('findGaps: 识别 >20 分钟采样空洞', () => {
  const rs = makeReadings(Array(10).fill(2));
  // 插入一个 50 分钟空洞
  rs.push({ ts: T0 + (9 * 5 + 50) * M, temp: 2, probe: 'REAR-1' });
  const gaps = findGaps(rs);
  assert.equal(gaps.length, 1);
  assert.ok(gaps[0].minutes >= 50);
});

test('regressWindow: 线性升温斜率正确', () => {
  // 每 5 分钟升 1℃ → 12℃/小时
  const rs = makeReadings([0, 1, 2, 3, 4, 5, 6], 5);
  const w = regressWindow(rs, rs[0].ts, rs[rs.length - 1].ts);
  assert.ok(w);
  assert.ok(Math.abs(w.slope - 12) < 0.5, `斜率应约 12，实际 ${w.slope}`);
});

test('regressWindow: 样本不足返回 null', () => {
  const rs = makeReadings([2, 2], 5);
  assert.equal(regressWindow(rs, rs[0].ts, rs[1].ts), null);
});

test('assessCompleteness: 完整数据通过', () => {
  const rs = makeReadings(Array(50).fill(2));
  const r = assessCompleteness(rs);
  assert.equal(r.dataComplete, true);
  assert.ok(r.coverage > 0.9);
});

test('assessCompleteness: 存在长时间空洞即判不完整', () => {
  const rs = makeReadings(Array(10).fill(2));
  rs.push({ ts: T0 + (9 * 5 + 200) * M, temp: 2, probe: 'REAR-1' });
  rs.push({ ts: T0 + (9 * 5 + 205) * M, temp: 2, probe: 'REAR-1' });
  const r = assessCompleteness(rs);
  assert.equal(r.dataComplete, false, '存在 200 分钟空洞应判不完整');
});

test('assertCompleteness: 读数过少判不完整', () => {
  const rs = makeReadings([2, 2, 2]);
  assert.equal(assessCompleteness(rs).dataComplete, false);
});

test('overlaps: 时间窗重叠判定', () => {
  const a = { at: T0, durationMin: 30 };
  assert.equal(overlaps(a, { from: T0 + 10 * M, to: T0 + 40 * M }), true);
  assert.equal(overlaps(a, { from: T0 + 40 * M, to: T0 + 60 * M }), false);
  assert.equal(overlaps(a, { from: T0 - 20 * M, to: T0 - 5 * M }), false);
});

test('judge: 规则按优先级短路，R01 优先于 R02', () => {
  // 装车即超标 → 应命中 R01，而非后续规则
  const rs = makeReadings(Array(30).fill(8));
  const events = [
    { type: 'depart', at: T0 + 30 * M, durationMin: 0 },
    { type: 'arrive', at: T0 + 120 * M, durationMin: 0 },
  ];
  const ctx = buildContext(WB_CHILLED, rs, events, null);
  assert.equal(judge(ctx).ruleId, 'R01');
});

test('judge: 在途运单不出最终责任结论', () => {
  const rs = makeReadings(Array(30).fill(8));
  const wb = { ...WB_CHILLED, status: 'transit' };
  const ctx = buildContext(wb, rs, [{ type: 'depart', at: T0 + 20 * M }], null);
  const v = judge(ctx);
  assert.equal(v.party, 'PENDING');
  assert.equal(v.ruleId, 'IN_TRANSIT');
  assert.equal(v.confidence, null, '在途不应给出置信度');
});

test('judge: 判定确定性 —— 同输入两次调用结果一致', () => {
  const rs = makeReadings([2, 2, 2, 3, 4, 5, 5, 4, 3, 2, 2, 2]);
  const events = [
    { type: 'depart', at: T0 + 5 * M, durationMin: 0 },
    { type: 'arrive', at: T0 + 50 * M, durationMin: 0 },
    { type: 'unload_end', at: T0 + 55 * M, durationMin: 0 },
  ];
  const ctx = buildContext(WB_CHILLED, rs, events, null);
  const a = judge(ctx);
  const b = judge(ctx);
  assert.deepEqual({ ...a, judgedAt: null }, { ...b, judgedAt: null });
});

test('judge: 无事件且读数少 → 落 R10 而非判合格', () => {
  const rs = makeReadings([2, 2, 2]);
  const ctx = buildContext(WB_CHILLED, rs, [], null);
  assert.equal(judge(ctx).ruleId, 'R10');
});

test('规则表完整性: 10 条规则、编号唯一、优先级唯一', () => {
  assert.equal(RULES.length, 10);
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, '规则编号必须唯一');
  const prios = RULES.map((r) => r.priority);
  assert.equal(new Set(prios).size, prios.length, '优先级必须唯一，否则短路顺序不确定');
});

test('规则表完整性: 每条规则都有 id/name/party/why/test', () => {
  for (const r of RULES) {
    assert.ok(r.id, '缺 id');
    assert.ok(r.name, `${r.id} 缺 name`);
    assert.ok(r.party, `${r.id} 缺 party`);
    assert.ok(r.why && r.why.length > 10, `${r.id} 缺业务含义说明`);
    assert.equal(typeof r.test, 'function', `${r.id} 缺 test`);
  }
});

test('责任主体字典: 六个主体齐备', () => {
  for (const k of ['SHIP', 'CARR', 'CONS', 'EQUIP', 'NONE', 'UNKNOWN']) {
    assert.ok(PARTY[k], `缺主体 ${k}`);
    assert.ok(PARTY[k].name, `${k} 缺中文名`);
  }
});
