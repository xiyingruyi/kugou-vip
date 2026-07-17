export function activate(ctx) {
  const { defineComponent, h, ref } = ctx.vue;
  let Button;
  if (ctx.ui && ctx.ui.components && ctx.ui.components.Button) {
    Button = ctx.vue.defineAsyncComponent(ctx.ui.components.Button);
  }

  const claiming = ref(false);
  const logs = ref([]);

  const addLog = (msg) => {
    const time = new Date().toLocaleTimeString();
    logs.value.push(`[${time}] ${msg}`);
    console.log(`[Auto-VIP] ${msg}`);
  };

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

  let hasRunThisSession = false;

  const doClaim = async (isManual = false) => {
    if (claiming.value) return;
    if (!isManual && hasRunThisSession) {
      addLog("本会话已执行过，跳过自动执行。");
      return;
    }
    hasRunThisSession = true;
    claiming.value = true;
    
    if (isManual) {
      addLog("手动触发领取流程...");
    } else {
      addLog("启动自动领取流程...");
    }

    try {
      if (!ctx.kugou) {
        throw new Error("插件未声明或未获取酷狗API能力");
      }

      const today = await getServerToday();
      addLog(`使用日期: ${today}`);
      let success = false;

      // 1. 尝试领取畅听VIP
      try {
        const tvipRes = await ctx.kugou.user.claimDayVip(today);
        if (tvipRes && tvipRes.status === 1) {
          success = true;
          addLog("🎉 畅听会员自动领取成功！");
          ctx.toast.success("🎉 畅听会员自动领取成功！");
        } else if (tvipRes && tvipRes.error_code) {
          addLog(`畅听会员领取跳过，状态码: ${tvipRes.error_code}`);
        }
      } catch (e) {
        addLog(`畅听会员领取请求失败或已领取: ${e.message}`);
      }

      // 【关键修复】增加延时，给酷狗服务器同步状态的时间
      if (!isManual) {
        addLog("等待2秒同步服务器状态...");
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      // 2. 尝试升级概念VIP
      try {
        const svipRes = await ctx.kugou.user.upgradeDayVip();
        if (svipRes && svipRes.status === 1) {
          success = true;
          addLog("🚀 概念会员自动升级成功！");
          ctx.toast.success("🚀 概念会员自动升级成功！");
        } else if (svipRes && svipRes.error_code) {
          addLog(`概念会员升级跳过，状态码: ${svipRes.error_code}`);
        }
      } catch (e) {
        addLog(`概念会员升级请求失败或已升级: ${e.message}`);
      }

      // 3. 如果成功，刷新用户信息
      if (success) {
        try {
          await ctx.kugou.user.getUserDetail();
          await ctx.kugou.user.getUserVipDetail();
          addLog("已刷新用户VIP信息");
        } catch (e) {
          addLog("刷新用户信息失败");
        }
      } else {
        if (isManual) {
          ctx.toast.info("今日已领取过或当前状态无需领取");
        }
        addLog("执行完毕，今日可能已领取。");
      }
    } catch (error) {
      addLog(`执行异常: ${error.message}`);
    } finally {
      claiming.value = false;
    }
  };

  const SettingsPanel = defineComponent({
    setup() {
      return () => h("div", { style: "display: grid; gap: 12px;" }, [
        h("p", { style: "color: var(--color-text-secondary); font-size: 14px;" }, "此插件已完美复刻 EchoMusic v2.2.8-beta.5 中的原生自动领VIP逻辑。启动时自动执行，如遇未登录可稍后手动点击领取。"),
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

  // 【关键修复】优化启动执行逻辑，等待登录态就绪而不是死板的5秒
  const initAutoClaim = async () => {
    let isReady = false;
    // 尝试最多等待 15 秒
    for (let i = 0; i < 5; i++) {
      try {
        // 通过调用 getUserDetail 测试登录态是否就绪
        const res = await ctx.kugou.user.getUserDetail();
        if (res && res.status === 1) {
          isReady = true;
          break;
        }
      } catch (e) {
        // 尚未登录或报错，继续等待
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    // 如果就绪，执行领取
    if (isReady) {
      doClaim(false);
    } else {
      addLog("未检测到登录态，自动领取已取消。请在登录后手动领取。");
    }
  };

  initAutoClaim();
}
