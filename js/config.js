// js/config.js
// 游戏配置：本地默认值 + 云端热更新支持
//
// 远程配置存放在 Cloud Base game_config 集合，文档 ID = "default"
// 应用启动时调用 loadRemoteConfig() 拉取，覆盖本地默认值
// 不发版即可修改的配置项都在 GAME_CONFIG 里

const CLOUD_ENV = 'cloud1-0gqcenjqfe77a332'

const GAME_CONFIG = {
  // ── 游戏规则 ──────────────────────────────────────────────────────
  defaultStake: 32,          // 单机版默认底注
  stakeOptions: [16, 32, 50, 100],  // 创建房间可选底注
  defaultMaxPlayers: 6,      // 房间最大人数
  newPlayerGift: 100,        // 新玩家首次赠礼

  // ── 时序控制 ──────────────────────────────────────────────────────
  autoRollSeconds: 60,       // 自动摇骰倒计时（秒）
  welcomeCardDuration: 3000, // 欢迎卡显示时长（毫秒）
  botRollDelay: 1200,        // 机器人摇骰前等待时长（毫秒）
  botNextDelay: 2000,        // 机器人摇完后触发下一步的等待（毫秒）
  serverRollTimeout: 7000,   // 联机摇骰等待服务端超时（毫秒）
  stuckDetectionMs: 3000,    // 卡死兜底检测阈值（毫秒）
  shakeThrottle: 1500,       // 摇一摇防抖间隔（毫秒）

  // ── UI 参数 ───────────────────────────────────────────────────────
  shakeForceThreshold: 2.0,  // 触发摇一摇的加速度阈值
}

// 运行时合并后的配置（通过 getConfig() 获取）
let _resolved = { ...GAME_CONFIG }
let _loaded = false

/**
 * 从云数据库拉取远程配置，合并到本地默认值上
 * 在 app.js onLaunch 中调用；失败时静默降级到本地默认值
 */
async function loadRemoteConfig() {
  try {
    const res = await wx.cloud.callFunction({
      name: 'roomManager',
      data: { action: 'getConfig' },
    })
    if (res.result && res.result.config) {
      _resolved = { ...GAME_CONFIG, ...res.result.config }
    }
  } catch (e) {
    console.warn('[Config] 远程配置加载失败，使用本地默认值', e)
  }
  _loaded = true
}

/** 获取当前合并后的配置（同步） */
function getConfig() {
  return _resolved
}

module.exports = { CLOUD_ENV, GAME_CONFIG, loadRemoteConfig, getConfig }
