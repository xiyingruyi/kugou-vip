export function activate(ctx) {
  const { defineComponent, h, ref } = ctx.vue;
  let Button;
  if (ctx.ui && ctx.ui.components && ctx.ui.components.Button) {
    Button = ctx.vue.defineAsyncComponent(ctx.ui.components.Button);
  }

  const claiming = ref(false);
  const logs = ref([]);
  const statusText = ref("初始化…");

  const timers = [];
  const cleanups = [];
  let stopped = false;
  let autoTries = 0;
  const memStore = new Map();

  const addLog = (msg) => {
    const time = new Date().toLocaleTimeString();
    logs.value.push(`[${time}] ${msg}`);
    if (logs.value.length > 200) logs.value.splice(0, logs.value.length - 200);
    console.log(`[Auto-VIP] ${msg}`);
  };

  // ---- 兼容不同文档版本的 KV API：get/set vs kvGet/kvSet ----
  const storageGet = async (key) => {
    try {
      if (ctx.storage && typeof ctx.storage.get === "function") return await ctx.storage.get(key);
      if (ctx.storage && typeof ctx.storage.kvGet === "function") return await ctx.storage.kvGet(key);
    } catch (e) { /* 忽略，走内存兜底 */ }
    return memStore.has(key) ? memStore.get(key) : undefined;
  };
  const storageSet = async (key, value) => {
    try {
      if (ctx.storage && typeof ctx.storage.set === "function") { await ctx.storage.set(key, value); return; }
      if (ctx.storage && typeof ctx.storage.kvSet === "function") { await ctx.storage.kvSet(key, value); return; }
    } catch (e) { /* 忽略，走内存兜底 */ }
    memStore.set(key, value);
  };

  const STATE_KEY = "autoVipState";

  const getServerToday = async () => {
    try {
      const res = await ctx.kugou.user.getServerNow();
      if (res && typeof res === "object") {
        const source = res.data && typeof res.data === "object" ? res.data : res;
        const candidates = [source.now, source.time, source.timestamp, source.server_time, source.serverTime];
        for (const candidate of candidates) {
          const value = Number(candidate);
          if (Number.isFinite(value) && value > 0) {
            const ms = value > 1e12 ? value : value * 1000;
            const date = new Date(ms);
            const offset = 8 * 60;
            const local = new Date(date.getTime() + offset * 60 * 1000);
            return local.toISOString().split("T")[0];
          }
        }
      }
    } catch (e) {
      addLog("获取服务器时间失败，使用本地时间兜底");
    }
    const now = new Date();
    const offset = 8 * 60;
    const local = new Date(now.getTime() + offset * 60 * 1000);
    return local.toISOString().split("T")[0];
  };

  const loadState = async (today) => {
    const s = (await storageGet(STATE_KEY)) || {};
    if (s.date !== today) return { date: today, dayVip: false, concept: false, done: false };
    return { date: today, dayVip: !!s.dayVip, concept: !!s.concept, done: !!s.done };
  };
  const saveState = async (s) => {
    try { await storageSet(STATE_KEY, s); } catch (e) { /* 忽略 */ }
  };

  const looksAlreadyClaimed = (msg) => {
    if (!msg) return false;
    return /已领|已经领|重复|今天|今日|无需|已是|已升级|already|duplicate/i.test(String(msg));
  };

  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); timers.push(t); });

  const doClaim = async (isManual = false, reason = "") => {
    if (claiming.value) return false;
    if (stopped && !isManual) return false;
    claiming.value = true;
    statusText.value = isManual ? "手动领取中…" : `自动领取中${reason ? `（${reason}）` : ""}…`;
    if (isManual) addLog("手动触发领取流程...");
    else { autoTries += 1; addLog(`自动领取第 ${autoTries} 次${reason ? `（${reason}）` : ""}...`); }

    try {
      if (!ctx.kugou) throw new Error("插件未声明或未获取酷狗API能力");

      const today = await getServerToday();
      addLog(`使用日期: ${today}`);
      const state = await loadState(today);
      if (!isManual && state.done) {
        addLog("今日已完成，跳过。");
        statusText.value = "今日已完成 ✅";
        return true;
      }

      let dayVipOk = state.dayVip;
      let conceptOk = state.concept;

      // 1. 领取畅听VIP（幂等：成功或“已领取”都算过）
      if (!dayVipOk) {
        try {
          const tvipRes = await ctx.kugou.user.claimDayVip(today);
          if (tvipRes && tvipRes.status === 1) {
            dayVipOk = true;
            addLog("🎉 畅听会员领取成功！");
            if (isManual) ctx.toast.success("🎉 畅听会员领取成功！");
          } else if (tvipRes && (tvipRes.error_code || tvipRes.code || tvipRes.msg || tvipRes.message)) {
            const m = tvipRes.msg || tvipRes.message || "";
            if (looksAlreadyClaimed(m)) {
              dayVipOk = true;
              addLog(`畅听会员今日已领过（${m || tvipRes.error_code || tvipRes.code}），视为通过`);
            } else {
              addLog(`畅听会员返回：${JSON.stringify(tvipRes).slice(0, 200)}`);
            }
          } else {
            addLog(`畅听会员返回未知：${JSON.stringify(tvipRes).slice(0, 200)}`);
          }
        } catch (e) {
          if (looksAlreadyClaimed(e && e.message)) {
            dayVipOk = true;
            addLog(`畅听会员已领过（${e.message}），视为通过`);
          } else {
            addLog(`畅听会员领取请求失败（稍后会自动重试）: ${e.message}`);
          }
        }
      } else {
        addLog("畅听会员今日已标记成功，跳过。");
      }

      // 2. 升级前先“预热”：模拟打开个人面板会做的 VIP 详情刷新
      try {
        await ctx.kugou.user.getUserVipDetail();
      } catch (e) { /* 预热失败不阻塞，后面重试 */ }

      // 3. 升级概念VIP：带重试，解决 claim->upgrade 服务端同步竞态
      if (!conceptOk) {
        const maxAttempts = isManual ? 2 : 4;
        for (let i = 1; i <= maxAttempts; i++) {
          try {
            const svipRes = await ctx.kugou.user.upgradeDayVip();
            if (svipRes && svipRes.status === 1) {
              conceptOk = true;
              addLog("🚀 概念会员升级成功！");
              ctx.toast.success("🚀 概念会员升级成功！");
              break;
            }
            const m = (svipRes && (svipRes.msg || svipRes.message)) || "";
            if (looksAlreadyClaimed(m)) {
              conceptOk = true;
              addLog(`概念会员今日已是最新（${m}），视为通过`);
              break;
            }
            addLog(`概念会员升级第 ${i}/${maxAttempts} 次未成功：${JSON.stringify(svipRes).slice(0, 200)}，${i < maxAttempts ? "1秒后重试" : "本轮结束"}`);
          } catch (e) {
            if (looksAlreadyClaimed(e && e.message)) {
              conceptOk = true;
              addLog(`概念会员已是最新（${e.message}），视为通过`);
              break;
            }
            addLog(`概念会员升级第 ${i}/${maxAttempts} 次异常：${e.message}，${i < maxAttempts ? "1秒后重试" : "本轮结束"}`);
          }
          if (!conceptOk && i < maxAttempts) await sleep(1200);
        }
      } else {
        addLog("概念会员今日已标记成功，跳过。");
      }

      // 4. 成功则刷新用户信息 + 持久化今日状态
      if (dayVipOk && conceptOk) {
        try {
          await ctx.kugou.user.getUserDetail();
          await ctx.kugou.user.getUserVipDetail();
          addLog("已刷新用户VIP信息");
        } catch (e) { addLog("刷新用户信息失败（不影响领取结果）"); }
        await saveState({ date: today, dayVip: true, concept: true, done: true });
        statusText.value = "今日已完成 ✅";
        stopAutoLoop("今日已完成");
        return true;
      }
      if (dayVipOk || conceptOk) {
        await saveState({ date: today, dayVip: dayVipOk, concept: conceptOk, done: false });
        try {
          await ctx.kugou.user.getUserDetail();
          await ctx.kugou.user.getUserVipDetail();
        } catch (e) { /* 忽略 */ }
      }
      if (isManual && !(dayVipOk && conceptOk)) {
        ctx.toast.info("部分成功或今日已领过，详见日志；自动任务会继续补领");
      }
      statusText.value = isManual ? "手动执行完毕（部分待补领）" : "等待下次自动补领…";
      addLog("本轮执行完毕（未完全成功，自动任务会继续补领）。");
      return false;
    } catch (error) {
      addLog(`执行异常（稍后会自动重试）: ${error.message}`);
      statusText.value = "异常，等待重试…";
      return false;
    } finally {
      claiming.value = false;
    }
  };

  const tryAuto = async (reason) => {
    if (stopped || claiming.value) return;
    try {
      const today = await getServerToday();
      const state = await loadState(today);
      if (state.done) { statusText.value = "今日已完成 ✅"; stopAutoLoop("今日已完成"); return; }
    } catch (e) { /* 查不到状态也继续探活 */ }
    // 轻量探活：没登录就等下一轮，不消耗领取机会
    try {
      const res = await ctx.kugou.user.getUserDetail();
      if (!(res && res.status === 1)) {
        if (autoTries % 4 === 0) addLog("登录态尚未就绪，等待下次补领…");
        statusText.value = "等待登录…";
        return;
      }
    } catch (e) {
      if (autoTries % 4 === 0) addLog("登录态尚未就绪，等待下次补领…");
      statusText.value = "等待登录…";
      return;
    }
    await doClaim(false, reason);
  };

  const stopAutoLoop = (why) => {
    if (stopped) return;
    stopped = true;
    addLog(`自动补领停止（${why}）。手动按钮仍可用。`);
    timers.forEach((t) => clearTimeout(t));
    timers.length = 0;
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
    if (fastIntervalId) { clearInterval(fastIntervalId); fastIntervalId = null; }
    cleanups.forEach((fn) => { try { fn(); } catch (e) {} });
    cleanups.length = 0;
  };

  // ---- 事件驱动补领：路由切换 / 个人面板出现 ----
  try {
    if (ctx.router && typeof ctx.router.afterEach === "function") {
      const off = ctx.router.afterEach(() => { tryAuto("路由切换"); });
      if (typeof off === "function") cleanups.push(off);
      addLog("已监听路由切换补领");
    }
  } catch (e) { /* 路由监听可选 */ }

  try {
    if (ctx.dom && typeof ctx.dom.observe === "function") {
      const selectors = [".user-profile", ".profile", ".personal", ".user-center", '[data-page="profile"]', '[data-route*="user"]'];
      selectors.forEach((sel) => {
        try {
          const ret = ctx.dom.observe(sel, () => { tryAuto("个人面板"); });
          if (typeof ret === "function") cleanups.push(ret);
          else if (ret && typeof ret.disconnect === "function") cleanups.push(() => ret.disconnect());
        } catch (e) { /* 单个选择器失败忽略 */ }
      });
      addLog("已监听个人面板出现补领");
    }
  } catch (e) { /* DOM监听可选 */ }

  // ---- 极速启动 + 兜底：打开即领，登录没好则2秒一轮紧追30秒，之后15秒一轮直到今日完成 ----
  let intervalId = null;
  let fastIntervalId = null;
  const MAX_TICKS = 60;
  let ticks = 0;
  // 打开软件立刻试一次，不等3秒
  tryAuto("启动");
  // 前30秒：2秒一轮，登录刚恢复就抓住，体感就是“打开即领”
  let fastTicks = 0;
  fastIntervalId = setInterval(() => {
    if (stopped) { if (fastIntervalId) { clearInterval(fastIntervalId); fastIntervalId = null; } return; }
    fastTicks += 1;
    if (fastTicks >= 15) { if (fastIntervalId) { clearInterval(fastIntervalId); fastIntervalId = null; } return; }
    tryAuto("极速补领");
  }, 2000);
  intervalId = setInterval(() => {
    ticks += 1;
    if (ticks >= MAX_TICKS) { stopAutoLoop("超过15分钟兜底窗口"); return; }
    tryAuto("定时补领");
  }, 15000);

  if (ctx && typeof ctx.dispose === "function") {
    try { ctx.dispose(() => stopAutoLoop("插件禁用/卸载")); } catch (e) {}
  }

  const SettingsPanel = defineComponent({
    setup() {
      return () => h("div", { style: "display: grid; gap: 12px;" }, [
        h("p", { style: "color: var(--color-text-secondary); font-size: 14px;" }, "启动后自动领取畅听会员并升级概念会员。支持登录延迟、路由切换、个人面板打开、定时多轮补领；今日完成后自动停止，手动按钮随时可用。"),
        h("p", { style: "font-size: 13px;" }, `状态：${statusText.value}`),
        h("div", { style: "display: flex; align-items: center; gap: 12px;" }, [
          Button ? h(Button, {
            onClick: () => doClaim(true),
            loading: claiming.value
          }, { default: () => "立即手动领取" }) : h("button", {
            onClick: () => doClaim(true),
            disabled: claiming.value,
            style: "padding: 6px 12px; background: var(--color-primary); color: white; border: none; border-radius: 4px; cursor: pointer;"
          }, "立即手动领取"),
        ]),
        h("div", {
          style: "background: var(--color-surface-variant); padding: 12px; border-radius: 8px; font-family: monospace; font-size: 12px; max-height: 200px; overflow-y: auto; white-space: pre-wrap;"
        }, logs.value.join("\n") || "暂无日志")
      ]);
    }
  });

  if (ctx.ui && ctx.ui.settings) {
    ctx.ui.settings.define({
      title: "自动领取 VIP",
      component: SettingsPanel,
    });
  }
}

export function deactivate() {
  // 资源已通过 ctx.dispose 清理，这里仅作兼容导出
}
