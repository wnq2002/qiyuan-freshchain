'use strict';

/* 冷鲜通 · 前端应用（原生 JS，无依赖，手写 SVG 图表）
   路由：/            质控看板
         /waybill/:no 运单详情
         /track       客户问询
*/

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  route: null,
  dashboard: null,
  detail: null,
  timer: null,
};

// ---------- 工具 ----------

const pad = (n) => String(n).padStart(2, '0');

/** 东八区时间显示 */
function fmtTime(ts, withDate = true) {
  const d = new Date(ts + 8 * 3600 * 1000);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (!withDate) return hm;
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${hm}`;
}

function fmtDur(min) {
  if (min == null) return '—';
  if (min < 60) return `${Math.round(min)} 分钟`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

const LEVEL = {
  critical: { cls: 'tag-red', text: '严重', dot: 'red' },
  warning: { cls: 'tag-amber', text: '告警', dot: 'amber' },
  minor: { cls: 'tag-amber', text: '轻度', dot: 'amber' },
  unknown: { cls: 'tag-gray', text: '待人工', dot: 'gray' },
  ok: { cls: 'tag-green', text: '合格', dot: 'green' },
};

const PARTY_CLS = {
  PENDING: 'tag-cyan',
  SHIP: 'tag-amber',
  CARR: 'tag-red',
  CONS: 'tag-cyan',
  EQUIP: 'tag-gray',
  NONE: 'tag-green',
  UNKNOWN: 'tag-gray',
};

const EVENT_LABEL = {
  load_start: '开始装车',
  depart: '装车完成出发',
  door_open: '厢门开启',
  unit_stop: '制冷机组停机',
  arrive: '到达目的地',
  unload_end: '卸货完成',
  reject: '拒收',
};

const EVENT_WARN = new Set(['door_open', 'unit_stop', 'reject']);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ---------- 顶栏 ----------

function topbar(active) {
  const items = [
    ['/', '质控看板'],
    ['/track', '客户问询'],
    ['/rules', '判定规则'],
  ];
  return `
  <div class="topbar">
    <div class="topbar-inner">
      <div class="brand">
        <div class="brand-mark">冷</div>
        <span>冷鲜通 <small>在途温控与责任判定</small></span>
      </div>
      <nav class="nav">
        ${items.map(([href, label]) =>
          `<a href="#${href}" class="${active === href ? 'on' : ''}">${label}</a>`
        ).join('')}
      </nav>
    </div>
  </div>`;
}

// ---------- 温度曲线（手写 SVG） ----------

function tempChart(detail, opts = {}) {
  const { readings, waybill, excursions } = detail;
  const W = opts.width || 720;
  const H = opts.height || 230;
  const PAD = { l: 46, r: 14, t: 14, b: 30 };
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;

  if (!readings.length) return `<div class="empty">无温度读数</div>`;

  const ts0 = readings[0].ts;
  const ts1 = readings[readings.length - 1].ts;
  const span = Math.max(1, ts1 - ts0);

  // 值域：含温区上下限，留 8% 余量
  const temps = readings.map((r) => r.temp);
  let lo = Math.min(...temps, waybill.zoneMin);
  let hi = Math.max(...temps, waybill.zoneMax);
  const marg = Math.max(1, (hi - lo) * 0.18);
  lo -= marg; hi += marg;

  const x = (ts) => PAD.l + ((ts - ts0) / span) * iw;
  const y = (t) => PAD.t + ih - ((t - lo) / (hi - lo)) * ih;

  // 温区带
  const bandTop = y(waybill.zoneMax);
  const bandBot = y(waybill.zoneMin);

  // 曲线路径
  const path = readings
    .map((r, i) => `${i === 0 ? 'M' : 'L'}${x(r.ts).toFixed(1)},${y(r.temp).toFixed(1)}`)
    .join(' ');

  // Y 轴刻度（5 档）
  const ticks = [];
  for (let i = 0; i <= 4; i++) {
    const t = lo + ((hi - lo) * i) / 4;
    ticks.push({ t, yy: y(t) });
  }

  // X 轴刻度（4 档）
  const xticks = [];
  for (let i = 0; i <= 3; i++) {
    const ts = ts0 + (span * i) / 3;
    xticks.push({ ts, xx: x(ts) });
  }

  // 超温区间高亮
  const exRect = excursions
    .map((e) => {
      const x0 = x(e.from);
      const x1 = x(e.to);
      return `<rect x="${x0.toFixed(1)}" y="${PAD.t}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${ih}"
        fill="rgba(196,54,31,.08)" />`;
    })
    .join('');

  // 峰值标记
  let peakMark = '';
  if (excursions.length) {
    const worst = excursions.reduce((a, b) =>
      Math.abs(b.peak - (waybill.zoneMin + waybill.zoneMax) / 2) >
      Math.abs(a.peak - (waybill.zoneMin + waybill.zoneMax) / 2) ? b : a
    );
    const px = x(worst.peakAt);
    const py = y(worst.peak);
    peakMark = `
      <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.5" fill="#c4361f" stroke="#fff" stroke-width="1.5"/>
      <text x="${px.toFixed(1)}" y="${(py - 9).toFixed(1)}" font-size="10.5" fill="#c4361f"
        text-anchor="middle" font-weight="600">${worst.peak.toFixed(1)}℃</text>`;
  }

  return `
  <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="display:block" role="img"
       aria-label="运单 ${esc(waybill.no)} 温度曲线，温区 ${waybill.zoneMin} 到 ${waybill.zoneMax} 摄氏度">
    <defs>
      <clipPath id="chartclip"><rect x="${PAD.l}" y="${PAD.t}" width="${iw}" height="${ih}"/></clipPath>
    </defs>

    <!-- 温区带 -->
    <rect x="${PAD.l}" y="${bandTop.toFixed(1)}" width="${iw}" height="${Math.max(1, bandBot - bandTop).toFixed(1)}"
      fill="rgba(13,125,143,.07)"/>
    <line x1="${PAD.l}" x2="${PAD.l + iw}" y1="${bandTop.toFixed(1)}" y2="${bandTop.toFixed(1)}"
      stroke="#0d7d8f" stroke-width="1" stroke-dasharray="4 3" opacity=".55"/>
    <line x1="${PAD.l}" x2="${PAD.l + iw}" y1="${bandBot.toFixed(1)}" y2="${bandBot.toFixed(1)}"
      stroke="#0d7d8f" stroke-width="1" stroke-dasharray="4 3" opacity=".55"/>

    <!-- 超温高亮 -->
    ${exRect}

    <!-- 网格 -->
    ${ticks.map((t) => `
      <line x1="${PAD.l}" x2="${PAD.l + iw}" y1="${t.yy.toFixed(1)}" y2="${t.yy.toFixed(1)}"
        stroke="#eef3f6" stroke-width="1"/>
      <text x="${PAD.l - 8}" y="${(t.yy + 3.5).toFixed(1)}" font-size="10.5" fill="#6b7f8f"
        text-anchor="end">${t.t.toFixed(0)}</text>`).join('')}

    <!-- X 轴标签 -->
    ${xticks.map((t) => `
      <text x="${t.xx.toFixed(1)}" y="${H - 8}" font-size="10.5" fill="#6b7f8f"
        text-anchor="middle">${fmtTime(t.ts, false)}</text>`).join('')}

    <!-- 曲线 -->
    <g clip-path="url(#chartclip)">
      <path d="${path}" fill="none" stroke="#0d7d8f" stroke-width="1.8"
        stroke-linejoin="round" stroke-linecap="round"/>
    </g>
    ${peakMark}

    <!-- 温区标注 -->
    <text x="${PAD.l + iw - 4}" y="${(bandTop - 5).toFixed(1)}" font-size="10" fill="#0d7d8f"
      text-anchor="end" opacity=".8">上限 ${waybill.zoneMax}℃</text>
    <text x="${PAD.l + iw - 4}" y="${(bandBot + 12).toFixed(1)}" font-size="10" fill="#0d7d8f"
      text-anchor="end" opacity=".8">下限 ${waybill.zoneMin}℃</text>
  </svg>`;
}

// ---------- 看板页 ----------

async function renderDashboard() {
  const app = $('#app');
  app.innerHTML = topbar('/') + `<div class="page"><div class="empty">加载中…</div></div>`;

  const data = await fetch('/api/dashboard').then((r) => r.json());
  state.dashboard = data;
  const { stats, rows } = data;

  const statCard = (k, v, cls = '', sub = '') => `
    <div class="stat">
      <div class="stat-k">${k}</div>
      <div class="stat-v ${cls}">${v}</div>
      ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
    </div>`;

  const partyText = Object.entries(stats.byParty)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ') || '—';

  app.innerHTML = topbar('/') + `
  <div class="page">
    <div class="page-head">
      <h1>质控看板</h1>
      <p>按告警严重度排序。点击任一运单查看温度曲线、事件时间轴与责任判定证据链。</p>
    </div>

    <div class="stat-row">
      ${statCard('在途运单', stats.transit, 'cyan', `共 ${stats.total} 票`)}
      ${statCard('严重告警', stats.critical, 'red', '超温 ≥120 分钟或 ≥5℃')}
      ${statCard('一般告警', stats.warning, 'amber', '超温 ≥30 分钟或 ≥2℃')}
      ${statCard('待人工介入', stats.needManual, '', '证据不足，需补证')}
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>运单告警总览</h2>
        <span class="hint">责任分布：${esc(partyText)}</span>
      </div>

      <table class="desk">
        <thead>
          <tr>
            <th>严重度</th>
            <th>运单号</th>
            <th>客户 / 货物</th>
            <th>温区</th>
            <th>最新温度</th>
            <th>超温</th>
            <th>判定责任</th>
            <th>规则</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => {
            const lv = LEVEL[r.level];
            const pcls = PARTY_CLS[r.party] || 'tag-gray';
            const overTemp = r.latestTemp != null &&
              (r.latestTemp > r.zoneMax || r.latestTemp < r.zoneMin);
            return `
            <tr data-no="${esc(r.no)}">
              <td><span class="tag ${lv.cls}"><span class="dot ${r.level === 'critical' ? 'pulse' : ''}"></span>${lv.text}</span></td>
              <td class="mono">${esc(r.no)}</td>
              <td>
                <div>${esc(r.customer)}</div>
                <div style="font-size:12px;color:var(--ink-3)">${esc(r.cargo)}</div>
              </td>
              <td style="white-space:nowrap">${esc(r.zoneLabel)} <span style="color:var(--ink-3);font-size:12px">${r.zoneMin}~${r.zoneMax}℃</span></td>
              <td class="num" style="font-weight:600;${overTemp ? 'color:var(--red)' : ''}">
                ${r.latestTemp != null ? r.latestTemp.toFixed(1) + '℃' : '—'}
                ${r.status === 'transit' ? '<span class="tag tag-cyan" style="margin-left:6px">在途</span>' : ''}
              </td>
              <td class="num">${r.excursionCount ? `${r.excursionCount} 段<br><span style="font-size:12px;color:var(--ink-3)">${fmtDur(r.excursionMinutes)}</span>` : '<span style="color:var(--ink-3)">无</span>'}</td>
              <td><span class="tag ${pcls}">${esc(r.partyName)}</span></td>
              <td class="mono" style="color:var(--ink-3)">${esc(r.ruleId)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>

      <div class="waybill-cards">
        ${rows.map((r) => {
          const lv = LEVEL[r.level];
          return `
          <div class="wb-card" data-no="${esc(r.no)}">
            <div class="wb-card-top">
              <div>
                <div class="wb-card-no">${esc(r.no)}</div>
                <div class="wb-card-title">${esc(r.customer)} · ${esc(r.cargo)}</div>
              </div>
              <span class="tag ${lv.cls}"><span class="dot"></span>${lv.text}</span>
            </div>
            <div class="wb-card-row"><span>最新温度</span><strong>${r.latestTemp != null ? r.latestTemp.toFixed(1) + '℃' : '—'}</strong></div>
            <div class="wb-card-row"><span>超温</span><span>${r.excursionCount} 段 / ${fmtDur(r.excursionMinutes)}</span></div>
            <div class="wb-card-row"><span>判定责任</span><strong>${esc(r.partyName)}</strong></div>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>
  <footer class="foot">
    <span>数据来源：教学虚构 · 物理模型生成</span>
    <span>判定规则 v1.0 · 共 10 条</span>
    <span>API：<code>/api/dashboard</code></span>
  </footer>`;

  app.querySelectorAll('[data-no]').forEach((el) => {
    el.addEventListener('click', () => { location.hash = `#/waybill/${el.dataset.no}`; });
  });
}

