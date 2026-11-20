'use strict';

/**
 * 场景库：每个场景带「真值」（应命中的规则），是规则引擎验证的黄金标尺。
 * 同一份定义同时被 scripts/seed.js（造数据）和 tests/（断言）消费，
 * 保证「演示数据」与「测试用例」永不脱节。
 */

const H = 3600000;
const M = 60000;
const BASE = Date.UTC(2026, 10, 18, 0, 0, 0); // 2026-11-18 08:00 东八区

const ZONES = {
  frozen: { zoneMin: -20, zoneMax: -18, label: '冷冻' },
  chilled: { zoneMin: 0, zoneMax: 4, label: '冷藏' },
  ambient: { zoneMin: 10, zoneMax: 15, label: '恒温' },
};

/**
 * 场景定义
 *  expect.ruleId  —— 期望命中的规则（真值）
 *  expect.party   —— 期望责任主体
 *  kind           —— 'history' 已完成 / 'transit' 在途（在途用于看板实时展示）
 */
const SCENARIOS = [
  {
    no: 'LT20261118001',
    customer: '鲜丰连锁超市',
    cargo: '速冻水饺（-18℃）',
    zone: 'frozen',
    origin: '南宁江南冷库',
    dest: '柳州城中分拨中心',
    plate: '桂A·D8821',
    driver: '李国强',
    deviceId: 'RC-2023-0451',
    status: 'delivered',
    startOffsetH: 0,
    durationMin: 330,
    sim: { setPoint: -19, seed: 11, doors: [{ at: 150, durationMin: 8 }], stops: [] },
    events: [
      { type: 'load_start', atMin: 0, actor: '发货方·组板员', note: '开始装车' },
      { type: 'depart', atMin: 45, actor: '司机·李国强', note: '装车完成出发' },
      { type: 'door_open', atMin: 150, durationMin: 8, actor: '司机·李国强', note: '中途开门取随车单据' },
      { type: 'arrive', atMin: 300, actor: '司机·李国强', note: '到达分拨中心' },
      { type: 'unload_end', atMin: 330, actor: '收货方·卸货组', note: '卸货完成' },
    ],
    expect: { ruleId: 'R08', party: 'NONE', note: '全程温控合格，8 分钟开门未造成超温' },
  },

  {
    no: 'LT20261118002',
    customer: '桂香食品厂',
    cargo: '冷鲜猪肉（0~4℃）',
    zone: 'chilled',
    origin: '桂香食品厂冷库',
    dest: '南宁万象城门店',
    plate: '桂A·D9103',
    driver: '韦建华',
    deviceId: 'RC-2023-0452',
    status: 'delivered',
    startOffsetH: 1,
    durationMin: 240,
    // 装车时未预冷到位，出发即偏高
    sim: { setPoint: 2, seed: 22, preloadOffset: 5.5, warmRate: 0.6, doors: [] },
    events: [
      { type: 'load_start', atMin: 0, actor: '发货方·组板员', note: '开始装车' },
      { type: 'depart', atMin: 30, actor: '司机·韦建华', note: '装车完成出发' },
      { type: 'arrive', atMin: 210, actor: '司机·韦建华', note: '到达门店' },
      { type: 'unload_end', atMin: 240, actor: '收货方·理货员', note: '卸货完成' },
    ],
    expect: { ruleId: 'R01', party: 'SHIP', note: '装车完成时已达 7.5℃，出库即超标' },
  },

  {
    no: 'LT20261118003',
    customer: '康泰医药流通',
    cargo: '疫苗类生物制品（2~8℃）',
    zone: 'chilled',
    origin: '南宁高新区医药仓',
    dest: '桂林七星区疾控中心',
    plate: '桂A·E2077',
    driver: '黄志明',
    deviceId: 'RC-2022-0118',
    status: 'delivered',
    startOffsetH: 2,
    durationMin: 420,
    // 预冷不足：装车合格但出发后快速升温，无开门无停机
    sim: { setPoint: 2.6, seed: 33, preloadOffset: 0.4, cargoHeat: { at: 40, q0: 0.17, tau: 80 }, doors: [], stops: [] },
    events: [
      { type: 'load_start', atMin: 0, actor: '发货方·质管员', note: '冷链交接，核对温度记录' },
      { type: 'depart', atMin: 40, actor: '司机·黄志明', note: '装车完成出发' },
      { type: 'arrive', atMin: 390, actor: '司机·黄志明', note: '到达疾控中心' },
      { type: 'unload_end', atMin: 420, actor: '收货方·仓管', note: '卸货完成' },
    ],
    expect: { ruleId: 'R02', party: 'SHIP', note: '装车 4.2℃ 合格，出发后 30 分钟升温超 2℃/h，判预冷不足' },
  },

  {
    no: 'LT20261118004',
    customer: '鲜丰连锁超市',
    cargo: '冷藏乳品（0~4℃）',
    zone: 'chilled',
    origin: '南宁江南冷库',
    dest: '北海海城门店',
    plate: '桂A·D6650',
    driver: '陆文斌',
    deviceId: 'RC-2023-0460',
    status: 'delivered',
    startOffsetH: 3,
    durationMin: 300,
    // 中途开门 45 分钟（带货给另一客户）
    sim: { setPoint: 2, seed: 44, doors: [{ at: 120, durationMin: 45 }], stops: [] },
    events: [
      { type: 'load_start', atMin: 0, actor: '发货方·组板员', note: '开始装车' },
      { type: 'depart', atMin: 35, actor: '司机·陆文斌', note: '装车完成出发' },
      { type: 'door_open', atMin: 120, durationMin: 45, actor: '司机·陆文斌', note: '中途为其他客户带货开门' },
      { type: 'arrive', atMin: 270, actor: '司机·陆文斌', note: '到达门店' },
      { type: 'unload_end', atMin: 300, actor: '收货方·理货员', note: '卸货完成' },
    ],
    expect: { ruleId: 'R03', party: 'CARR', note: '开门 45 分钟超规范 10 分钟，与超温区间重叠' },
  },

  {
    no: 'LT20261118005',
    customer: '鼎味餐饮供应链',
    cargo: '冷冻牛肉（-18℃）',
    zone: 'frozen',
    origin: '钦州港冷链仓',
    dest: '玉林玉州中央厨房',
    plate: '桂A·D3392',
    driver: '农建国',
    deviceId: 'RC-2021-0093',
    status: 'delivered',
    startOffsetH: 4,
    durationMin: 380,
    // 到货合格但卸货拖了 2 小时 20 分
    sim: { setPoint: -19, seed: 55, doors: [{ at: 250, durationMin: 140 }], stops: [] },
    events: [
      { type: 'load_start', atMin: 0, actor: '发货方·组板员', note: '开始装车' },
      { type: 'depart', atMin: 40, actor: '司机·农建国', note: '装车完成出发' },
      { type: 'arrive', atMin: 240, actor: '司机·农建国', note: '到达中央厨房，温度合格' },
      { type: 'door_open', atMin: 250, durationMin: 140, actor: '收货方·卸货组', note: '卸货开门，等待周转筐' },
      { type: 'unload_end', atMin: 380, actor: '收货方·卸货组', note: '卸货完成' },
    ],
    expect: { ruleId: 'R04', party: 'CONS', note: '到达时合格，卸货 140 分钟超 60 分钟规范' },
  },

  {
    no: 'LT20261118006',
    customer: '康泰医药流通',
    cargo: '血液制品（2~8℃）',
    zone: 'chilled',
    origin: '南宁高新区医药仓',
    dest: '百色右江区医院',
    plate: '桂A·E4418',
    driver: '黄志明',
    deviceId: 'RC-2022-0176',
    status: 'delivered',
    startOffsetH: 5,
    durationMin: 460,
    // 机组停机 90 分钟
    sim: { setPoint: 3, seed: 66, stops: [{ at: 150, durationMin: 90 }] },
    events: [
      { type: 'load_start', atMin: 0, actor: '发货方·质管员', note: '冷链交接' },
      { type: 'depart', atMin: 45, actor: '司机·黄志明', note: '装车完成出发' },
      { type: 'unit_stop', atMin: 150, durationMin: 90, actor: '车载系统', note: '制冷机组故障停机' },
      { type: 'arrive', atMin: 430, actor: '司机·黄志明', note: '到达医院' },
      { type: 'unload_end', atMin: 460, actor: '收货方·药房', note: '卸货完成' },
    ],
    asset: { lastMaintainedAtOffsetDays: -160 }, // 160 天前维保，超 90 天 → 设备方
    expect: { ruleId: 'R05', party: 'EQUIP', note: '机组停机 90 分钟，超 90 天未维保，判设备方' },
  },

  {
    no: 'LT20261118007',
    customer: '鲜丰连锁超市',
    cargo: '冷藏果蔬（0~4℃）',
    zone: 'chilled',
    origin: '南宁江南冷库',
    dest: '贵港港北门店',
    plate: '桂A·D7712',
    driver: '陆文斌',
    deviceId: 'RC-2023-0471',
    status: 'delivered',
    startOffsetH: 6,
    durationMin: 280,
    // 数据缺失 35 分钟，且跨超温区间
    sim: {
      setPoint: 2, seed: 77, doors: [{ at: 100, durationMin: 25 }],
      gaps: [{ at: 95, durationMin: 35 }],
    },
    events: [
      { type: 'load_start', atMin: 0, actor: '发货方·组板员', note: '开始装车' },
      { type: 'depart', atMin: 30, actor: '司机·陆文斌', note: '装车完成出发' },
      { type: 'door_open', atMin: 100, durationMin: 25, actor: '司机·陆文斌', note: '开门查货' },
      { type: 'arrive', atMin: 250, actor: '司机·陆文斌', note: '到达门店' },
      { type: 'unload_end', atMin: 280, actor: '收货方·理货员', note: '卸货完成' },
    ],
    expect: { ruleId: 'R06', party: 'EQUIP', note: '记录仪数据缺失 35 分钟且与超温紧邻，数据不可信' },
  },

  {
    no: 'LT20261118008',
    customer: '鼎味餐饮供应链',
    cargo: '冷藏鲜奶（0~4℃）',
    zone: 'chilled',
    origin: '钦州港冷链仓',
    dest: '南宁青秀门店',
    plate: '桂A·D5580',
    driver: '农建国',
    deviceId: 'RC-2023-0482',
    status: 'delivered',
    startOffsetH: 7,
    durationMin: 320,
    // 制冷能力不足：开门均合规（10 分钟 ≤10 分钟规范），但每次开门后压不回去，
    // 形成 4 段小幅超温。业务含义：不是司机的错，是车不行。
    sim: { setPoint: 3.3, seed: 88, doors: [{ at: 60, durationMin: 10 },{ at: 120, durationMin: 10 },{ at: 180, durationMin: 10 },{ at: 240, durationMin: 10 }] },
    events: [
      { type: 'load_start', atMin: 0, actor: '发货方·组板员', note: '开始装车' },
      { type: 'depart', atMin: 30, actor: '司机·农建国', note: '装车完成出发' },
      { type: 'door_open', atMin: 60, durationMin: 10, actor: '司机·农建国', note: '核对单据（合规）' },
      { type: 'door_open', atMin: 120, durationMin: 10, actor: '司机·农建国', note: '核对单据（合规）' },
      { type: 'door_open', atMin: 180, durationMin: 10, actor: '司机·农建国', note: '核对单据（合规）' },
      { type: 'door_open', atMin: 240, durationMin: 10, actor: '司机·农建国', note: '核对单据（合规）' },
      { type: 'arrive', atMin: 290, actor: '司机·农建国', note: '到达门店' },
      { type: 'unload_end', atMin: 320, actor: '收货方·理货员', note: '卸货完成' },
    ],
    expect: { ruleId: 'R07', party: 'CARR', note: '4 次开门均合规，但每次压不回去，多次短超温累计超 45 分钟，判制冷能力不足' },
  },

  {
    no: 'LT20261118009',
    customer: '桂香食品厂',
    cargo: '冷冻调理品（-18℃）',
    zone: 'frozen',
    origin: '桂香食品厂冷库',
    dest: '梧州长洲商超仓',
    plate: '桂A·D2214',
    driver: '李国强',
    deviceId: 'RC-2023-0490',
    status: 'delivered',
    startOffsetH: 8,
    durationMin: 340,
    // 全程温度合格，但收货方以"包装破损"拒收
    sim: { setPoint: -19, seed: 99, doors: [{ at: 200, durationMin: 7 }] },
    events: [
      { type: 'load_start', atMin: 0, actor: '发货方·组板员', note: '开始装车' },
      { type: 'depart', atMin: 40, actor: '司机·李国强', note: '装车完成出发' },
      { type: 'arrive', atMin: 300, actor: '司机·李国强', note: '到达商超仓' },
      { type: 'reject', atMin: 315, actor: '收货方·验收员', note: '包装破损，整批拒收' },
      { type: 'unload_end', atMin: 340, actor: '收货方·验收员', note: '退货装回' },
    ],
    expect: { ruleId: 'R09', party: 'CONS', note: '温控全程合格但被拒收，责任在收货方' },
  },

  {
    no: 'LT20261118010',
    customer: '康泰医药流通',
    cargo: '医疗器械（恒温 10~15℃）',
    zone: 'ambient',
    origin: '南宁高新区医药仓',
    dest: '崇左江州区医院',
    plate: '桂A·E9931',
    driver: '韦建华',
    deviceId: 'RC-2022-0205',
    status: 'delivered',
    startOffsetH: 9,
    durationMin: 260,
    // 证据不足：只有 6 条读数、无事件
    sim: { setPoint: 12.5, seed: 111, gaps: [{ at: 20, durationMin: 155 },{ at: 200, durationMin: 50 }] },
    events: [],
    expect: { ruleId: 'R10', party: 'UNKNOWN', note: '读数仅 6 条且无事件记录，证据不足以判定' },
  },

  // ---------- 在途运单（看板实时展示用） ----------
  {
    no: 'LT20261118011',
    customer: '鲜丰连锁超市',
    cargo: '冷藏乳品（0~4℃）',
    zone: 'chilled',
    origin: '南宁江南冷库',
    dest: '来宾兴宾门店',
    plate: '桂A·D8801',
    driver: '陆文斌',
    deviceId: 'RC-2023-0501',
    status: 'transit',
    startOffsetH: 10,
    durationMin: 420,
    sim: { setPoint: 2, seed: 121, secondProbe: true, doors: [{ at: 120, durationMin: 12 }], stops: [] },
    events: [
      { type: 'load_start', atMin: 0, actor: '发货方·组板员', note: '开始装车' },
      { type: 'depart', atMin: 40, actor: '司机·陆文斌', note: '装车完成出发' },
      { type: 'door_open', atMin: 120, durationMin: 12, actor: '司机·陆文斌', note: '中途开门检查' },
    ],
    expect: { ruleId: null, party: null, note: '在途运单，仅展示不判定' },
  },

  {
    no: 'LT20261118012',
    customer: '鼎味餐饮供应链',
    cargo: '冷冻虾仁（-18℃）',
    zone: 'frozen',
    origin: '钦州港冷链仓',
    dest: '贺州八步门店',
    plate: '桂A·D4471',
    driver: '农建国',
    deviceId: 'RC-2021-0107',
    status: 'transit',
    startOffsetH: 11,
    durationMin: 400,
    // 在途正在超温：机组停机未恢复
    sim: { setPoint: -19, seed: 131, stops: [{ at: 150, durationMin: 200 }] },
    events: [
      { type: 'load_start', atMin: 0, actor: '发货方·组板员', note: '开始装车' },
      { type: 'depart', atMin: 35, actor: '司机·农建国', note: '装车完成出发' },
      { type: 'unit_stop', atMin: 150, durationMin: 200, actor: '车载系统', note: '制冷机组报警停机' },
    ],
    asset: { lastMaintainedAtOffsetDays: -200 },
    expect: { ruleId: null, party: null, note: '在途运单，正在超温，用于看板演示告警' },
  },
];

module.exports = { SCENARIOS, ZONES, BASE, H, M };
