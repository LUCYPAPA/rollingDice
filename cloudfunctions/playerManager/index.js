// cloudfunctions/playerManager/index.js
// v1.2.0
// 改动说明：
//   1. 新增 getMyGames     — 玩家查自己参与过的对局列表（手气记录）
//   2. 新增 getMyGameSummary — 玩家查某局自己的余额变动摘要（不含完整 events）
//   3. adminGetGameDetail  — 管理员可查任意局完整明细（补充 roomManager 的房主鉴权）
//   4. login               — 首次赠礼提示保持不变，老用户昵称/头像更新逻辑不变

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const players  = db.collection('players')
const logs     = db.collection('game_logs')
const secLogs  = db.collection('security_logs')

const ADMIN_PASSWORD_HASH = 'REPLACE_WITH_YOUR_SHA256_HASH'

exports.main = async (event, context) => {
  const { action } = event
  const { OPENID } = cloud.getWXContext()

  try {
    switch (action) {
      case 'login':               return await login(event, OPENID)
      case 'getPlayer':           return await getPlayer(OPENID)
      case 'adminLogin':          return await adminLogin(event)
      case 'searchPlayers':       return await searchPlayers(event, OPENID)
      case 'adminUpdateBalance':  return await adminUpdateBalance(event, OPENID)
      case 'getRecentLogs':       return await getRecentLogs(event)
      case 'getMyGames':          return await getMyGames(event, OPENID)       // 新增
      case 'getMyGameSummary':    return await getMyGameSummary(event, OPENID) // 新增
      case 'adminGetGameDetail':  return await adminGetGameDetail(event, OPENID) // 新增
      default:
        return { success: false, error: 'unknown action' }
    }
  } catch (e) {
    console.error('[playerManager]', action, e)
    return { success: false, error: e.message }
  }
}

// ─────────────────────────────────────────────────────────────────
// 内容安全：文字检测
// ─────────────────────────────────────────────────────────────────
async function checkText(content, openid) {
  if (!content || !content.trim()) return true
  try {
    const res = await cloud.openapi.security.msgSecCheck({
      content: content.trim(),
      openid,
      scene: 2,
      version: 2,
    })
    const suggest = res.result && res.result.suggest
    if (suggest === 'risky' || suggest === 'review') {
      console.warn('[Security] msgSecCheck:', content, suggest)
      await _logViolation({ type: 'text', content, openid, label: res.result.label, suggest })
      return false
    }
    return true
  } catch (e) {
    console.error('[Security] msgSecCheck error:', e.errCode, e.errMsg)
    if (e.errCode === 87014) {
      await _logViolation({ type: 'text', content, openid, label: 87014, suggest: 'risky' })
      return false
    }
    return true
  }
}

// ─────────────────────────────────────────────────────────────────
// 内容安全：图片检测
// ─────────────────────────────────────────────────────────────────
async function checkImage(avatarUrl, openid) {
  if (!avatarUrl) return true
  if (avatarUrl.includes('qlogo.cn')) return true
  try {
    const axios = require('axios')
    const response = await axios.get(avatarUrl, {
      responseType: 'arraybuffer',
      timeout: 5000,
    })
    const imgBuffer = Buffer.from(response.data)
    const res = await cloud.openapi.security.imgSecCheck({
      media: { contentType: 'image/jpeg', value: imgBuffer },
      openid,
      scene: 1,
      version: 2,
    })
    const suggest = res.result && res.result.suggest
    if (suggest === 'risky' || suggest === 'review') {
      await _logViolation({ type: 'image', content: avatarUrl, openid, label: res.result.label, suggest })
      return false
    }
    return true
  } catch (e) {
    console.error('[Security] imgSecCheck error:', e.errCode || e.message)
    return true
  }
}

async function _logViolation({ type, content, openid, label, suggest }) {
  await secLogs.add({
    data: { type, content, openid, label, suggest, handled: false, createdAt: db.serverDate() }
  }).catch(() => {})
}

