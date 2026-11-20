'use strict';

/**
 * 冷链责任判定规则集（R01–R10）
 *
 * 设计约束（见 docs/03 §3）：
 *  1. 一条规则一个可判定条件，禁止"综合判断"式表述
 *  2. 每条规则必须能指出证据（时段 / 读数 / 事件）
 *  3. 规则有优先级，冲突时高优先级胜出
 *  4. 新增规则不改引擎代码，只改本表
 *  5. 判定确定性：无随机、无当前时间依赖、无外部调用
 *
 * 每个规则：
 *   id        规则编号
 *   name      规则名
 *   party     责任主体 SHIP / CARR / CONS / EQUIP / NONE / UNKNOWN
 *   priority  数值越小越优先（短路求值）
 *   why       业务含义（对外解释用）
 *   test(ctx) 返回 null 表示不命中；命中返回 { evidence: [{label, value}], confidence, detail }
 */

const PARTY = {
  SHIP: { code: 'SHIP', name: '发货方', desc: '出库温度、预冷、装车作业、包装' },
  CARR: { code: 'CARR', name: '承运方', desc: '运输途中温控、车辆与机组状态、司机作业规范' },
  CONS: { code: 'CONS', name: '收货方', desc: '卸货作业、收货等待、卸货时长' },
  EQUIP: { code: 'EQUIP', name: '设备方', desc: '记录仪与制冷机组故障、数据完整性' },
  NONE: { code: 'NONE', name: '无责任方', desc: '温控全程合格' },
  UNKNOWN: { code: 'UNKNOWN', name: '无法判定', desc: '证据不足，须人工介入' },
};

