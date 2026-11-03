'use strict';
/* ============================================================
 * GDP 小镇 · 埋点桥接层
 * 双通道：本地存档埋点(自己手机可看) + 百度统计(云端报表，看所有玩家)
 *
 * 【技术小白唯一要做的事】
 * 注册百度统计后，把代码里 hm.js? 后面那串站点 ID
 * 填到下面 BAIDU_ID 的引号里（不会填就把 ID 发给我，我来填）。
 * 填空字符串时游戏照常运行，只是云端报表不生效。
 * ============================================================ */
const ANALYTICS = {
  BAIDU_ID: 'fdd0a3eca7c1ebd4d48a6ba2bda4038c', // 百度统计站点ID（用户提供于2026-10-22）

  /* 匿名用户ID：无需注册，第一次打开自动生成，存在玩家自己浏览器里 */
  uid: '',
  uuid() {
    let id = '';
    try { id = localStorage.getItem('gdp_anon_id') || ''; } catch (e) {}
    if (!id) {
      id = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      try { localStorage.setItem('gdp_anon_id', id); } catch (e) {}
    }
    return id;
  },

  /* 页面启动时调用：识别"战书链接"打开 + 装载百度统计脚本 */
  init() {
    this.uid = this.uuid();
    // 信号①：战书链接打开率 —— 别人通过分享链接进来时 URL 带 ?from=share&sid=xxx
    const p = new URLSearchParams(location.search);
    if (p.get('from') === 'share') {
      this.send('裂变', 'share_open', (p.get('sid') || '').slice(0, 16));
      track('share_open');
    }
    if (this.BAIDU_ID) {
      window._hmt = window._hmt || [];
      const hm = document.createElement('script');
      hm.src = 'https://hm.baidu.com/hm.js?' + this.BAIDU_ID;
      const s = document.getElementsByTagName('script')[0];
      s.parentNode.insertBefore(hm, s);
    }
  },

  /* 发送自定义事件到百度统计（未配置ID时自动跳过，不报错） */
  send(category, action, label, value) {
    try {
      if (window._hmt) window._hmt.push(['_trackEvent', category, action, label || '', value || '']);
    } catch (e) { /* 静默失败，绝不影响游戏 */ }
  },

  /* 玩家专属邀请链接（战书链接）：带上分享者的匿名ID，便于统计谁带来的流量 */
  inviteLink() {
    return location.origin + location.pathname + '?from=share&sid=' + this.uid;
  }
};