// ─────────────────────────────────────────────────────────────────
// login — 首次赠 100 点，老用户更新昵称/头像
// ─────────────────────────────────────────────────────────────────
async function login(event, openid) {
  const { nickname, avatarUrl } = event
  const now = db.serverDate()

  if (nickname && nickname.trim()) {
    const textSafe = await checkText(nickname, openid)
    if (!textSafe) {
      return { success: false, blocked: true, error: '昵称含有不当内容，请修改后重试' }
    }
  }

  if (avatarUrl && !avatarUrl.includes('qlogo.cn')) {
    const imgSafe = await checkImage(avatarUrl, openid)
    if (!imgSafe) {
      return { success: false, blocked: true, error: '头像含有不当内容，请更换头像后重试' }
    }
  }

  const existing = await players.doc(openid).get().catch(() => null)

  if (!existing) {
    const defaultNickname = nickname || ('玩家' + openid.slice(-6))
    await players.add({
      data: {
        _id: openid,
        openid,
        nickname: defaultNickname,
        avatarUrl: avatarUrl || '',
        balance: 100,
        gamesPlayed: 0,
        firstOnlineGift: true,
        createdAt: now,
        lastSeen: now,
      }
    })
    return { success: true, openid, balance: 100, nickname: defaultNickname, isNew: true, gift: 100 }
  } else {
    // 老用户：更新昵称和头像，同时更新本地缓存所需字段
    const updatedNickname = nickname || existing.data.nickname
    const updatedAvatar   = avatarUrl || existing.data.avatarUrl
    await players.doc(openid).update({
      data: {
        nickname: updatedNickname,
        avatarUrl: updatedAvatar,
        lastSeen: now,
      }
    })
    return {
      success: true,
      openid,
      balance: existing.data.balance,
      nickname: updatedNickname,
      avatarUrl: updatedAvatar,
      isNew: false,
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// getPlayer
// ─────────────────────────────────────────────────────────────────
async function getPlayer(openid) {
  const res = await players.doc(openid).get()
  return { success: true, ...res.data }
}

// ─────────────────────────────────────────────────────────────────
// adminLogin
// ─────────────────────────────────────────────────────────────────
async function adminLogin(event) {
  const { password } = event
  if (!password) return { success: false }
  const hash = crypto.createHash('sha256').update(password).digest('hex')
  if (hash === ADMIN_PASSWORD_HASH) return { success: true }
  return { success: false }
}

// ─────────────────────────────────────────────────────────────────
// searchPlayers（管理员）
// ─────────────────────────────────────────────────────────────────
async function searchPlayers(event, adminOpenid) {
  const { query } = event
  if (!query) return { success: true, players: [] }

  let results = []
  const byId = await players.doc(query).get().catch(() => null)
  if (byId) results.push(byId.data)

  if (results.length === 0) {
    const byName = await players
      .where({ nickname: db.RegExp({ regexp: query, options: 'i' }) })
      .limit(20)
      .get()
    results = byName.data
  }

  const safe = results.map(p => ({
    openid: p.openid,
    nickname: p.nickname,
    avatarUrl: p.avatarUrl,
    balance: p.balance,
    gamesPlayed: p.gamesPlayed,
    lastSeen: p.lastSeen,
  }))

  return { success: true, players: safe }
}

// ─────────────────────────────────────────────────────────────────
// adminUpdateBalance（管理员）
// ─────────────────────────────────────────────────────────────────
async function adminUpdateBalance(event, adminOpenid) {
  const { targetOpenid, delta, reason } = event
  if (typeof delta !== 'number') return { success: false, error: '无效数值' }
  if (Math.abs(delta) > 100000) return { success: false, error: '单次变动不可超过10万点' }

  const targetRes = await players.doc(targetOpenid).get()
  const current = targetRes.data.balance
  const newBalance = current + delta
  if (newBalance < 0) return { success: false, error: '余额不足，操作后将为负数' }

  await players.doc(targetOpenid).update({ data: { balance: _.inc(delta) } })

  await db.collection('admin_logs').add({
    data: {
      adminOpenid, targetOpenid, delta,
      balanceBefore: current, balanceAfter: newBalance,
      reason: reason || '管理员操作',
      createdAt: db.serverDate(),
    }
  })

  return { success: true, newBalance }
}

// ─────────────────────────────────────────────────────────────────
// getRecentLogs（管理员后台用）
// ─────────────────────────────────────────────────────────────────
async function getRecentLogs(event) {
  const { limit = 20 } = event
  const res = await logs
    .orderBy('createdAt', 'desc')
    .limit(Math.min(limit, 50))
    .get()
  return { success: true, logs: res.data }
}

// ─────────────────────────────────────────────────────────────────
// getMyGames — 新增：玩家查自己参与过的对局列表（手气记录）
// ─────────────────────────────────────────────────────────────────
async function getMyGames(event, openid) {
  const { limit = 20, skip = 0 } = event

  // game_logs 里 players 数组存的是 openid 列表
  const res = await logs
    .where({ players: db.command.all([openid]) })
    .orderBy('createdAt', 'desc')
    .skip(skip)
    .limit(Math.min(limit, 50))
    .get()

  // 只返回列表卡片所需字段，不含 events 明细
  const list = res.data.map(log => {
    // 找到自己在这局的余额变动
    const myRow = (log.verifyRows || []).find(r => r.openid === openid)
    const myDetail = (log.playerDetails || []).find(r => r.openid === openid)

    return {
      roomId: log.roomId,
      roomCode: log.roomCode,
      createdAt: log.createdAt,
      finishedAt: log.finishedAt,
      endReason: log.endReason || null,
      // 参与玩家昵称列表（不含机器人，最多6个）
      playerNicknames: (log.playerDetails || [])
        .filter(p => !p.isBot)
        .slice(0, 6)
        .map(p => p.nickname),
      // 自己的余额变动
      balanceBefore: myRow ? myRow.balanceBefore : (myDetail ? myDetail.initialBalance : null),
      balanceAfter: myRow ? myRow.balanceAfter : null,
      earned: myRow ? myRow.earnedInGame : null,
    }
  })

  return { success: true, list }
}

// ─────────────────────────────────────────────────────────────────
// getMyGameSummary — 新增：玩家查某局自己的余额变动摘要
// 只返回和自己相关的 verifyRow，不暴露其他人的明细或完整 events
// ─────────────────────────────────────────────────────────────────
async function getMyGameSummary(event, openid) {
  const { roomId } = event

  const logRes = await logs.doc(roomId).get().catch(() => null)
  if (!logRes) return { success: false, error: '记录不存在' }
  const log = logRes.data

  // 确认该玩家确实参与了这局
  const participated = (log.players || []).includes(openid)
  if (!participated) return { success: false, error: '你未参与该对局' }

  const myRow = (log.verifyRows || []).find(r => r.openid === openid)
  const myDetail = (log.playerDetails || []).find(r => r.openid === openid)

  // 返回自己的摘要 + 本局基本信息 + 参与玩家列表（仅昵称和赛后余额，不含openid）
  return {
    success: true,
    summary: {
      roomCode: log.roomCode,
      createdAt: log.createdAt,
      finishedAt: log.finishedAt,
      endReason: log.endReason,
      myBalance: {
        before: myRow ? myRow.balanceBefore : (myDetail ? myDetail.initialBalance : null),
        after: myRow ? myRow.balanceAfter : null,
        earned: myRow ? myRow.earnedInGame : null,
        poolShare: myRow ? myRow.poolShare : 0,
      },
      // 其他玩家：只露昵称+赛后余额，排行用，不含openid
      otherPlayers: (log.verifyRows || [])
        .filter(r => r.openid !== openid && !r.isBot)
        .map(r => ({ nickname: r.nickname, balanceAfter: r.balanceAfter }))
        .sort((a, b) => b.balanceAfter - a.balanceAfter),
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// adminGetGameDetail — 新增：管理员查任意局完整明细
// 管理员身份由前端先调 adminLogin 验证，此处信任调用方
// 实际部署时可加管理员 openid 白名单做双重保护
// ─────────────────────────────────────────────────────────────────
async function adminGetGameDetail(event, openid) {
  const { roomId } = event

  const logRes = await logs.doc(roomId).get().catch(() => null)
  if (!logRes) return { success: false, error: '记录不存在' }

  return { success: true, detail: logRes.data }
}