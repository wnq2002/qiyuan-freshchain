'use strict';

/**
 * 冷链温度物理模拟器
 *
 * 目的：生成形态与真实记录仪一致的 5 分钟粒度温度序列，使规则引擎可在
 * 「已知真值」的场景上被验证。边界：非真实采集，未接真实设备（见 docs/01 §5）。
 *
 * 物理模型（四个真实影响因素）：
 *   制冷周期  —— 机组启停维持温度在设定点上下波动（±0.35℃，周期约 40 分钟）
 *   开门作业  —— 开门期间按 0.15℃/分钟 升温（实测冷藏车开门 0.1~0.2℃/min）
 *   机组停机  —— 停机后按环境温差驱动的指数趋近升温（时间常数 3 小时）
 *   货物带热  —— 预冷不足时，货物释放热量按指数衰减，导致出发后快速升温再自行回落
 *   环境扰动  —— 确定性伪随机（种子固定），保证同场景每次生成完全一致
 *
 * 关键设计：**不用固定升温速率模拟"预冷不足"**，而用衰减热源 cargoHeat。
 * 这样"升温后能自行回落"与"制冷能力不足持续升温"在物理上被区分开，
 * 规则 R02 与 R07 才有可判定的分野（这是首轮验证失败暴露出的问题）。
 */

/** 确定性伪随机（mulberry32），保证可复现 */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {object} opt
 * @param {number} opt.startTs        起始时间戳
 * @param {number} opt.minutes        总时长（分钟）
 * @param {number} opt.setPoint       目标温度
 * @param {number} opt.seed           随机种子
 * @param {Array}  opt.doors          [{ at, durationMin }] 相对分钟
 * @param {Array}  opt.stops          [{ at, durationMin }] 相对分钟
 * @param {number} opt.preloadOffset  起始温度偏移
 * @param {object} opt.cargoHeat      { at, q0, tau } 货物带热：q0 ℃/min 初始放热，tau 分钟衰减常数
 * @param {number} opt.drift          ℃/小时 整体漂移（制冷能力持续不足）
 * @param {Array}  opt.gaps           [{ at, durationMin }] 数据缺失
 * @param {number} opt.step           采样间隔分钟，默认 5
 * @param {boolean} opt.secondProbe   是否生成第二个探头
 */
function simulate(opt) {
  const {
    startTs, minutes, setPoint, seed = 1,
    doors = [], stops = [], preloadOffset = 0,
    cargoHeat = null, drift = 0, gaps = [], step = 5,
    secondProbe = false,
  } = opt;

  const rand = rng(seed);
  const out = [];
  let temp = setPoint + preloadOffset;

  const inDoor = (m) => doors.some((d) => m >= d.at && m < d.at + d.durationMin);
  const inStop = (m) => stops.some((s) => m >= s.at && m < s.at + s.durationMin);
  const inGap = (m) => gaps.some((g) => m >= g.at && m < g.at + g.durationMin);

  for (let m = 0; m <= minutes; m += step) {
    const t = m / 60;                                    // 小时
    const cycle = Math.sin((m / 40) * Math.PI * 2) * 0.35; // 制冷周期波动
    const noise = (rand() - 0.5) * 0.10;                 // 传感噪声

    if (inStop(m)) {
      // 指数趋近环境温度（约 25℃），时间常数 3 小时
      const k = 1 - Math.exp(-step / 60 / 3);
      temp += (25 - temp) * k;
    } else if (inDoor(m)) {
      temp += 0.15 * step;                               // 开门升温
    } else {
      // 回归设定点（制冷能力执行中）；drift 表示制冷能力持续不足
      const target = setPoint + cycle + drift * t;
      temp += (target - temp) * 0.12;
    }

    // 货物带热：出发后按指数衰减释放热量（预冷不足的物理表现）
    if (cargoHeat && m >= cargoHeat.at) {
      const dtau = m - cargoHeat.at;
      temp += cargoHeat.q0 * Math.exp(-dtau / cargoHeat.tau) * step;
    }

    temp += noise;

    if (!inGap(m)) {
      out.push({ ts: startTs + m * 60000, temp: Math.round(temp * 10) / 10, probe: 'REAR-1' });
      if (secondProbe) {
        out.push({
          ts: startTs + m * 60000,
          temp: Math.round((temp + 0.4 + (rand() - 0.5) * 0.2) * 10) / 10,
          probe: 'DOOR-2',
        });
      }
    }
  }
  return out;
}

module.exports = { simulate, rng };
