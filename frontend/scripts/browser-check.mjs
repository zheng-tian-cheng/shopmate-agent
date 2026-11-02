// 浏览器回归：真实前端、HTTP、Python工具；模型用 tests/browser_app.py 的明确测试替身。
// 用法：先 `npm run build && npm run start`，再在另一个终端运行 `npm run check:browser`。
// 环境变量：BASE_URL（默认 http://127.0.0.1:3000）、CHROME_PATH（默认 macOS 的 Chrome 路径）、
// SCREENSHOT_DIR（可选，设置后保存截图）。聊天使用测试替身模型，不代表真实 Gemini 的理解能力。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.env.SCREENSHOT_DIR;
const PORT = 9300 + Math.floor(Math.random() * 500);
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  await fetch(BASE);
  const mode = await fetch(BASE + '/api/test-mode').then(r => r.json());
  if (mode.model !== 'fixture') throw new Error('浏览器回归必须连接 tests.browser_app，避免消耗真实 Gemini 额度');
} catch {
  console.error(`无法访问测试服务 ${BASE}；请按 README 启动 tests.browser_app 和对应前端。`);
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'shopmate-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

const problems = [];
let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};

try {
  let targets = [];
  for (let i = 0; i < 40 && !targets.length; i++) {
    try { targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page'); } catch { /* Chrome 尚未就绪 */ }
    if (!targets.length) await sleep(250);
  }
  if (!targets.length) throw new Error('Chrome 没有启动，请检查 CHROME_PATH');

  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') problems.push(`exception: ${m.params.exceptionDetails.exception?.description}`);
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      problems.push(`console.${m.params.type}: ${m.params.args.map(a => a.value ?? a.description).join(' ')}`);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    waiting.set(i, m => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const HELPERS = `
    const $ = s => document.querySelector(s);
    const lastRec = () => [...document.querySelectorAll('.rec-list')].at(-1);
    const byText = (sel, t) => { const el = [...document.querySelectorAll(sel)].find(e => e.textContent.trim().includes(t)); if (!el) throw new Error('找不到：' + t); return el; };
    const setValue = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  `;
  const run = async code => {
    const r = await send('Runtime.evaluate', { expression: `(() => { ${HELPERS} ${code} })()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  // 等到页面达到预期状态（最多 timeout 毫秒）：商品数据由 FastAPI 提供，页面先显示加载状态再出结果
  const waitFor = async (code, timeout = 8000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { if (await run(code)) return true; } catch {}
      await sleep(150);
    }
    return false;
  };
  const LOADED = `return document.readyState === 'complete' && !document.querySelector('.request-state[role=status]') && !!document.querySelector('.mall-main')`;
  const go = async path => { await send('Page.navigate', { url: BASE + path }); await sleep(600); await waitFor(LOADED); await sleep(300); };
  const shot = async name => {
    if (!SHOTS) return;
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const sendText = async text => {
    await run(`setValue($('#assistant-input'), ${JSON.stringify(text)});`);
    await sleep(80);
    await run(`$('.composer button[type=submit]').click();`);
    await sleep(1000);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // 桌面：列表 → 助手 → 确认建议 → 对比 → 排除入耳式 → 应用到列表
  await go('/headphones');
  check('商品列表展示 15 款真实商品，保留列表的型号不出现', await run(`return document.querySelectorAll('.product-card').length === 15 && !document.body.innerText.includes('WF-1000XM')`));
  check('列表卡片只有图片、名称、单一价格和 1–2 个核心信息，没有审核说明；示意图用页面级说明', await run(`const cards = [...document.querySelectorAll('.product-card')]; return cards.every(c => c.querySelectorAll('.price').length === 1 && !c.querySelector('.product-evidence, .demo-badge') && !/参考价|非实时|资料提醒|未知/.test(c.textContent)) && $('.page-title').textContent.includes('部分商品图片为演示示意')`));
  // 图片懒加载：先滚到底部触发加载，再回到顶部
  await run(`window.scrollTo(0, document.body.scrollHeight)`);
  await sleep(1200);
  await run(`window.scrollTo(0, 0)`);
  check('14 款商品各用一张不同的示意图，1 款占位图；图片都已加载', await run(`const imgs = [...document.querySelectorAll('.product-card .product-photo img')]; return imgs.length === 14 && new Set(imgs.map(i => i.getAttribute('src'))).size === 14 && imgs.every(i => i.complete && i.naturalWidth > 0) && document.querySelectorAll('.product-card .product-placeholder').length === 1`));
  // 预算上限：边界价格算满足，只显示有价格且不超预算的商品
  for (const [budget, count] of [[200, 4], [300, 9], [400, 11], [500, 13], [600, 14]]) {
    await run(`$('.list-filters').open = true; setValue($('.filter-panel input[type=number]'), '${budget}');`);
    await sleep(80);
    await run(`byText('.filter-panel button', '筛选').click();`);
    await sleep(300);
    check(`列表筛选 ${budget} 元以内显示 ${count} 款，且都不超预算`, await run(`const prices = [...document.querySelectorAll('.product-card .price')].map(e => Number(e.textContent.replace(/[^0-9.]/g, ''))); return $('.result-bar span').textContent === '${count} 款符合筛选' && prices.length === ${count} && prices.every(p => p > 0 && p <= ${budget})`));
  }
  check('列表中没有虚构商品', await run(`return !document.body.textContent.includes('候选') && !document.body.textContent.includes('示意图 · 非真实商品')`));
  await shot('01-list');

  await run(`$('.launcher').click()`);
  await sleep(400);
  check('初次打开不展示推荐商品', await run(`return !$('.rec-item')`));
  check('从列表打开助手，继承预算并标记“来自商品列表”', await run(`const t = $('.condition-tags button'); return t.textContent.includes('预算 ≤ ¥600') && t.title === '来自商品列表'`));

  await sendText('我每天坐地铁通勤');
  await run(`$('.condition-toggle').click()`);
  await sleep(100);
  check('“地铁通勤”推导出的降噪显示为“系统建议 · 未生效”', await run(`const c = $('.status-card.suggested'); return !!c && c.textContent.includes('必须支持主动降噪')`));
  check('只说了使用场景、建议还未生效时，不重复给出推荐', await run(`return !$('.rec-item')`));
  await shot('02-suggestion');

  await run(`byText('.status-card.suggested button', '设为必须').click()`);
  await sleep(300);
  check('用户点击“设为必须”后才生效，结果变为 11 款（不支持或未知降噪的商品被排除）', await run(`return lastRec().dataset.matchCount === '11' && !lastRec().textContent.includes('WF-C510') && !lastRec().textContent.includes('FreeBuds SE 3')`));

  await run(`const b = [...lastRec().querySelectorAll('.rec-compare')]; b[0].click(); b[2].click();`);
  await sleep(300);
  check('助手内出现两款对比表', await run(`return !!$('.assistant .compare-table')`));
  check('助手面板没有横向溢出', await run(`const b = $('.assistant-body'); return b.scrollWidth <= b.clientWidth + 1`));

  const beforeHistory = await run(`return [...document.querySelectorAll('.message')].map(e => e.textContent)`);
  await run(`$('.assistant-body').scrollTop = 0`);
  await sleep(150);
  await sendText('不要入耳式，其他不变');
  check('修改条件后历史消息完整保留且没有折叠', await run(`const texts = [...document.querySelectorAll('.message')].map(e => e.textContent); return ${JSON.stringify(beforeHistory)}.every((t, i) => texts[i] === t) && !$('.message details')`));
  check('阅读历史时不被新消息拉到底部', await run(`return $('.assistant-body').scrollTop < 5`));
  check('改条件后，之前一轮的推荐快照仍保留在对话中；佩戴方式未知的商品不算“不是入耳式”', await run(`const lists = document.querySelectorAll('.rec-list'); return lists.length === 2 && lists[0].querySelectorAll('.rec-item').length === 3 && lists[1].querySelectorAll('.rec-item').length === 2 && lists[1].dataset.matchCount === '2' && !lists[1].textContent.includes('Enco Air4')`));
  check('旧推荐中已不符合当前条件的商品被标记', await run(`return !!$('.rec-stale')`));
  check('助手回复不以“演示商品中有 N 款”为主要内容', await run(`return ![...document.querySelectorAll('.message')].some(e => /演示商品中有|款符合/.test(e.textContent))`));
  check('条件变更详情默认折叠，聊天正文不折叠', await run(`const logs = [...document.querySelectorAll('.change-log')]; return logs.length > 0 && logs.every(d => !d.open)`));
  check('排除入耳式后保留预算、降噪和场景', await run(`const t = [...document.querySelectorAll('.condition-tags button')].map(e => e.textContent).join('|'); return t.includes('入耳式') && t.includes('预算 ≤ ¥600') && t.includes('必须支持主动降噪') && t.includes('场景：地铁通勤')`));
  check('已不符合条件的商品在对比表中被标记', await run(`return !!$('.assistant .stale')`));
  check('多条消息后标题栏和输入区仍可见', await run(`const h = $('.assistant-head').getBoundingClientRect(), f = $('.assistant-foot').getBoundingClientRect(); return $('.assistant-head').contains(document.elementFromPoint(h.left + 60, h.top + h.height / 2)) && $('.assistant-foot').contains(document.elementFromPoint(f.left + 40, f.top + 20))`));
  await shot('03-exclude-in-ear');

  await run(`byText('.sync-action button', '应用到商品列表').click()`);
  await sleep(300);
  await run(`$('.assistant-back').click()`);
  await sleep(300);
  check('应用到列表：筛选变为 600 元 + 必须降噪 + 排除入耳式，显示 2 款', await run(`return $('.filter-panel input[type=number]').value === '600' && [...document.querySelectorAll('.filter-panel input[type=checkbox]')].every(c => c.checked) && $('.result-bar span').textContent === '2 款符合筛选'`));
  check('对比栏与悬浮入口不重叠', await run(`const a = $('.compare-tray').getBoundingClientRect(), b = $('.launcher').getBoundingClientRect(); return a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left`));
  await shot('04-applied');

  // 手机：四个主验收状态，截图均为实际页面，另检查滚动恢复。
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await go('/');
  await shot('mobile-01-home');
  check('首页商品与列表共用同一套图片映射，并有页面级示意图说明', await run(`return document.querySelectorAll('.home-product .product-photo.demo').length === 14 && $('.mall-disclaimer').textContent.includes('部分商品图片为演示示意')`));
  // 首页搜索：耳机进入耳机列表；未开放品类和模糊需求就地提示，不跳到耳机页面
  await run(`setValue($('#mall-search'), '沙发'); $('.browse-search button').click();`);
  await sleep(500);
  check('首页搜索“沙发”：提示家居沙发暂未开放，不跳到耳机列表', await run(`return location.pathname === '/' && $('.search-notice').textContent.includes('「家居沙发」暂未开放')`));
  await run(`setValue($('#mall-search'), '推荐一下'); $('.browse-search button').click();`);
  await sleep(500);
  check('首页搜索“推荐一下”：先问想找哪类商品，不默认当作耳机', await run(`return location.pathname === '/' && $('.search-notice').textContent.includes('想找哪一类商品')`));
  await run(`setValue($('#mall-search'), '降噪耳机'); $('.browse-search button').click();`);
  await waitFor(`return location.pathname === '/headphones' && !!$('.result-bar span') && $('.result-bar span').textContent.includes('款符合')`);
  check('首页搜索“降噪耳机”：进入耳机列表，只显示支持主动降噪的 12 款', await run(`return location.pathname === '/headphones' && $('.result-bar span').textContent.includes('12 款') && $('.search-understood').textContent.includes('主动降噪')`));
  await go('/headphones?q=%E5%92%96%E5%95%A1%E6%9C%BA');
  check('直接访问耳机列表搜索“咖啡机”：显示未开放提示，不列出耳机', await run(`return !!$('.search-unavailable') && !document.querySelector('.product-card')`));
  await go('/');
  check('商城 logo 副标题保持一行', await run(`return $('.mall-wordmark').getBoundingClientRect().height < 14`));
  await run(`setValue($('#mall-search'), '头戴式'); $('.browse-search button').click();`);
  await waitFor(`return location.pathname === '/headphones' && !!$('.result-bar span') && $('.result-bar span').textContent.includes('款符合')`);
  check('首页搜索“头戴式”跳到列表并只显示 2 款', await run(`return location.pathname === '/headphones' && new URLSearchParams(location.search).get('q') === '头戴式' && $('.result-bar span').textContent.includes('2 款')`));
  await go('/headphones');
  for (const y of [800, 1600, 2400, 3200, 4000]) { await run(`window.scrollTo(0, ${y})`); await sleep(250); }
  await sleep(600);
  await run(`window.scrollTo(0, 0)`);
  check('手机列表图片比例一致、铺满卡片且已加载', await run(`const imgs = [...document.querySelectorAll('.product-card .product-photo img')]; return imgs.length === 14 && imgs.every(i => i.complete && i.naturalWidth > 0 && getComputedStyle(i).objectFit === 'cover')`));
  await shot('mobile-02-list');
  await run(`window.scrollTo(0, 240)`);
  const originalScroll = await run(`return window.scrollY`);
  await run(`$('.launcher').click()`);
  await sleep(300);
  check('手机初始助手不显示商品卡片', await run(`return !$('.rec-item')`));
  check('手机助手占满视口', await run(`const r = $('.assistant').getBoundingClientRect(); return r.x === 0 && r.y === 0 && r.width === innerWidth && Math.abs(r.height - innerHeight) < 2`));
  await shot('mobile-03-assistant-initial');
  await sendText('300 元左右，最好有降噪');
  await sleep(1000);
  check('推荐卡片与列表共用图片映射，不用插画；推荐标题注明图片为演示示意', await run(`const arts = [...lastRec().querySelectorAll('.product-art')]; return arts.length === 3 && arts.every(a => a.matches('.product-photo, .product-placeholder')) && lastRec().querySelector('.rec-head').textContent.includes('图片为演示示意')`));
  check('手机上一张推荐卡片高度不超过 120px', await run(`return [...lastRec().querySelectorAll('.rec-item')].every(e => e.getBoundingClientRect().height <= 120)`));
  await shot('mobile-04-recommendations');
  await run(`$('.assistant-back').click()`);
  await sleep(300);
  check('关闭助手保留商品列表滚动位置', await run(`return Math.abs(window.scrollY - ${originalScroll}) < 2`));

  // 通用助手首页：输入优先，静态灵感和分类入口。
  await go('/');
  await run(`$('.launcher').click()`);
  await sleep(300);
  check('首页是通用购物标题，没有条件表单与耳机专属大按钮', await run(`return $('.assistant-start h1').textContent === '今天想买点什么？' && !$('.conditions') && !$('.starter-prompts')`));
  check('未选品类可直接输入', await run(`$('#assistant-input').focus(); setValue($('#assistant-input'), '我想买沙发'); return document.activeElement.id === 'assistant-input' && !$('#assistant-input').disabled`));
  await shot('assistant-01-initial');
  check('跨品类灵感明确标注静态精选和未开放', await run(`return $('.inspiration').textContent.includes('非个性化') && $('.inspiration').textContent.includes('尚未开放') && document.querySelectorAll('.inspiration-card').length === 3 && document.querySelectorAll('.inspiration-card.unavailable').length === 2 && document.querySelectorAll('button.inspiration-card').length === 1`));
  await run(`$('.inspiration').scrollIntoView({ block: 'start' })`);
  await shot('assistant-02-inspiration');
  await run(`setValue($('#assistant-input'), ''); $('button.inspiration-card').click()`);
  await sleep(200);
  check('点“猜你喜欢”卡片只把示例填入输入框，不发送、不产生条件', await run(`return $('#assistant-input').value === '300 元以内的地铁通勤耳机' && document.activeElement.id === 'assistant-input' && !!$('.assistant-start') && !$('.condition-chip') && !$('.message.from-user')`));
  await shot('assistant-06-inspiration-filled');
  await run(`$('.browse-categories').click()`);
  await sleep(150);
  check('分类只允许耳机选购', await run(`return document.querySelectorAll('.category-options button:not(:disabled)').length === 1 && document.querySelectorAll('.category-options button:disabled').length === 3`));
  await shot('assistant-04-categories');
  await run(`$('.category-options button:not(:disabled)').click()`);
  await sleep(150);
  check('耳机对话页有独立更换品类入口', await run(`return $('.shopping-context').textContent.includes('更换品类') && !$('.condition-form')`));
  check('选择蓝牙耳机后，聊天中留下说明', await run(`return [...document.querySelectorAll('.message')].some(e => e.textContent.includes('我们来挑蓝牙耳机'))`));
  await sendText('300 元以内，地铁通勤，需要主动降噪');
  check('聊天推荐卡片显示满足的条件，变更详情列出实际改动', await run(`const l = lastRec(); return !!l && !!l.querySelector('.rec-reasons')?.textContent.includes('预算 ≤ ¥300') && [...document.querySelectorAll('.change-log')].at(-1).textContent.includes('已设置：预算 ≤ ¥300')`));
  check('助手里不再有“未接入大模型”“固定话术”等过时提示', await run(`return !/未接入大模型|Mock 原型|固定话术/.test($('.assistant').innerText)`));
  await shot('assistant-03-conversation');
  await sendText('预算降到 200 元，其他不变');
  check('条件变化后旧推荐标为“之前的推荐”，只有最新一轮是当前推荐', await run(`const lists = [...document.querySelectorAll('.rec-list')]; return lists.length === 2 && lists[0].dataset.current === 'false' && lists[0].textContent.includes('之前的推荐') && lists[1].dataset.current === 'true'`));
  await run(`$('.assistant-body').scrollTop = $('.assistant-body').scrollHeight`);
  await sleep(200);
  check('聊天滚到底部时，“更换品类”仍在顶部可见', await run(`const b = $('.shopping-context button').getBoundingClientRect(); return b.top >= $('.assistant-body').getBoundingClientRect().top - 1 && $('.shopping-context').contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2))`));
  check('返回商城、更换品类、修改条件是三个独立入口', await run(`return $('.assistant-back').textContent.includes('返回商城') && $('.shopping-context button').textContent === '更换品类' && !!$('.condition-toggle') && new Set([$('.assistant-back'), $('.shopping-context button'), $('.condition-toggle')]).size === 3`));
  await shot('assistant-05-switch-entry');
  await run(`$('.more-button').click()`);
  await sleep(150);
  check('“开始新选购”放在“选购”分组，与原型调试分开', await run(`const hs = [...document.querySelectorAll('.debug-panel h2')].map(h => h.textContent); return hs[0] === '选购' && hs.includes('原型调试') && !!byText('.debug-panel button', '开始新选购')`));
  await run(`$('.more-button').click()`);

  // 灵感示例确认发送后：预算和场景生效，降噪只作为建议
  await go('/');
  await run(`$('.launcher').click()`);
  await sleep(300);
  check('直接打开助手时没有任何购买条件', await run(`return !!$('.assistant-start') && !$('.conditions') && !$('.condition-chip')`));
  await run(`$('button.inspiration-card').click()`);
  await sleep(200);
  await run(`$('.composer button[type=submit]').click()`);
  await sleep(1000);
  check('确认发送示例后：预算 ≤ ¥300 和场景生效，降噪不在已生效条件里', await run(`const tags = $('.condition-tags').textContent; return tags.includes('预算 ≤ ¥300') && tags.includes('场景：地铁通勤') && tags.includes('建议 1 项 · 未生效') && !tags.includes('必须支持主动降噪')`));
  await shot('assistant-07-example-submitted');
  await run(`$('.condition-toggle').click()`);
  await sleep(100);
  check('展开后，主动降噪显示为“系统建议 · 未生效”', await run(`const c = $('.status-card.suggested'); return !!c && c.textContent.includes('系统建议 · 未生效') && c.textContent.includes('必须支持主动降噪')`));

  // 桌面分屏（前端优化 P0-A / P0-B）：商品页与助手并行使用，当前浏览商品跟随页面
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await go('/');
  await run(`$('.launcher').click()`);
  await sleep(300);
  check('从首页打开助手：不绑定任何商品', await run(`return !$('.shopping-context .viewing') && document.querySelectorAll('.message-refs').length === 0`));
  await go('/headphones/redmi-buds-6');
  await run(`$('.launcher').click()`);
  await sleep(400);
  check('桌面打开助手：右侧非模态面板，没有遮罩和模糊，商品页不被禁用', await run(`return !$('.assistant-backdrop') && $('.assistant').getAttribute('role') === 'complementary' && !$('.assistant').hasAttribute('aria-modal') && !$('.mall-main').inert && document.body.classList.contains('assistant-docked') && getComputedStyle(document.body).position !== 'fixed' && getComputedStyle($('.mall-main')).filter === 'none'`));
  check('商品参数不被面板遮挡：主内容让出面板宽度', await run(`const m = $('.spec-table').getBoundingClientRect(), p = $('.assistant').getBoundingClientRect(); return m.right <= p.left && m.width > 300`));
  check('从 Redmi Buds 6 详情打开：助手的当前商品是 Redmi Buds 6', await run(`return $('.shopping-context .viewing').dataset.viewed === 'redmi-buds-6' && $('.message-refs').dataset.refs === 'redmi-buds-6'`));
  const pageY = await run(`return window.scrollY`);
  await run(`window.scrollBy(0, 300)`);
  await sleep(200);
  check('打开助手时商品页仍可滚动', await run(`return window.scrollY > ${pageY}`));
  await run(`byText('.detail-actions button', '比较').click()`);
  await sleep(200);
  check('打开助手时商品页按钮仍可点击', await run(`return byText('.detail-actions button', '已选').getAttribute('aria-pressed') === 'true'`));
  await sendText('它的降噪怎么样');
  check('问“它的降噪怎么样”：按当前浏览的 Redmi Buds 6 回答，消息固定关联该商品', await run(`const r = [...document.querySelectorAll('.message-refs')].at(-1); return r.dataset.refs === 'redmi-buds-6' && $('.messages').textContent.includes('最高 49dB 降噪深度')`));
  check('聊天记录在面板内独立滚动', await run(`return getComputedStyle($('.assistant-body')).overflowY === 'auto'`));
  await run(`$('.breadcrumb a[href="/headphones"]').click()`);
  await waitFor(`return location.pathname === '/headphones' && !!document.querySelector('.product-card a[href="/headphones/oppo-enco-air4-pro"]')`);
  await run(`document.querySelector('.product-card a[href="/headphones/oppo-enco-air4-pro"]').click()`);
  await waitFor(`return location.pathname === '/headphones/oppo-enco-air4-pro' && !!$('.spec-table') && $('.shopping-context .viewing')?.dataset.viewed === 'oppo-enco-air4-pro'`);
  check('切到 OPPO Enco Air4 Pro：当前浏览商品更新，助手保持打开', await run(`return location.pathname === '/headphones/oppo-enco-air4-pro' && !$('.assistant').hidden && $('.shopping-context .viewing').dataset.viewed === 'oppo-enco-air4-pro'`));
  check('切换商品后历史对话和原有商品关联不变', await run(`const refs = [...document.querySelectorAll('.message-refs')].map(r => r.dataset.refs); return refs.length === 2 && refs.every(r => r === 'redmi-buds-6')`));
  await sendText('它的降噪怎么样');
  check('再问同一句：按 OPPO Enco Air4 Pro 回答，之前的回答仍关联 Redmi Buds 6', await run(`const refs = [...document.querySelectorAll('.message-refs')].map(r => r.dataset.refs); return refs.at(-1) === 'oppo-enco-air4-pro' && refs[0] === 'redmi-buds-6' && $('.messages').textContent.includes('降噪深度达 49dB')`));
  await sendText('Redmi Buds 6S 的续航呢');
  check('明确提到另一型号时以明确型号为准', await run(`return [...document.querySelectorAll('.message-refs')].at(-1).dataset.refs === 'redmi-buds-6s' && location.pathname === '/headphones/oppo-enco-air4-pro'`));
  await shot('09-desktop-split');
  await run(`$('.assistant-back').click()`);
  await sleep(300);
  check('关闭助手后页面恢复原宽度', await run(`return !document.body.classList.contains('assistant-docked') && $('.mall-main').getBoundingClientRect().width >= 1100`));

  // 手机：详情页 → 全屏助手 → 返回商品页
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await go('/headphones/huawei-freebuds-6i');
  await shot('05-detail-mobile');
  check('详情页的示意图正常显示，标注“非该型号实拍”，来源里按许可署名作者、许可和修改说明', await run(`const img = $('.detail .product-photo.demo img'); return !!img && img.complete && img.naturalWidth > 0 && $('.detail .demo-badge').textContent.includes('非该型号实拍') && document.body.textContent.includes('商品示意图（同类耳机，非该型号实拍）：DYVER') && !!$('.data-note a[href="https://creativecommons.org/licenses/by-sa/4.0/"]')`));
  check('详情页参数表完整易读：品牌、型号、价格、佩戴、降噪、标称降噪、分口径续航、重量；不堆核验标签', await run(`const dts = [...document.querySelectorAll('.spec-table dt')].map(e => e.textContent); const t = $('.spec-table').textContent; return ['品牌', '型号', '价格', '佩戴方式', '主动降噪', '降噪深度', '续航', '重量'].every(k => dts.includes(k)) && t.includes('单次　降噪关 8 小时 / 降噪开 5 小时') && t.includes('含充电盒　降噪关 35 小时 / 降噪开 20 小时') && t.includes('不代表实际降噪效果') && !/价格口径|价格核验|未知|非实时/.test(t)`));
  check('来源与价格依据折叠在“参数来源”里，默认不展开', await run(`const d = $('.product-evidence'); return d.querySelector('summary').textContent === '参数来源' && !d.open && !!d.querySelector('.source-list a[href^="https://"]') && d.textContent.includes('价格依据：华为官网标价')`));
  await run(`byText('.sm-card button', '找相似款').click()`);
  await sleep(400);
  check('手机上助手全屏展开', await run(`return Math.round($('.assistant').getBoundingClientRect().width) === innerWidth`));
  await run(`$('.condition-toggle').click()`);
  await sleep(100);
  check('找相似款只提出建议，不直接生效', await run(`return document.querySelectorAll('.status-card.suggested').length === 2 && $('.condition-form input[type=number]').value === ''`));
  await shot('06-assistant-mobile');
  await run(`$('.assistant-back').click()`);
  await sleep(300);
  check('“返回商品页”关闭助手并停留在详情页', await run(`return $('.assistant').hidden && location.pathname === '/headphones/huawei-freebuds-6i'`));
  await go('/headphones/redmi-buds-6-pro');
  check('既没有准确型号照片也没有合适示意图的商品显示规范占位图', await run(`return !!$('.detail .product-placeholder') && !$('.detail .product-photo') && document.body.textContent.includes('暂无经授权的准确型号照片')`));
  check('公开模式下页面没有任何本地参考素材', await run(`return !$('.reference-badge') && ![...document.images].some(i => i.src.includes('/reference-images/'))`));
  await shot('08-placeholder-mobile');
  const reserved = await run(`return fetch('/headphones/sony-wf-1000xm4').then(r => r.status)`);
  check('保留列表的型号没有详情页', reserved === 404);
  for (const path of ['/', '/headphones', '/headphones/redmi-buds-6']) {
    await go(path);
    check(`手机 ${path} 无横向溢出`, await run(`return document.documentElement.scrollWidth <= innerWidth`));
  }
  await shot('07-list-mobile');

  // 手机：查看商品与聊天之间切换，保留会话和购买条件（P0-A 手机端）
  await go('/headphones/huawei-freebuds-6i');
  await run(`$('.launcher').click()`);
  await sleep(300);
  await run(`byText('.quick-options button', '300 元以内').click()`);
  await sleep(400);
  await sendText('它的续航怎么样');
  check('手机上问“它”：按正在看的华为 FreeBuds 6i 回答', await run(`return [...document.querySelectorAll('.message-refs')].at(-1).dataset.refs === 'huawei-freebuds-6i'`));
  const mobileMessages = await run(`return document.querySelectorAll('.message').length`);
  const target = await run(`const a = lastRec().querySelector('.rec-thumb'); const href = a.getAttribute('href'); a.click(); return href`);
  await waitFor(`return location.pathname === ${JSON.stringify(target)} && !!$('.detail .spec-table')`);
  check('手机上点推荐卡片：收起全屏助手，进入同一个商品详情页', await run(`return location.pathname === ${JSON.stringify(target)} && $('.assistant').hidden && !!$('.detail .spec-table')`));
  await run(`$('.launcher').click()`);
  await sleep(400);
  check('重新打开助手：聊天记录和购买条件都保留，当前商品更新', await run(`return document.querySelectorAll('.message').length === ${mobileMessages} && $('.condition-tags').textContent.includes('预算 ≤ ¥300') && $('.shopping-context .viewing').dataset.viewed === ${JSON.stringify(target.split('/').pop())}`));
  await shot('10-mobile-reopen');

  // Chat endpoint is exercised with a deterministic SDK response fixture, not a real model.
  await go('/headphones');
  await run(`$('.launcher').click()`);
  await sleep(300);
  await sendText('Redmi Buds 6 和 OPPO Enco Air4 有什么区别？');
  await waitFor(`return !!$('.assistant .compare-table')`);
  check('聊天比较调用后端并展示两款结构化比较', await run(`return !!$('.assistant .compare-table') && $('.messages').textContent.includes('¥199') && $('.messages').textContent.includes('¥169')`));
  await sendText('那它的续航怎么样？');
  check('比较后不明确的“它”先澄清', await run(`return [...document.querySelectorAll('.message')].at(-1).textContent.includes('你是指 Redmi Buds 6 还是 OPPO Enco Air4')`));
  const conditionsBeforeUnsupported = await run(`return $('.condition-tags')?.textContent ?? ''`);
  await sendText('想买沙发');
  check('未开放品类不修改耳机条件', await run(`return [...document.querySelectorAll('.message')].at(-1).textContent.includes('尚未开放') && ($('.condition-tags')?.textContent ?? '') === ${JSON.stringify(conditionsBeforeUnsupported)}`));

  check('控制台没有错误或异常', problems.length === 0);

  // 后端请求失败：显示可重试的错误，不显示“没有符合条件的商品”（放在最后，避免预期内的网络错误影响上面的控制台检查）
  await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['*/api/products/search'] });
  await go('/headphones');
  check('筛选请求失败时显示可重试的错误，不显示空结果', await run(`return !!$('.request-state.error button') && !document.body.textContent.includes('没有符合筛选条件的商品') && !document.querySelector('.product-card')`));
  await send('Network.setBlockedURLs', { urls: [] });
  await run(`$('.request-state.error button').click()`);
  await sleep(1200);
  check('后端恢复后点“重新筛选”即可正常显示商品', await run(`return document.querySelectorAll('.product-card').length === 15`));

  // 聊天请求失败：显示错误和重试，条件不变；恢复后点重试即可完成
  await send('Network.setBlockedURLs', { urls: ['*/api/chat'] });
  await run(`$('.launcher').click()`);
  await sleep(300);
  await sendText('300 元以内，地铁通勤，需要主动降噪');
  check('聊天请求失败：提示可重试，条件没有改变', await run(`return !!$('.error-line button') && [...document.querySelectorAll('.message')].at(-1).textContent.includes('无法连接') && !$('.condition-tags')?.textContent.includes('¥300')`));
  await send('Network.setBlockedURLs', { urls: [] });
  await run(`$('.error-line button').click()`);
  await waitFor(`return !!lastRec()`);
  check('恢复后重试成功，给出推荐，错误提示消失', await run(`return !!lastRec() && !$('.error-line') && $('.condition-tags').textContent.includes('预算 ≤ ¥300')`));
  if (problems.length) console.log(problems.join('\n'));
  ws.close();
} catch (error) {
  failures++;
  console.error(`FAIL ${error.message}`);
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
