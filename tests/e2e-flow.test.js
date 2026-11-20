'use strict';

/**
 * E2E 测试：真实浏览器（Chrome headless）+ 真实 HTTP 服务
 *
 * 验证的不是"接口能返回"，而是"用户能不能走完业务流程"：
 *   ① 打开看板 → 看到告警排序
 *   ② 点进运单 → 看到温度曲线与证据链
 *   ③ 客户问询页 → 输单号 → 拿到结论
 *   ④ 内外一致性 → 客户页结论与内部页结论同值
 *
 * 实现方式：无头 Chrome --dump-dom 获取渲染后 DOM，再做断言。
 * 若环境无 Chrome，则跳过并明确标记（不伪装成通过）。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const TMP_DB = path.join(os.tmpdir(), `freshchain-e2e-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;

const store = require('../src/store');
const { seed } = require('../scripts/seed');
const { server } = require('../src/server');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasChrome = fs.existsSync(CHROME);

let baseUrl;

/**
 * 用无头 Chrome 渲染页面并取回 DOM。
 *
 * 注意：Chrome 打印完 DOM 后进程并不会立即退出（headless 下仍驻留），
 * 直接用 execFileSync 会永久挂起。所以这里改为 spawn +
 * 「等到出现 </html> 就收工、用完即杀」，并设硬超时兜底。
 */
function renderDom(url, budget = 2500) {
  return new Promise((resolve) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-e2e-profile-'));
    const child = spawn(
      CHROME,
      [
        '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
        '--disable-extensions', '--disable-dev-shm-usage',
        '--mute-audio', '--hide-scrollbars',
        `--user-data-dir=${profile}`,
        '--dump-dom', `--virtual-time-budget=${budget}`,
        '--window-size=1400,1400',
        url,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );

    let out = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(hardStop);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
      resolve(out);
    };

    child.stdout.on('data', (b) => {
      out += b.toString('utf8');
      if (out.includes('</html>')) finish();
    });
    child.on('close', finish);
    child.on('error', finish);

    // 轮询兜底：某些 Chrome 版本不主动 flush，靠 close 事件也不够快
    const timer = setInterval(() => {
      if (out.includes('</html>')) finish();
    }, 100);
    // 硬超时：单页超过 20s 视为失败，返回已收到的部分
    const hardStop = setTimeout(finish, 20000);
  });
}

test.before(async () => {
  store.open();
  seed();
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
});

test('E2E-1 质控看板：12 票运单全部渲染，告警排序正确', { skip: !hasChrome && '未找到 Chrome' }, async () => {
  const dom = await renderDom(`${baseUrl}/`);
  assert.ok(dom.length > 5000, 'DOM 应有实际内容');
  const nos = [...dom.matchAll(/data-no="(LT\d+)"/g)].map((m) => m[1]);
  const uniq = [...new Set(nos)];
  assert.equal(uniq.length, 12, `应渲染 12 票运单，实际 ${uniq.length}`);
  assert.ok(dom.includes('严重'), '应显示严重告警标记');
  assert.ok(dom.includes('质控看板'), '应显示页面标题');
});

test('E2E-2 运单详情：温度曲线 SVG 与证据链完整渲染', { skip: !hasChrome && '未找到 Chrome' }, async () => {
  const dom = await renderDom(`${baseUrl}/#/waybill/LT20261118003`);
  assert.ok(dom.includes('<svg'), '应渲染 SVG 温度曲线');
  // 曲线路径应有足够多的点
  const paths = [...dom.matchAll(/<path d="(M[^"]+)"/g)].map((m) => m[1]);
  assert.ok(paths.length >= 1, '应至少有 1 条曲线路径');
  assert.ok(paths[0].split('L').length > 50, `曲线应有足够数据点，实际 ${paths[0].split('L').length}`);
  // 判定结论与证据
  assert.ok(dom.includes('预冷不足'), '应显示判定规则名');
  assert.ok(dom.includes('发货方'), '应显示责任主体');
  assert.ok(dom.includes('证据链'), '应显示证据链标题');
  assert.ok(dom.includes('事件时间轴'), '应显示事件时间轴');
  assert.ok(dom.includes('出发温度'), '证据项应可读');
});

test('E2E-3 客户问询页：输入运单号可拿到结论', { skip: !hasChrome && '未找到 Chrome' }, async () => {
  // 前端通过 fetch 查询，无头 dump-dom 拿不到异步结果；
  // 故此处验证：① 问询页可渲染 ② 底层接口与前端调用路径一致
  const dom = await renderDom(`${baseUrl}/#/track`);
  assert.ok(dom.includes('运单温度查询'), '应渲染客户问询页');
  assert.ok(dom.includes('track-input'), '应有输入框');

  const api = await new Promise((resolve, reject) => {
    http.get(`${baseUrl}/api/track/LT20261118005`, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b) }));
    }).on('error', reject);
  });
  assert.equal(api.status, 200);
  assert.equal(api.json.conclusion.partyName, '收货方');
  assert.ok(api.json.series.length > 50, '问询页应能拿到完整曲线');
});

test('E2E-4 端到端一致性：客户页结论 = 内部判定结论', { skip: !hasChrome && '未找到 Chrome' }, async () => {
  const targets = ['LT20261118002', 'LT20261118004', 'LT20261118006', 'LT20261118009'];
  for (const no of targets) {
    const a = await new Promise((r) => http.get(`${baseUrl}/api/waybills/${no}/judgement`, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => r(JSON.parse(b)));
    }));
    const b = await new Promise((r) => http.get(`${baseUrl}/api/track/${no}`, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => r(JSON.parse(s)));
    }));
    assert.equal(b.conclusion.ruleId, a.ruleId, `${no} 规则编号内外不一致`);
    assert.equal(b.conclusion.partyName, a.partyName, `${no} 责任主体内外不一致`);
    assert.equal(b.conclusion.detail, a.detail, `${no} 判定说明内外不一致`);
  }
});

test('E2E-5 规则页：10 条规则全部展示', { skip: !hasChrome && '未找到 Chrome' }, async () => {
  const dom = await renderDom(`${baseUrl}/#/rules`);
  for (const id of ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R10']) {
    assert.ok(dom.includes(id), `规则页应展示 ${id}`);
  }
  assert.ok(dom.includes('执行顺序说明'), '应解释短路顺序');
});

test('E2E-6 业务完整性：三种客户角色都能走到结论', { skip: !hasChrome && '未找到 Chrome' }, async () => {
  // 质控（内部视图）
  const qc = await new Promise((r) => http.get(`${baseUrl}/api/dashboard`, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => r(JSON.parse(b)));
  }));
  assert.equal(qc.rows.length, 12);

  // 客服（对外视图）
  const cs = await new Promise((r) => http.get(`${baseUrl}/api/track/LT20261118001`, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => r(JSON.parse(b)));
  }));
  assert.equal(cs.conclusion.partyName, '无责任方');

  // 客户自助（脱敏校验）
  assert.ok(!JSON.stringify(cs).includes('司机'), '对外视图不应出现司机字段名');
});
