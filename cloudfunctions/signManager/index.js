// cloudfunctions/signManager/index.js
// 每日抽签配置服务
//
// 支持的 action：
//   getSigns      — 返回签文列表（从 signs 集合读取）
//   getSignConfig — 返回运营参数（从 sign_config 集合读取）
//   initDB        — 初始化所需集合（开发时调用一次）
//
// 签文文档结构（signs 集合）：
//   { _id, level, num, title, poem, joey, yiji, trend, question, isGood }
//
// 配置文档结构（sign_config 集合，_id = "default"）：
//   { maxDailyDraws, cooldownDays, publicAccount, videoAccount }

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

exports.main = async (event, context) => {
  const { action } = event
  try {
    switch (action) {
      case 'getSigns':      return await getSigns(event)
      case 'getSignConfig': return await getSignConfig()
      case 'initDB':        return await initDB()
      default: return { success: false, error: 'unknown action' }
    }
  } catch (e) {
    console.error('[signManager]', action, e)
    return { success: false, error: e.message }
  }
}

// ─────────────────────────────────────────────────────────────────
// getSigns — 返回签文列表
// 支持增量更新：客户端传 updatedAfter（时间戳）时只返回更新的签文
// ─────────────────────────────────────────────────────────────────
async function getSigns(event) {
  const { updatedAfter } = event
  const col = db.collection('signs')

  let query = col
  if (updatedAfter) {
    query = col.where({ updatedAt: db.command.gt(new Date(updatedAfter)) })
  }

  // 最多 200 条，一次拉完（签文不会太多）
  const res = await query.limit(200).get()
  return {
    success: true,
    signs: res.data,
    fetchedAt: Date.now(),
  }
}

// ─────────────────────────────────────────────────────────────────
// getSignConfig — 返回运营参数
// ─────────────────────────────────────────────────────────────────
async function getSignConfig() {
  const res = await db.collection('sign_config').doc('default').get().catch(() => null)
  if (res && res.data) {
    const { _id, _openid, ...config } = res.data
    return { success: true, config }
  }
  return { success: true, config: {} }
}

// ─────────────────────────────────────────────────────────────────
// initDB — 初始化集合（开发时调用一次）
// ─────────────────────────────────────────────────────────────────
async function initDB() {
  const collections = ['signs', 'sign_config']
  const results = []
  for (const name of collections) {
    try {
      await db.createCollection(name)
      results.push({ collection: name, status: '创建成功' })
    } catch (e) {
      if (e.errCode === -502003 || (e.message && e.message.includes('exist'))) {
        results.push({ collection: name, status: '已存在，跳过' })
      } else {
        results.push({ collection: name, status: '失败: ' + e.message })
      }
    }
  }
  return { success: true, results }
}