const RULES = [
  {
    id: 'R01',
    name: '装车温度不合格',
    party: 'SHIP',
    priority: 10,
    why: '货出库即已超标，运输环节无责。承运方最需要这条来反驳"到货坏了就是你的责任"。',
    test(ctx) {
      const d = ctx.departRead;
      if (!d) return null;
      const { zoneMin, zoneMax } = ctx.waybill;
      if (d.temp > zoneMax || d.temp < zoneMin) {
        return {
          confidence: 0.95,
          detail: `装车完成时刻温度 ${d.temp.toFixed(1)}℃ 已超出温区 [${zoneMin}, ${zoneMax}]，货物出库即不合格。`,
          evidence: [
            { label: '装车完成时刻', value: fmtTime(d.at) },
            { label: '该时刻读数', value: `${d.temp.toFixed(1)}℃` },
            { label: '该票温区', value: `[${zoneMin}, ${zoneMax}]℃` },
            { label: '越界幅度', value: `${(d.temp > zoneMax ? d.temp - zoneMax : zoneMin - d.temp).toFixed(1)}℃` },
          ],
        };
      }
      return null;
    },
  },

  {
    id: 'R06',
    name: '设备数据缺失',
    party: 'EQUIP',
    priority: 20,
    why: '数据不连续时，任何基于数据的判定都不成立，必须先解决数据问题。设备方常说"数据不连续不能作依据"，这条把球踢回去。',
    test(ctx) {
      const gaps = ctx.gaps.filter((g) => g.overlapsExcursion || g.nearExcursion);
      if (gaps.length === 0) return null;
      const g = gaps[0];
      return {
        confidence: 0.7,
        detail: `温度序列存在 ${Math.round(g.minutes)} 分钟采样空洞，且与超温区间重叠或紧邻，数据不足以支撑责任认定。`,
        evidence: [
          { label: '空洞开始', value: fmtTime(g.from) },
          { label: '空洞结束', value: fmtTime(g.to) },
          { label: '缺失时长', value: `${Math.round(g.minutes)} 分钟` },
          { label: '采样空洞数', value: `${ctx.gaps.length} 处` },
        ],
        needManual: true,
      };
    },
  },

  {
    id: 'R05',
    name: '制冷机组非计划停机',
    party: (ctx) => (ctx.unitMaintainedRecently ? 'CARR' : 'EQUIP'),
    priority: 30,
    why: '把"车坏了"和"没保养"区分开：设备故障归设备方，未按时维保归承运方。这是承运方内部追责的关键分野。',
    test(ctx) {
      const stops = ctx.events.filter((e) => e.type === 'unit_stop');
      if (stops.length === 0) return null;
      // 停机期间温度持续上升且无开门事件
      const rising = ctx.risingWindows.filter(
        (w) => w.slope > 0.5 && !ctx.events.some((e) => e.type === 'door_open' && overlaps(e, w))
      );
      if (rising.length === 0) return null;
      const w = rising[0];
      return {
        confidence: 0.85,
        detail: `制冷机组发生 ${stops.length} 次非计划停机，停机期间温度以 ${w.slope.toFixed(2)}℃/小时 上升，且无开门作业，非作业原因导致升温。`,
        evidence: [
          { label: '停机事件数', value: `${stops.length} 次` },
          { label: '首次停机时间', value: fmtTime(stops[0].at) },
          { label: '停机期间升温斜率', value: `${w.slope.toFixed(2)} ℃/h` },
          { label: '该设备近期维保', value: ctx.unitMaintainedRecently ? '90 天内有记录（承运方维保责任）' : '90 天内无记录（设备方责任）' },
        ],
      };
    },
  },

  {
    id: 'R03',
    name: '途中开门超时',
    party: 'CARR',
    priority: 40,
    why: '中途私自开门（带货、加油、装卸其他货）是行业顽疾。这条让"开门"有代价。',
    test(ctx) {
      // 只认「运输途中」的开门：到达之后的开门属卸货作业，归 R04，不得在此误判
      const arrive = ctx.events.find((e) => e.type === 'arrive');
      const depart = ctx.events.find((e) => e.type === 'depart');
      const inTransit = (e) =>
        (!depart || e.at >= depart.at) && (!arrive || e.at < arrive.at);
      const doors = ctx.events.filter(
        (e) => e.type === 'door_open' && e.durationMin > 10 && inTransit(e)
      );
      if (doors.length === 0) return null;
      const hit = doors.find((d) => ctx.excursions.some((x) => overlaps(d, x)));
      if (!hit) return null;
      const ex = ctx.excursions.find((x) => overlaps(hit, x));
      return {
        confidence: 0.9,
        detail: `存在 ${hit.durationMin} 分钟开门作业（超过 10 分钟规范），且与超温区间重叠，升温由开门直接导致。`,
        evidence: [
          { label: '开门开始', value: fmtTime(hit.at) },
          { label: '开门时长', value: `${hit.durationMin} 分钟（规范 ≤10 分钟）` },
          { label: '重叠超温区间', value: `${fmtTime(ex.from)} ~ ${fmtTime(ex.to)}` },
          { label: '区间峰值', value: `${ex.peak.toFixed(1)}℃` },
        ],
      };
    },
  },

  {
    id: 'R04',
    name: '卸货超时',
    party: 'CONS',
    priority: 50,
    why: '到货时是好的，收货方压车三小时导致升温。这是承运方最有力的抗辩证据。',
    test(ctx) {
      const arrive = ctx.events.find((e) => e.type === 'arrive');
      const end = ctx.events.find((e) => e.type === 'unload_end');
      if (!arrive || !end) return null;
      const minutes = (end.at - arrive.at) / 60000;
      if (minutes <= 60) return null;
      const win = { from: arrive.at, to: end.at };
      const ex = ctx.excursions.find((x) => overlaps(win, x));
      if (!ex) return null;
      const arriveRead = ctx.readAt(arrive.at);
      const { zoneMin, zoneMax } = ctx.waybill;
      if (!arriveRead || arriveRead.temp > zoneMax || arriveRead.temp < zoneMin) return null; // 到货已超标，另论
      return {
        confidence: 0.88,
        detail: `到货时温度 ${arriveRead.temp.toFixed(1)}℃ 处于温区内，卸货作业持续 ${Math.round(minutes)} 分钟（超过 60 分钟），期间出现超温。`,
        evidence: [
          { label: '到达时刻', value: fmtTime(arrive.at) },
          { label: '到达时温度', value: `${arriveRead.temp.toFixed(1)}℃（温区内）` },
          { label: '卸货结束', value: fmtTime(end.at) },
          { label: '卸载时长', value: `${Math.round(minutes)} 分钟（规范 ≤60 分钟）` },
          { label: '期间峰值', value: `${ex.peak.toFixed(1)}℃` },
        ],
      };
    },
  },

  {
    id: 'R02',
    name: '预冷不足',
    party: 'SHIP',
    priority: 60,
    why: '装车时看着合格，一跑起来就压不住。传统上这锅会算给承运方，这条把账算回发货方。',
    test(ctx) {
      const depart = ctx.events.find((e) => e.type === 'depart');
      if (!depart) return null;
      const { zoneMin, zoneMax } = ctx.waybill;
      const d = ctx.readAt(depart.at);
      if (!d || d.temp > zoneMax || d.temp < zoneMin) return null; // 装车就超标的走 R01

      // 取「出发后 60 分钟」为观察域，在其中找最陡的 30 分钟子窗。
      // 不用单一固定窗口：货物带热的升温峰值可能出现在出发后 20~50 分钟任意位置，
      // 固定窗口会被制冷周期波动摊薄，导致漏判（首轮验证暴露）。
      const horizon = { from: depart.at, to: depart.at + 60 * 60000 };
      const busy = ctx.events.some(
        (e) => (e.type === 'door_open' || e.type === 'unit_stop') && overlaps(e, horizon)
      );
      if (busy) return null; // 有开门/停机，升温另有原因，不归发货方

      let steepest = null;
      for (let off = 0; off <= 30; off += 5) {
        const from = depart.at + off * 60000;
        const w = regressWindow(ctx.readings, from, from + 30 * 60000);
        if (!w) continue;
        if (!steepest || w.slope > steepest.slope) steepest = w;
      }
      if (!steepest || steepest.slope <= 2.0) return null;

      // 关键区分：预冷不足是「货物带热」——升温后能自行回落到基线附近。
      // 若全程持续攀升（末段仍高于基线），那是制冷能力不足，归 R07，不归发货方。
      // 基线取「出发瞬间 ±5 分钟」，不能取出发后 90 分钟 —— 那会把升温峰值算进基线，
      // 导致"已回落"被误判为"仍在上行"（首轮验证暴露）。
      const lastTs = ctx.readings[ctx.readings.length - 1].ts;
      const basePts = ctx.readings.filter(
        (r) => r.ts >= depart.at - 5 * 60000 && r.ts <= depart.at + 5 * 60000
      );
      const late = ctx.readings.filter((r) => r.ts >= lastTs - 60 * 60000);
      const baseAvg = basePts.reduce((s, r) => s + r.temp, 0) / (basePts.length || 1);
      const lateAvg = late.reduce((s, r) => s + r.temp, 0) / (late.length || 1);
      // 末段必须已回落到基线 +1.0℃ 以内；否则视为持续升温，交 R07
      if (lateAvg > baseAvg + 1.0) return null;

      return {
        confidence: 0.8,
        detail: `装车温度合格，但出发后 ${Math.round((steepest.from - depart.at) / 60000)}~${Math.round((steepest.to - depart.at) / 60000)} 分钟内以 ${steepest.slope.toFixed(2)}℃/小时 快速升温，期间无开门、无停机，且升温后已自行回落，判定为货物预冷不足携带热量。`,
        evidence: [
          { label: '出发时刻', value: fmtTime(depart.at) },
          { label: '出发温度', value: `${d.temp.toFixed(1)}℃（温区内）` },
          { label: '最陡 30 分钟斜率', value: `${steepest.slope.toFixed(2)} ℃/h（阈值 >2.0）` },
          { label: '斜率区间', value: `${fmtTime(steepest.from)} ~ ${fmtTime(steepest.to)}` },
          { label: '期间开门/停机事件', value: '无' },
          { label: '升温后是否回落', value: `是（出发基线 ${baseAvg.toFixed(1)}℃ → 末段均温 ${lateAvg.toFixed(1)}℃）` },
        ],
      };
    },
  },

  {
    id: 'R07',
    name: '多次小幅超温累积',
    party: 'CARR',
    priority: 70,
    why: '温控忽高忽低是制冷能力不足的表现，单次看都不严重，累计起来货已受损。',
    test(ctx) {
      if (ctx.excursions.length < 3) return null;
      const total = ctx.excursions.reduce((s, x) => s + x.minutes, 0);
      if (total <= 45) return null;
      const allShort = ctx.excursions.every((x) => x.minutes <= 30);
      if (!allShort) return null;
      return {
        confidence: 0.75,
        detail: `全程出现 ${ctx.excursions.length} 次短时超温，累计 ${Math.round(total)} 分钟，无单次严重超温，属制冷能力持续性不足。`,
        evidence: [
          { label: '超温区间数', value: `${ctx.excursions.length} 次（阈值 ≥3）` },
          { label: '累计超温时长', value: `${Math.round(total)} 分钟（阈值 >45）` },
          { label: '单次最长', value: `${Math.round(Math.max(...ctx.excursions.map((x) => x.minutes)))} 分钟` },
        ],
      };
    },
  },

  {
    id: 'R09',
    name: '温控合格但到货拒收',
    party: 'CONS',
    priority: 80,
    why: '温度没问题还拒收，责任在收货方。这条保护承运方不被无理扣款。',
    test(ctx) {
      if (ctx.excursions.length > 0) return null;
      const reject = ctx.events.find((e) => e.type === 'reject');
      if (!reject) return null;
      return {
        confidence: 0.82,
        detail: `全程温度合格（无超温区间），但收货方于 ${fmtTime(reject.at)} 拒收，理由："${reject.note || '未填写'}"。`,
        evidence: [
          { label: '全程温度范围', value: `${ctx.stats.min.toFixed(1)} ~ ${ctx.stats.max.toFixed(1)}℃` },
          { label: '温区要求', value: `[${ctx.waybill.zoneMin}, ${ctx.waybill.zoneMax}]℃` },
          { label: '拒收时刻', value: fmtTime(reject.at) },
          { label: '拒收理由', value: reject.note || '未填写' },
        ],
      };
    },
  },

  {
    id: 'R08',
    name: '温区内正常',
    party: 'NONE',
    priority: 90,
    why: '合格交付也必须有结论。否则系统只会报警不会免责，承运方不认这套系统。',
    test(ctx) {
      if (ctx.excursions.length > 0) return null;
      if (ctx.readings.length === 0) return null;
      // 安全底线：证据不足时不得判"无责任"。用「读数密度 + 事件完整性」双重判据，
      // 而非简单条数门槛 —— 避免刚好卡线的读数条数绕过错判（首轮验证暴露：
      // 12 条读数、200+ 分钟空洞，简单阈值仍放行）。
      if (ctx.waybill.zoneMin == null || ctx.waybill.zoneMax == null) return null;
      if (!ctx.dataComplete) return null;
      return {
        confidence: 0.98,
        detail: `全程 ${ctx.readings.length} 条读数均在温区 [${ctx.waybill.zoneMin}, ${ctx.waybill.zoneMax}]℃ 内，温控合格。`,
        evidence: [
          { label: '读数条数', value: `${ctx.readings.length} 条（覆盖率 ${(ctx.coverage * 100).toFixed(0)}%）` },
          { label: '温度范围', value: `${ctx.stats.min.toFixed(1)} ~ ${ctx.stats.max.toFixed(1)}℃` },
          { label: '平均温度', value: `${ctx.stats.avg.toFixed(1)}℃` },
          { label: '温区要求', value: `[${ctx.waybill.zoneMin}, ${ctx.waybill.zoneMax}]℃` },
        ],
      };
    },
  },

  {
    id: 'R10',
    name: '证据不足',
    party: 'UNKNOWN',
    priority: 999,
    why: '诚实地说"判不了"，比硬给一个错结论更有价值。系统输出"需人工介入 + 缺什么证据"，指导补证。',
    test(ctx) {
      const missing = [];
      if (ctx.readings.length < 10) missing.push(`温度读数仅 ${ctx.readings.length} 条（要求 ≥10）`);
      if (ctx.events.length === 0) missing.push('无任何事件记录（装车/开门/到达/卸货）');
      if (ctx.waybill.zoneMin == null || ctx.waybill.zoneMax == null) missing.push('运单未配置温区阈值');
      return {
        confidence: 0.4,
        detail: '现有证据不足以支撑责任认定，需人工介入补充证据后复判。',
        evidence: missing.length ? missing.map((m) => ({ label: '缺失项', value: m })) : [{ label: '说明', value: '不满足任何规则命中条件' }],
        needManual: true,
      };
    },
  },
];

// ---------- 工具（来自独立模块，避免循环依赖） ----------

const { overlaps, fmtTime, regressWindow } = require('./rule-utils');

module.exports = { RULES, PARTY, overlaps, fmtTime, regressWindow };
