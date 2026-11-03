'use strict';
/* ============================================================
 * GDP 小镇 · 游戏引擎 (P0 MVP)
 * 架构纪律：信号总线解耦 / 状态单一来源 / 纯函数经济系统
 * P0 范围：题库闯关、红心、资金分配(C/I/G)、乘数机制、
 *          建筑养成、镇长任期(streak)、每日任务、分享卡、本地埋点
 * ============================================================ */

/* ---------- 事件总线：跨模块通信只走总线，组件互不直连 ---------- */
const Bus = {
  _m: new Map(),
  on(ev, fn) { if (!this._m.has(ev)) this._m.set(ev, []); this._m.get(ev).push(fn); },
  emit(ev, data) { (this._m.get(ev) || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }
};

/* ---------- 存储安全层（预览环境可能禁用 localStorage） ---------- */
const Store = {
  key: 'gdp_town_v1',
  mem: null,
  load() { try { const r = localStorage.getItem(this.key); return r ? JSON.parse(r) : null; } catch (e) { return this.mem; } },
  save(s) { try { localStorage.setItem(this.key, JSON.stringify(s)); } catch (e) { this.mem = s; } }
};

/* ---------- 日期工具 ---------- */
function todayStr() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function yesterdayStr() { const d = new Date(Date.now() - 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

/* ---------- 常量配置 ---------- */
const BUILDINGS = {
  home:    { name: '住宅区', gdp: 200, cost: [100, 300, 900],  desc: '居民消费 C 的基础' },
  factory: { name: '工厂',   gdp: 400, cost: [150, 450, 1350], desc: '投资 I 的载体' },
  shop:    { name: '商店街', gdp: 300, cost: [120, 360, 1080], desc: '商业繁荣度' },
  school:  { name: '学校',   gdp: 100, cost: [200, 600, 1800], desc: '每级使答题收益 +10%' }
};
const RANKS = [[0, '村庄'], [10000, '小镇'], [50000, '县城'], [200000, '城市'], [1000000, '都市圈']];
const LEVEL_SIZE = 5;   // 每关题数
const HEART_MAX = 5;
const HEART_REGEN_MS = 180000; // 3 分钟恢复 1 心

/* ---------- 游戏状态（单一来源） ---------- */
function defaultState() {
  return {
    coins: 120, gems: 0, hearts: HEART_MAX, heartTs: Date.now(),
    gdpBonus: 0,
    buildings: { home: 0, factory: 0, shop: 0, school: 0 },
    prog: { c1: { cleared: 0 }, c2: { cleared: 0 } },
    ansTotal: 0, ansCorrect: 0, recent: [],
    streak: 0, lastDay: '', firstDay: todayStr(), totalDays: 0,
    task: { day: '', a1: 0, a2: 0, a3: 0, claimed: {} },
    shares: 0,
    welcomed: false,
    log: []
  };
}
let S = Store.load() || defaultState();

/* ---------- 埋点（本地存档 + 百度统计双通道，见 analytics.js） ----------
 * 三个验证信号对应的事件：
 * 信号① 裂变引擎  → 分享次数 share_card 与战书打开 share_open（打开率=share_open/share_card）
 * 信号② 习惯钩子  → 每日首次访问 visit（次日回访率在百度统计「访客分析-回访率」直接看）
 * 信号③ 重玩价值  → 完成关卡 level_complete（人均局数=level_complete总数/访客数） */
const TRACK_MAP = {
  visit:            () => ['留存', 'visit', String(S.totalDays)],
  welcome_start:    () => ['留存', 'welcome_start', ''],
  level_complete:   () => ['重玩', 'level_complete', session ? session.ch + '-L' + (session.lv + 1) : ''],
  share_card:       () => ['裂变', 'share_card', ANALYTICS.uid],
  alloc_invest:     () => ['重玩', 'alloc_invest', ''],
  building_upgrade: () => ['重玩', 'building_upgrade', ''],
  quiz_wrong:       () => ['留存', 'quiz_wrong', '']
};
function track(ev) {
  S.log.push({ t: Date.now(), e: ev });
  if (S.log.length > 400) S.log = S.log.slice(-400);
  if (TRACK_MAP[ev]) { const a = TRACK_MAP[ev](); ANALYTICS.send(a[0], a[1], a[2]); }
  Bus.emit('state_changed');
}
function logCount(ev) { return S.log.filter(x => x.e === ev).length; }

/* ---------- 纯函数经济系统 ---------- */
function recentRate(s) { const r = s.recent.slice(-20); return r.length ? r.reduce((a, b) => a + b, 0) / r.length : 0.6; }
function beta(s) { return 0.5 + recentRate(s) * 0.4; }             // 正确率 0~1 → β 0.5~0.9
function multiplier(s) { return 1 / (1 - beta(s)); }               // 投资乘数 2~10
function buildingGdp(s) { return Object.keys(BUILDINGS).reduce((sum, k) => sum + BUILDINGS[k].gdp * s.buildings[k], 0); }
function gdp(s) { return Math.round(1000 + buildingGdp(s) + s.gdpBonus); }
function rankOf(g) {
  let name = RANKS[0][1], next = null;
  for (const [t, n] of RANKS) { if (g >= t) name = n; else { next = t; break; } }
  return { name, next };
}
function schoolBonus(s) { return 1 + 0.1 * s.buildings.school; }

/* ---------- 状态持久化与生命周期 ---------- */
function save() { Store.save(S); Bus.emit('state_changed'); }
function ensureTask() {
  if (S.task.day !== todayStr()) S.task = { day: todayStr(), a1: 0, a2: 0, a3: 0, claimed: {} };
}
function handleStreak() {
  const d = todayStr();
  if (S.lastDay !== d) {
    S.streak = (S.lastDay === yesterdayStr()) ? S.streak + 1 : 1;
    S.lastDay = d;
    S.totalDays++;
    track('visit');
  }
  ensureTask();
}
function regenHearts() {
  if (S.hearts < HEART_MAX && Date.now() - S.heartTs >= HEART_REGEN_MS) {
    S.hearts++;
    S.heartTs = Date.now();
    save();
  }
}
setInterval(() => { regenHearts(); }, 10000);

/* ---------- 答题会话 ---------- */
let session = null; // { ch, lv, idx, correct, answered }
function chapterQuestions(ch) { return QUESTIONS.filter(q => q.ch === ch); }
function levelQuestions(ch, lv) { return chapterQuestions(ch).slice(lv * LEVEL_SIZE, lv * LEVEL_SIZE + LEVEL_SIZE); }
function levelCount(ch) { return Math.ceil(chapterQuestions(ch).length / LEVEL_SIZE); }
function chapterUnlocked(chMeta) {
  if (!chMeta.unlockAfter) return true;
  return (S.prog[chMeta.unlockAfter].cleared || 0) >= 1;
}

function startLevel(ch, lv) {
  if (S.hearts <= 0) { openModal('<h3>红心不足</h3><p>答错会扣红心，红心每 3 分钟恢复 1 颗，也可以去「镇长」页用宝石兑换。</p>'); return; }
  session = { ch, lv, idx: 0, correct: 0 };
  track('level_start');
  Bus.emit('state_changed');
}
function answerQuestion(optIdx) {
  if (!session) return;
  const q = levelQuestions(session.ch, session.lv)[session.idx];
  const correct = optIdx === q.a;
  session.answered = true;
  if (correct) {
    session.correct++;
    const gain = Math.round((10 + q.d * 5) * schoolBonus(S));
    S.coins += gain;
    S.ansTotal++; S.ansCorrect++; S.task.a1++;
    S.recent.push(1);
    session.lastGain = gain;
  } else {
    S.hearts = Math.max(0, S.hearts - 1);
    S.heartTs = Date.now();
    S.ansTotal++; S.task.a1++;
    S.recent.push(0);
  }
  track(correct ? 'quiz_correct' : 'quiz_wrong');
  save();
}
function nextQuestion() {
  session.idx++;
  session.answered = false;
  if (session.idx >= LEVEL_SIZE) finishLevel();
  else Bus.emit('state_changed');
}
function finishLevel() {
  const fund = 100 + session.correct * 20;
  const perfect = session.correct === LEVEL_SIZE;
  if (perfect) S.hearts = Math.min(HEART_MAX, S.hearts + 1);
  S.task.a2++;
  track('level_complete');
  showAllocation(fund, perfect);
}

/* ---------- 资金分配（乘数机制的核心交互） ---------- */
function showAllocation(fund, perfect) {
  const b = beta(S), k = multiplier(S);
  const cGain = Math.round(fund * 0.75);
  const iGain = Math.round(fund * k * 0.25);
  const gGdp = fund * 2, gCoin = Math.round(fund * 0.2);
  openModal(`
    <h3>关卡完成 · 财政决策</h3>
    ${perfect ? '<p class="perfect">全部答对！镇长威望 +1 红心</p>' : ''}
    <p>本关筹得资金 <b>${fund}</b> 万，请镇长决定用途：</p>
    <p class="formula">你的近 20 题正确率 <b>${Math.round(recentRate(S) * 100)}%</b> →
    边际消费倾向 β = <b>${b.toFixed(2)}</b> → 投资乘数 k = 1/(1−β) ≈ <b>${k.toFixed(1)}</b></p>
    <div class="alloc">
      <button data-alloc="c"><b>发放消费券 (C)</b><span>立即入账 ${cGain} 金币，稳</span></button>
      <button data-alloc="i"><b>招商投资 (I)</b><span>按乘数回收 ${iGain} 金币——学得越好赚越多</span></button>
      <button data-alloc="g"><b>公共工程 (G)</b><span>小镇 GDP +${gGdp}，金币 +${gCoin}</span></button>
    </div>
    <p class="hint">C 稳健、I 吃你的经济学水平、G 直接推进小镇晋升。这正是本章知识点的现实含义。</p>
  `);
  document.querySelectorAll('[data-alloc]').forEach(btn => {
    btn.onclick = () => {
      const a = btn.dataset.alloc;
      if (a === 'c') S.coins += cGain;
      if (a === 'i') { S.coins += iGain; track('alloc_invest'); }
      if (a === 'g') { S.gdpBonus += gGdp; S.coins += gCoin; }
      const ch = session.ch, lv = session.lv;
      S.prog[ch].cleared = Math.max(S.prog[ch].cleared || 0, lv + 1);
      if (ch === 'c1' && S.prog.c1.cleared >= 1) S.prog.c2.unlocked = true;
      const done = session; session = null;
      track('alloc_' + a);
      save();
      closeModal();
      openModal(`<h3>财政决策生效</h3><p>${a === 'i' ? `投资经乘数 k=${multiplier(S).toFixed(1)} 放大，` : ''}小镇正在发展…</p>
        <button onclick="closeModal()">继续</button>`);
      Bus.emit('state_changed');
    };
  });
}

/* ---------- 建筑升级 ---------- */
function upgradeBuilding(key) {
  const lv = S.buildings[key];
  if (lv >= 3) return;
  const cost = BUILDINGS[key].cost[lv];
  if (S.coins < cost) { openModal('<h3>金币不足</h3><p>去「答题」招商引资赚金币吧。</p>'); return; }
  S.coins -= cost;
  S.buildings[key] = lv + 1;
  S.task.a3++;
  track('building_upgrade');
  save();
  Bus.emit('state_changed');
}

/* ---------- 每日任务 ---------- */
const TASKS = [
  { id: 'a1', name: '答对 8 道题', val: s => s.task.a1, goal: 8 },
  { id: 'a2', name: '完成 2 个关卡', val: s => s.task.a2, goal: 2 },
  { id: 'a3', name: '升级 1 次建筑', val: s => s.task.a3, goal: 1 }
];
function claimTask(id) {
  const t = TASKS.find(x => x.id === id);
  if (!t || S.task.claimed[id] || t.val(S) < t.goal) return;
  S.task.claimed[id] = true;
  S.gems += 1;
  track('task_claim');
  save();
  Bus.emit('state_changed');
}
function exchangeHeart() {
  if (S.gems < 2 || S.hearts >= HEART_MAX) return;
  S.gems -= 2; S.hearts++;
  save(); Bus.emit('state_changed');
}

/* ---------- 分享卡（Canvas 生成 PNG） ---------- */
function generateShareCard() {
  const g = gdp(S), r = rankOf(g);
  const beat = Math.min(95, Math.round(g / 300));
  const W = 540, H = 720;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#f4f7f4'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#0f6e56'; ctx.fillRect(0, 0, W, 130);
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 34px system-ui';
  ctx.fillText('GDP 小镇 · 镇长成绩单', 30, 60);
  ctx.font = '16px system-ui';
  ctx.fillText('凭本事学的宏观经济学，都在镇上', 30, 100);
  ctx.fillStyle = '#26215c'; ctx.font = 'bold 44px system-ui';
  ctx.fillText(r.name + ' · GDP ' + g.toLocaleString() + ' 万', 30, 210);
  const rows = [
    ['镇长任期', S.totalDays + ' 天（连续 ' + S.streak + ' 天）'],
    ['累计答题', S.ansTotal + ' 题 · 正确率 ' + (S.ansTotal ? Math.round(100 * S.ansCorrect / S.ansTotal) : 0) + '%'],
    ['边际消费倾向 β', beta(S).toFixed(2)],
    ['投资乘数 k', multiplier(S).toFixed(1)],
    ['实力超越', '约 ' + beat + '% 的镇长']
  ];
  ctx.font = '20px system-ui';
  rows.forEach((row, i) => {
    ctx.fillStyle = '#5f5e5a'; ctx.fillText(row[0], 30, 290 + i * 62);
    ctx.fillStyle = '#26215c'; ctx.font = 'bold 24px system-ui'; ctx.fillText(row[1], 30, 322 + i * 62);
    ctx.font = '20px system-ui';
  });
  ctx.fillStyle = '#0f6e56'; ctx.font = '16px system-ui';
  ctx.fillText('宏观经济学学习游戏 · 来当我的人民', 30, H - 70);
  ctx.fillStyle = '#26215c'; ctx.font = 'bold 18px system-ui';
  ctx.fillText(inviteLink().replace(/^https?:\/\//, ''), 30, H - 40);
  S.shares++;
  track('share_card');
  save();
  const a = document.createElement('a');
  a.download = 'GDP小镇-镇长成绩单.png';
  a.href = cv.toDataURL('image/png');
  a.click();
  Bus.emit('state_changed');
}

/* ---------- 视图渲染 ---------- */
const $ = sel => document.querySelector(sel);
function esc(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

function renderHeader() {
  $('#st-hud').innerHTML =
    `<span class="hud">${S.coins} 金币</span>
     <span class="hud">${S.hearts}/${HEART_MAX} 红心</span>
     <span class="hud">${S.gems} 宝石</span>
     <span class="hud">任期 ${S.totalDays} 天</span>`;
}

function renderQuizTab() {
  const el = $('#view-quiz');
  if (!session) { el.innerHTML = renderChapterList(); bindChapterList(el); return; }
  const q = levelQuestions(session.ch, session.lv)[session.idx];
  el.innerHTML = `
    <div class="lv-head">第 ${session.lv + 1} 关 · 第 ${session.idx + 1}/${LEVEL_SIZE} 题
      <span class="tag">${esc(q.tag)}</span></div>
    <div class="q-text">${esc(q.q)}</div>
    <div class="opts">${q.opts.map((o, i) =>
      `<button class="opt" data-i="${i}" ${session.answered ? 'disabled' : ''}>${esc(o)}</button>`).join('')}</div>
    <div id="q-feedback"></div>`;
  el.querySelectorAll('.opt').forEach(btn => {
    btn.onclick = () => {
      if (session.answered) return;
      const i = Number(btn.dataset.i);
      answerQuestion(i);
      const q2 = levelQuestions(session.ch, session.lv)[session.idx];
      el.querySelectorAll('.opt').forEach((b, j) => {
        b.disabled = true;
        if (j === q2.a) b.classList.add('correct');
        else if (j === i) b.classList.add('wrong');
      });
      const last = session.lastGain || 0;
      $('#q-feedback').innerHTML = `
        <div class="feedback ${i === q2.a ? 'ok' : 'no'}">
          <b>${i === q2.a ? '回答正确，招商引资 +' + last + ' 金币' : '回答错误，红心 −1'}</b>
          <p>${esc(q2.exp)}</p>
          <button id="btn-next">${session.idx + 1 >= LEVEL_SIZE ? '完成关卡' : '下一题'}</button>
        </div>`;
      $('#btn-next').onclick = () => { if (S.hearts <= 0 && session.idx + 1 < LEVEL_SIZE) { session = null; save(); Bus.emit('state_changed'); openModal('<h3>红心用完了</h3><p>本关中断。红心每 3 分钟恢复 1 颗，或用宝石兑换。</p>'); } else nextQuestion(); };
    };
  });
}

function renderChapterList() {
  return CHAPTERS.map(cMeta => {
    const unlocked = chapterUnlocked(cMeta);
    const nLevels = levelCount(cMeta.id);
    const cleared = S.prog[cMeta.id].cleared || 0;
    const levels = Array.from({ length: nLevels }, (_, i) => {
      const state = i < cleared ? 'done' : (i === cleared && unlocked ? 'open' : 'lock');
      return `<button class="lv-btn ${state}" data-ch="${cMeta.id}" data-lv="${i}" ${state === 'lock' || state === 'done' && false ? 'disabled' : ''}>
        第 ${i + 1} 关${state === 'done' ? ' · 已通关' : ''}${state === 'lock' ? ' · 未解锁' : ''}</button>`;
    }).join('');
    return `<div class="card chapter ${unlocked ? '' : 'locked'}">
      <h3>${esc(cMeta.name)}</h3><p class="muted">${esc(cMeta.desc)}</p>
      ${unlocked ? `<div class="lv-grid">${levels}</div>` : '<p class="muted">通关第一章任意一关后解锁</p>'}
    </div>`;
  }).join('');
}
function bindChapterList(el) {
  el.querySelectorAll('.lv-btn:not(.lock)').forEach(btn => {
    btn.onclick = () => startLevel(btn.dataset.ch, Number(btn.dataset.lv));
  });
}

function renderTownTab() {
  const g = gdp(S), r = rankOf(g);
  const prog = r.next ? Math.min(100, Math.round(100 * (g - RANKS.find(x => x[1] === r.name)[0]) / (r.next - RANKS.find(x => x[1] === r.name)[0]))) : 100;
  $('#view-town').innerHTML = `
    <div class="card town-head">
      <div class="gdp-num">${g.toLocaleString()} <small>万 GDP</small></div>
      <div class="rank">${r.name}${r.next ? ' · 距「' + RANKS.find(x => x[1] === r.next)[1] + '」还差 ' + (r.next - g).toLocaleString() : ' · 已满级'}</div>
      <div class="bar"><div class="bar-fill" style="width:${prog}%"></div></div>
      <p class="muted">GDP = 基础 1000 + 建筑产出 ${buildingGdp(S).toLocaleString()} + 公共工程累计 ${S.gdpBonus.toLocaleString()}</p>
    </div>
    ${Object.keys(BUILDINGS).map(k => {
      const b = BUILDINGS[k], lv = S.buildings[k];
      const maxed = lv >= 3;
      const cost = maxed ? 0 : b.cost[lv];
      return `<div class="card bld">
        <div><b>${b.name}</b> <span class="lv-star">${'◆'.repeat(lv) || '未建造'}</span>
          <p class="muted">${b.desc} · 产出 GDP ${b.gdp * lv}</p></div>
        <button data-bld="${k}" ${maxed || S.coins < cost ? 'disabled' : ''}>${maxed ? '满级' : '升级 ' + cost}</button>
      </div>`;
    }).join('')}`;
  $('#view-town').querySelectorAll('[data-bld]').forEach(btn => {
    btn.onclick = () => upgradeBuilding(btn.dataset.bld);
  });
}

function renderProfileTab() {
  ensureTask();
  const rate = S.ansTotal ? Math.round(100 * S.ansCorrect / S.ansTotal) : 0;
  $('#view-profile').innerHTML = `
    <div class="card"><h3>镇长档案</h3>
      <p>任期 ${S.totalDays} 天 · 连续治理 ${S.streak} 天 · 首日 ${S.firstDay}</p>
      <p>累计答题 ${S.ansTotal} · 正确率 ${rate}% · β=${beta(S).toFixed(2)} · k=${multiplier(S).toFixed(1)}</p>
    </div>
    <div class="card"><h3>今日任务</h3>
      ${TASKS.map(t => {
        const done = t.val(S) >= t.goal, claimed = S.task.claimed[t.id];
        return `<div class="task"><span>${t.name}（${Math.min(t.val(S), t.goal)}/${t.goal}）</span>
          <button data-task="${t.id}" ${!done || claimed ? 'disabled' : ''}>${claimed ? '已领' : '领 1 宝石'}</button></div>`;
      }).join('')}
      <div class="task"><span>用 2 宝石换 1 红心（当前 ${S.hearts}/${HEART_MAX}）</span>
        <button data-heart="1" ${S.gems < 2 || S.hearts >= HEART_MAX ? 'disabled' : ''}>兑换</button></div>
    </div>
    <div class="card"><h3>成果分享</h3>
      <p class="muted">生成镇长成绩单图片，或复制「战书链接」发给同学。今日已分享 ${S.shares} 次。</p>
      <button id="btn-share">生成分享卡（+1 红心任务奖励）</button>
      <button id="btn-invite" style="margin-top:8px">复制战书链接</button>
    </div>
    <div class="card"><h3>数据面板（验证指标）</h3>
      <p class="muted">答题 ${logCount('quiz_correct') + logCount('quiz_wrong')} 次 · 完成关卡 ${logCount('level_complete')} · 升级 ${logCount('building_upgrade')} · 分享 ${logCount('share_card')} · 访问天数 ${S.totalDays}</p>
      <button id="btn-reset" class="danger">重置存档（开发用）</button>
    </div>`;
  $('#view-profile').querySelectorAll('[data-task]').forEach(b => b.onclick = () => claimTask(b.dataset.task));
  const hb = $('#view-profile').querySelector('[data-heart]'); if (hb) hb.onclick = exchangeHeart;
  $('#btn-share').onclick = generateShareCard;
  $('#btn-invite').onclick = () => {
    const link = inviteLink();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(() => {
        S.shares++; track('share_card'); save();
        openModal('<h3>战书已复制</h3><p>粘贴到微信群即可：<br><b>' + link + '</b></p><p class="hint">同学点开这个链接，就能统计到「战书打开率」。</p><button onclick="closeModal()">好</button>');
      }).catch(() => openModal('<h3>战书链接</h3><p>请手动长按复制：<br><b>' + link + '</b></p><button onclick="closeModal()">好</button>'));
    } else {
      openModal('<h3>战书链接</h3><p>请手动长按复制：<br><b>' + link + '</b></p><button onclick="closeModal()">好</button>');
    }
  };
  $('#btn-reset').onclick = () => {
    openModal('<h3>确认重置？</h3><p>将清空全部进度，无法恢复。</p><button onclick="doReset()">确认重置</button> <button onclick="closeModal()">取消</button>');
  };
}
function doReset() { S = defaultState(); handleStreak(); save(); closeModal(); Bus.emit('state_changed'); }

/* ---------- 首次访问欢迎页（首页文案：3秒讲清玩什么+为什么玩） ---------- */
function showWelcome() {
  openModal(`
    <h3>📍 你刚继承了一座小镇</h3>
    <p>没有钱，没有产业，只有一个法宝：<b>会做题就会搞经济</b>。</p>
    <div class="welcome-list">
      <p>🏗️ <b>答题 = 招商引资</b>：答对宏观经济学题，金币到账，盖工厂、建学校</p>
      <p>📈 <b>学得越好，赚得越凶</b>：你的正确率决定投资乘数 k，最高 <b>10 倍</b>返利</p>
      <p>🏆 <b>小镇替你记着账</b>：GDP 从村庄涨到都市圈，断签一天 GDP 就预警</p>
    </div>
    <p class="hint">不用下载、不用注册，点开就玩。写给正在被宏观经济学期末考折磨的你。</p>
    <button onclick="acceptWelcome()">开始当镇长</button>
  `);
}
function acceptWelcome() {
  S.welcomed = true;
  track('welcome_start');
  save();
  closeModal();
}

/* ---------- 弹窗 ---------- */
function openModal(html) {
  $('#modal').innerHTML = `<div class="modal-box">${html}<button class="modal-x" onclick="closeModal()">×</button></div>`;
  $('#modal').classList.add('show');
}
function closeModal() { $('#modal').classList.remove('show'); }

/* ---------- 总渲染 ---------- */
let curTab = 'quiz';
function renderAll() {
  renderHeader();
  if (curTab === 'quiz') renderQuizTab();
  if (curTab === 'town') renderTownTab();
  if (curTab === 'profile') renderProfileTab();
}
Bus.on('state_changed', () => { renderAll(); });

function switchTab(t) {
  curTab = t;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('show'));
  $('#view-' + t).classList.add('show');
  renderAll();
}

/* ---------- 启动 ---------- */
function boot() {
  ANALYTICS.init();   // 匿名ID + 战书链接识别 + 百度统计装载
  handleStreak();
  regenHearts();
  save();
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  switchTab('quiz');
  if (!S.welcomed) showWelcome();   // 首次访问：先看懂再玩
}
boot();