// ---------- 详情页 ----------

async function renderDetail(no) {
  const app = $('#app');
  app.innerHTML = topbar('/') + `<div class="page"><div class="empty">加载中…</div></div>`;

  const res = await fetch(`/api/waybills/${encodeURIComponent(no)}`);
  if (!res.ok) {
    app.innerHTML = topbar('/') + `<div class="page"><div class="empty">运单 ${esc(no)} 不存在</div></div>`;
    return;
  }
  const d = await res.json();
  state.detail = d;
  const { waybill: w, verdict: v, excursions, events, stats, level } = d;

  const lv = LEVEL[level];
  const vCls = level === 'critical' ? 'red' : level === 'warning' || level === 'minor' ? 'amber'
    : level === 'ok' ? 'green' : 'gray';

  // 事件轴
  const axis = events.length
    ? events.map((e) => {
        const warn = EVENT_WARN.has(e.type);
        const dur = e.durationMin ? `（持续 ${fmtDur(e.durationMin)}）` : '';
        return `
        <div class="axis-item">
          <div class="axis-time">${fmtTime(e.at, false)}</div>
          <div class="axis-rail"><div class="axis-dot ${warn ? 'warn' : ''}"></div></div>
          <div class="axis-body">
            <div class="axis-title">${esc(EVENT_LABEL[e.type] || e.type)}${dur}</div>
            <div class="axis-note">${esc(e.note || '')}${e.actor ? ' · ' + esc(e.actor) : ''}</div>
          </div>
        </div>`;
      }).join('')
    : `<div class="empty" style="padding:30px 0">无事件记录</div>`;

  app.innerHTML = topbar('/') + `
  <div class="page">
    <div class="page-head">
      <h1>运单 ${esc(w.no)}</h1>
      <p>${esc(w.customer)} · ${esc(w.cargo)} · ${esc(w.origin)} → ${esc(w.dest)}</p>
    </div>

    <div class="meta-grid panel" style="margin-bottom:18px">
      <div class="meta-cell"><div class="meta-k">温区要求</div><div class="meta-v">${esc(w.zoneLabel)} ${w.zoneMin}~${w.zoneMax}℃</div></div>
      <div class="meta-cell"><div class="meta-k">车牌 / 司机</div><div class="meta-v">${esc(w.plate)} · ${esc(w.driver)}</div></div>
      <div class="meta-cell"><div class="meta-k">设备编号</div><div class="meta-v mono">${esc(w.deviceId)}</div></div>
      <div class="meta-cell"><div class="meta-k">温度读数</div><div class="meta-v">${stats.count} 条（覆盖率 ${(d.coverage * 100).toFixed(0)}%）</div></div>
      <div class="meta-cell"><div class="meta-k">温度范围</div><div class="meta-v">${stats.min.toFixed(1)} ~ ${stats.max.toFixed(1)}℃</div></div>
      <div class="meta-cell"><div class="meta-k">状态</div><div class="meta-v">${w.status === 'transit' ? '在途' : '已交付'}</div></div>
    </div>

    <div class="detail-grid">
      <div>
        <div class="panel" style="margin-bottom:18px">
          <div class="panel-head">
            <h2>温度曲线</h2>
            <span class="hint">青色带为温区范围，红色底色为超温区间</span>
          </div>
          <div class="chart-wrap">${tempChart(d)}</div>
          <div class="chart-legend">
            <span class="legend-item"><span class="legend-line" style="background:#0d7d8f"></span>厢温</span>
            <span class="legend-item"><span class="legend-band" style="background:rgba(13,125,143,.18)"></span>合格温区</span>
            <span class="legend-item"><span class="legend-band" style="background:rgba(196,54,31,.18)"></span>超温区间</span>
          </div>
        </div>

        ${excursions.length ? `
        <div class="panel" style="margin-bottom:18px">
          <div class="panel-head"><h2>超温区间明细</h2></div>
          <table>
            <thead><tr><th>起</th><th>止</th><th>持续</th><th>峰值</th><th>方向</th></tr></thead>
            <tbody>
              ${excursions.map((e) => `
                <tr style="cursor:default">
                  <td class="mono">${fmtTime(e.from)}</td>
                  <td class="mono">${fmtTime(e.to)}</td>
                  <td class="num">${fmtDur(e.minutes)}</td>
                  <td class="num" style="color:var(--red);font-weight:600">${e.peak.toFixed(1)}℃</td>
                  <td>${e.direction === 'high' ? '超上限' : '低于下限'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}

        <div class="panel">
          <div class="panel-head">
            <h2>事件时间轴</h2>
            <span class="hint">判定规则据此定位"哪一段、哪个动作"</span>
          </div>
          <div class="axis">${axis}</div>
        </div>
      </div>

      <div>
        <div class="verdict ${vCls}">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <span class="tag ${lv.cls}"><span class="dot"></span>${lv.text}</span>
            <span class="tag tag-outline mono">${esc(v.ruleId)}</span>
          </div>
          <div class="verdict-party">${esc(v.partyName)}</div>
          <div class="verdict-rule">${esc(v.ruleName)} · 规则版本 ${esc(v.ruleVersion)}</div>
          <div class="verdict-detail">${esc(v.detail)}</div>

          <div class="verdict-conf">
            <span>置信度</span>
            <span class="conf-bar"><span class="conf-fill" style="width:${(v.confidence * 100).toFixed(0)}%"></span></span>
            <span class="num" style="font-weight:600;color:var(--ink-2)">${(v.confidence * 100).toFixed(0)}%</span>
          </div>

          <div class="evidence">
            <h3>证据链</h3>
            ${v.evidence.map((e) => `
              <div class="ev-row"><span class="ev-k">${esc(e.label)}</span><span class="ev-v">${esc(e.value)}</span></div>
            `).join('')}
          </div>

          ${v.needManual ? `
          <div style="margin-top:14px;padding:11px 13px;background:var(--amber-bg);border-radius:7px;font-size:12.5px;color:var(--amber)">
            本票需人工介入：现有证据不足以支撑责任认定，请按上方「缺失项」补充证据后复判。
          </div>` : ''}
        </div>

        <div class="panel" style="margin-top:18px">
          <div class="panel-head"><h2>判定依据</h2></div>
          <div style="padding:14px 18px;font-size:13px;color:var(--ink-2);line-height:1.7">${esc(v.why)}</div>
          <div style="padding:0 18px 16px">
            <a href="#/rules" style="font-size:12.5px;color:var(--cyan);text-decoration:none">查看完整规则集 →</a>
          </div>
        </div>

        <div class="panel" style="margin-top:18px">
          <div class="panel-head"><h2>对外口径</h2></div>
          <div style="padding:14px 18px;font-size:13px;color:var(--ink-2);line-height:1.7">
            客户问询页展示与本页<strong>同一接口、同一算法</strong>的结论，仅隐藏司机姓名与设备编号。
            <a href="#/track" style="color:var(--cyan);text-decoration:none">打开客户问询 →</a>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

// ---------- 客户问询页 ----------

function renderTrack(prefill) {
  const app = $('#app');
  app.innerHTML = topbar('/track') + `
  <div class="page">
    <div class="track-box">
      <h1>运单温度查询</h1>
      <p>输入运单号，查看该票货物的全程温度记录与责任判定结论。</p>
      <div class="track-input-row">
        <input type="text" id="track-input" placeholder="例：LT20261118003" value="${esc(prefill || '')}"
               autocomplete="off" spellcheck="false">
        <button class="btn" id="track-btn">查询</button>
      </div>
      <div class="examples">
        示例运单：
        <code data-q="LT20261118001">001 合格</code>
        <code data-q="LT20261118002">002 发货方</code>
        <code data-q="LT20261118003">003 预冷不足</code>
        <code data-q="LT20261118005">005 收货方</code>
        <code data-q="LT20261118006">006 机组故障</code>
        <code data-q="LT20261118010">010 证据不足</code>
      </div>
      <div id="track-result"></div>
    </div>
  </div>`;

  const input = $('#track-input');
  const btn = $('#track-btn');
  const result = $('#track-result');

  const doQuery = async () => {
    const no = input.value.trim();
    if (!no) return;
    result.innerHTML = `<div class="empty" style="padding:30px 0">查询中…</div>`;
    const res = await fetch(`/api/track/${encodeURIComponent(no)}`);
    if (!res.ok) {
      result.innerHTML = `<div class="err">未查询到运单 ${esc(no)}，请核对单号。</div>`;
      return;
    }
    const d = await res.json();
    const c = d.conclusion;
    const lvCls = c.partyName === '无责任方' ? 'tag-green'
      : c.partyName === '无法判定' ? 'tag-gray'
      : c.partyName === '承运方' ? 'tag-red' : 'tag-amber';

    result.innerHTML = `
      <div class="conclusion-block">
        <div class="label">责任判定结论</div>
        <div class="main">
          <span class="tag ${lvCls}">${esc(c.partyName)}</span>
          <span style="margin-left:8px">${esc(c.ruleName)}</span>
        </div>
        <div class="desc">${esc(c.detail)}</div>
      </div>

      <div style="margin-top:20px">
        <div style="font-size:12px;color:var(--ink-3);letter-spacing:.04em;margin-bottom:8px">全程温度记录</div>
        ${tempChart({ readings: d.series.map(([ts, temp, probe]) => ({ ts, temp, probe })), waybill: d, excursions: d.excursions }, { width: 560, height: 200 })}
      </div>

      <div style="margin-top:18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:12px">
        <div><div style="font-size:11.5px;color:var(--ink-3)">温区要求</div>
          <div style="font-weight:600;font-size:13.5px">${esc(d.zoneLabel)} ${d.zoneMin}~${d.zoneMax}℃</div></div>
        <div><div style="font-size:11.5px;color:var(--ink-3)">温度范围</div>
          <div style="font-weight:600;font-size:13.5px">${d.stats.min}~${d.stats.max}℃</div></div>
        <div><div style="font-size:11.5px;color:var(--ink-3)">超温累计</div>
          <div style="font-weight:600;font-size:13.5px">${d.stats.excursionMinutes} 分钟</div></div>
        <div><div style="font-size:11.5px;color:var(--ink-3)">运输区间</div>
          <div style="font-weight:600;font-size:13.5px">${esc(d.origin)} → ${esc(d.dest)}</div></div>
      </div>

      <div style="margin-top:20px">
        <div style="font-size:12px;color:var(--ink-3);letter-spacing:.04em;margin-bottom:8px">判定证据</div>
        ${c.evidence.map((e) => `
          <div class="ev-row"><span class="ev-k">${esc(e.label)}</span><span class="ev-v">${esc(e.value)}</span></div>
        `).join('')}
      </div>

      <div style="margin-top:18px;font-size:12px;color:var(--ink-3);line-height:1.7">
        本结论与质控内部系统同源同值（同一接口、同一算法），判定规则编号 ${esc(c.ruleId)}。
        结论为技术判定意见，赔付须经双方商务确认。
      </div>`;
  };

  btn.addEventListener('click', doQuery);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doQuery(); });
  app.querySelectorAll('[data-q]').forEach((el) => {
    el.addEventListener('click', () => { input.value = el.dataset.q; doQuery(); });
  });

  if (prefill) doQuery();
}

// ---------- 规则页 ----------

async function renderRules() {
  const app = $('#app');
  app.innerHTML = topbar('/rules') + `<div class="page"><div class="empty">加载中…</div></div>`;
  const data = await fetch('/api/rules').then((r) => r.json());

  app.innerHTML = topbar('/rules') + `
  <div class="page">
    <div class="page-head">
      <h1>责任判定规则集</h1>
      <p>共 ${data.rules.length} 条规则，按优先级短路求值，首个命中即返回。规则版本 ${esc(data.version)}。</p>
    </div>

    <div class="panel">
      <table>
        <thead>
          <tr><th>优先级</th><th>编号</th><th>规则名</th><th>责任主体</th><th>业务含义</th></tr>
        </thead>
        <tbody>
          ${data.rules.map((r) => `
            <tr style="cursor:default">
              <td class="num" style="color:var(--ink-3)">${r.priority}</td>
              <td class="mono" style="font-weight:600">${esc(r.id)}</td>
              <td style="font-weight:560">${esc(r.name)}</td>
              <td><span class="tag ${PARTY_CLS[r.party] || 'tag-gray'}">${esc(r.partyName)}</span></td>
              <td style="color:var(--ink-2);font-size:13px">${esc(r.why)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="panel" style="margin-top:18px">
      <div class="panel-head"><h2>执行顺序说明</h2></div>
      <div style="padding:16px 18px;font-size:13.5px;color:var(--ink-2);line-height:1.8">
        <p><strong>为何 R01 最高：</strong>装车完成即超标，后续运输环节的争论已无意义。</p>
        <p style="margin-top:8px"><strong>为何 R06 次高：</strong>数据本身不可信时，任何基于数据的判定都不成立，必须先解决数据问题。</p>
        <p style="margin-top:8px"><strong>为何 R10 兜底而非默认归责：</strong>默认把责任推给承运方是最常见的产品设计错误，会让客户失去信任。诚实地说"判不了"并列出缺失证据，比硬给错结论更有价值。</p>
        <p style="margin-top:8px"><strong>为何 R08/R09 必要：</strong>证明无责与证明有责同等重要。若系统只会报警不会免责，承运方不会认这套系统。</p>
      </div>
    </div>
  </div>`;
}

// ---------- 路由 ----------

function route() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  const hash = location.hash.replace(/^#/, '') || '/';
  const mWb = hash.match(/^\/waybill\/(.+)$/);
  if (mWb) return renderDetail(decodeURIComponent(mWb[1]));
  if (hash === '/track') return renderTrack();
  if (hash === '/rules') return renderRules();
  return renderDashboard();
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);
if (document.readyState !== 'loading') route();
