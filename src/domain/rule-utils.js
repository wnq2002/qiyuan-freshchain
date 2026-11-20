'use strict';

/**
 * 规则引擎通用工具（独立模块，避免 rules.js 与 analyze.js 循环依赖）
 */

/** 时间窗重叠判定：a/b 可为 {at,durationMin} 或 {from,to} */
function overlaps(a, b) {
  const aFrom = a.from ?? a.at;
  const aTo = a.to ?? (a.at + (a.durationMin ?? 0) * 60000);
  return aFrom < b.to && b.from < aTo;
}

/** 东八区展示格式 */
function fmtTime(ts) {
  const d = new Date(ts + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * 线性回归求窗口内温度斜率（℃/小时）
 * 返回 null 表示样本不足（<3 点）
 */
function regressWindow(rs, from, to) {
  const pts = rs.filter((r) => r.ts >= from && r.ts <= to);
  if (pts.length < 3) return null;
  const n = pts.length;
  const t0 = pts[0].ts;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (const p of pts) {
    const x = (p.ts - t0) / 3600000;
    sx += x;
    sy += p.temp;
    sxy += x * p.temp;
    sxx += x * x;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  return { from, to, slope, minutes: (to - from) / 60000, samples: n };
}

module.exports = { overlaps, fmtTime, regressWindow };
