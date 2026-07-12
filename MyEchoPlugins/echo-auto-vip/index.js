export async function activate(ctx) {
  console.log("[Auto-VIP] 插件已启动，开始自动检测并领取会员...");
  
  try {
    let todayStr;
    try {
      const serverNow = await ctx.kugou.getServerNow();
      if (serverNow && serverNow.now) {
        todayStr = new Date(serverNow.now * 1000).toISOString().split('T')[0];
      }
    } catch (e) {
      console.warn("[Auto-VIP] 获取服务器时间失败，将使用本地时间", e);
    }
    
    if (!todayStr) {
      todayStr = new Date().toISOString().split('T')[0];
    }

    try {
      const tvipRes = await ctx.kugou.claimDayVip(todayStr);
      if (tvipRes && tvipRes.status === 1) {
        ctx.toast.success("🎉 畅听会员自动领取成功！");
      }
    } catch (e) {
      console.log("[Auto-VIP] 畅听会员领取跳过或已领取", e);
    }

    try {
      const svipRes = await ctx.kugou.upgradeDayVip();
      if (svipRes && svipRes.status === 1) {
        ctx.toast.success("🚀 概念会员自动升级成功！");
      }
    } catch (e) {
      console.log("[Auto-VIP] 概念会员升级跳过或已升级", e);
    }

  } catch (error) {
    console.error("[Auto-VIP] 自动领取流程发生异常:", error);
  }
}
