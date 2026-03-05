// cloudfunctions/playerManager/index.js
// 玩家管理：登录注册 / 余额 / 管理员鉴权 / 搜索
// v1.1.0 + 内容安全合规（msgSecCheck / imgSecCheck）

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const players  = db.collection('players')
const logs     = db.collection('game_logs')
const secLogs  = db.collection('security_logs')  // 违规记录

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
      default:
        return { success: false, error: 'unknown action' }
    }
  } catch (e) {
    console.error('[playerManager]', action, e)
    return { success: false, error: e.message }
  }
}

// ─────────────────────────────────────────────────────
// 内容安全：文字检测（昵称等用户输入）
// 返回 true = 安全，false = 违规
// ─────────────────────────────────────────────────────
async function checkText(content, openid) {
  if (!content || !content.trim()) return true

  try {
    const res = await cloud.openapi.security.msgSecCheck({
      content: content.trim(),
      openid,
      scene: 2,  // 2=个人资料，1=评论，3=论坛，4=社交日志
      version: 2,
    })
    // result.suggest: pass/risky/review
    // result.label: 违规分类码（20001赌博 20002涉政 20006色情 等）
    const suggest = res.result && res.result.suggest
    if (suggest === 'risky') {
      console.warn('[Security] msgSecCheck risky:', content, 'openid:', openid, 'label:', res.result.label)
      await _logViolation({ type: 'text', content, openid, label: res.result.label, suggest })
      return false
    }
    if (suggest === 'review') {
      // 需人工复审：此处保守策略=拦截，可改为放行后人工处理
      console.warn('[Security] msgSecCheck review:', content, 'openid:', openid)
      await _logViolation({ type: 'text', content, openid, label: res.result.label, suggest })
      return false
    }
    return true  // pass
  } catch (e) {
    // API调用失败时保守放行，避免误伤，但记录日志
    console.error('[Security] msgSecCheck error:', e.errCode, e.errMsg)
    if (e.errCode === 87014) {
      // 87014 = 内容含有违法违规内容，直接拦截
      await _logViolation({ type: 'text', content, openid, label: 87014, suggest: 'risky' })
      return false
    }
    return true
  }
}

// ─────────────────────────────────────────────────────
// 内容安全：图片检测（头像 URL）
// 仅当用户传入自定义头像URL时调用
// ─────────────────────────────────────────────────────
async function checkImage(avatarUrl, openid) {
  if (!avatarUrl) return true
  // 微信官方头像域名无需检测（thirdwx.qlogo.cn / wx.qlogo.cn）
  if (avatarUrl.includes('qlogo.cn')) return true

  try {
    // imgSecCheck 需要传 Buffer，先 fetch 图片内容
    const axios = require('axios')
    const response = await axios.get(avatarUrl, {
      responseType: 'arraybuffer',
      timeout: 5000,
    })
    const imgBuffer = Buffer.from(response.data)

    const res = await cloud.openapi.security.imgSecCheck({
      media: {
        contentType: 'image/jpeg',
        value: imgBuffer,
      },
      openid,
      scene: 1,  // 1=资料图片
      version: 2,
    })
    const suggest = res.result && res.result.suggest
    if (suggest === 'risky' || suggest === 'review') {
      console.warn('[Security] imgSecCheck risky/review:', avatarUrl, 'openid:', openid)
      await _logViolation({ type: 'image', content: avatarUrl, openid, label: res.result.label, suggest })
      return false
    }
    return true
  } catch (e) {
    console.error('[Security] imgSecCheck error:', e.errCode || e.message)
    // 图片获取失败或API失败，保守放行
    return true
  }
}

// ─────────────────────────────────────────────────────
// 违规记录写入（供管理员查阅）
// ─────────────────────────────────────────────────────
async function _logViolation({ type, content, openid, label, suggest }) {
  await secLogs.add({
    data: {
      type,          // 'text' | 'image'
      content,       // 违规内容（文字原文或图片URL）
      openid,
      label,         // 违规分类码
      suggest,       // risky / review
      handled: false,
      createdAt: db.serverDate(),
    }
  }).catch(() => {})  // 日志写失败不影响主流程
}

// ─────────────────────────────────────────────────────
// 登录注册（接入内容安全检测）
// ─────────────────────────────────────────────────────
async function login(event, openid) {
  const { nickname, avatarUrl } = event
  const now = db.serverDate()

  // ── 昵称安全检测 ──────────────────────────────────
  if (nickname && nickname.trim()) {
    const textSafe = await checkText(nickname, openid)
    if (!textSafe) {
      return {
        success: false,
        blocked: true,
        error: '昵称含有不当内容，请修改后重试',
      }
    }
  }

  // ── 头像安全检测（非微信官方头像时）──────────────
  if (avatarUrl && !avatarUrl.includes('qlogo.cn')) {
    const imgSafe = await checkImage(avatarUrl, openid)
    if (!imgSafe) {
      return {
        success: false,
        blocked: true,
        error: '头像含有不当内容，请更换头像后重试',
      }
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
        balance: 100,          // 首次联机赠送 100 点
        gamesPlayed: 0,
        firstOnlineGift: true, // 已领取首次赠礼标记
        createdAt: now,
        lastSeen: now,
      }
    })
    return { success: true, openid, balance: 100, nickname: defaultNickname, isNew: true, gift: 100 }
  } else {
    await players.doc(openid).update({
      data: {
        nickname: nickname || existing.data.nickname,
        avatarUrl: avatarUrl || existing.data.avatarUrl,
        lastSeen: now,
      }
    })
    return {
      success: true,
      openid,
      balance: existing.data.balance,
      nickname: existing.data.nickname,
      avatarUrl: existing.data.avatarUrl || '',
      isNew: false,
    }
  }
}

// ─────────────────────────────────────────
async function getPlayer(openid) {
  const res = await players.doc(openid).get()
  return { success: true, ...res.data }
}

// ─────────────────────────────────────────
async function adminLogin(event) {
  const { password } = event
  if (!password) return { success: false }
  const hash = crypto.createHash('sha256').update(password).digest('hex')
  if (hash === ADMIN_PASSWORD_HASH) return { success: true }
  return { success: false }
}

// ─────────────────────────────────────────
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

// ─────────────────────────────────────────
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

// ─────────────────────────────────────────
async function getRecentLogs(event) {
  const { limit = 20 } = event
  const res = await logs
    .orderBy('createdAt', 'desc')
    .limit(Math.min(limit, 50))
    .get()
  return { success: true, logs: res.data }
}