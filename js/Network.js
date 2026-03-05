// js/Network.js
// 联机层：微信云开发 + 云数据库实时监听
// v1.1.0

const DB_ENV = 'cloud1-0gqcenjqfe77a332'  // ← 替换为你的云开发环境ID

// db 和 rooms 懒加载，只有真正联机时才初始化，不影响本地单机版
let _db = null
let _rooms = null

function getDB() {
  if (!_db) {
    wx.cloud.init({ env: DB_ENV, traceUser: true })
    _db = wx.cloud.database()
    _rooms = _db.collection('rooms')
  }
  return { db: _db, rooms: _rooms }
}

// ─────────────────────────────────────────
// 活动码生成（苏X99 格式）
// ─────────────────────────────────────────
// 生成5位随机房间号（玩家可见部分）
function generateRoomCode() {
  return String(Math.floor(Math.random() * 90000) + 10000)
}

// 当日日期前缀，格式 YYYYMMDD
function todayPrefix() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

// 内部唯一ID = 日期-房间号，e.g. "20260303-36721"
function buildRoomId(code) {
  return `${todayPrefix()}-${code}`
}

// ─────────────────────────────────────────
class Network {
  constructor() {
    this.openid = null
    this.nickname = null
    this.avatarUrl = null
    this.currentRoomId = null
    this._watcher = null
    this.onRoomUpdate = null   // 外部绑定：(roomData) => void
    this.onError = null        // 外部绑定：(msg) => void
  }

  // ── 1. 登录并同步玩家信息 ──────────────────────
  async login(collectNickname, onStartLoading) {
    getDB()

    // 第一步：先弹昵称页（不依赖 openid）
    if (typeof collectNickname === 'function') {
      const result = await collectNickname()
      this.nickname = result.nickname || ''
      this.avatarUrl = result.avatarUrl || ''
    }

    // 昵称收集完毕，显示 loading
    if (typeof onStartLoading === 'function') onStartLoading()

    // 第二步：登录云函数（拿 openid + 同步昵称一步完成）
    const fallbackNick = this.nickname || ''
    console.log('[Network] login start, nickname=', this.nickname)

    // 同步昵称到云端
    try {
      const res = await wx.cloud.callFunction({
        name: 'playerManager',
        data: {
          action: 'login',
          nickname: this.nickname,
          avatarUrl: this.avatarUrl,
        }
      })
      if (res.result.blocked) {
        throw new Error(res.result.error || '内容安全检测未通过')
      }
      this.openid = res.result.openid
      // 昵称以本地输入为准，为空时才用 openid 后6位兜底
      if (!this.nickname) this.nickname = this.openid.slice(-6)
      // 头像同理，本地选的优先
      if (!this.avatarUrl && res.result.avatarUrl) this.avatarUrl = res.result.avatarUrl
      // 首次赠礼提示
      if (res.result.gift) {
        wx.showToast({ title: `🎁 首次联机赠送 ${res.result.gift} 点！`, icon: 'none', duration: 2500 })
      }
      // 写入缓存（唯一写入点）
      try {
        wx.setStorageSync('userProfile', {
          nickname: this.nickname,
          avatarUrl: this.avatarUrl || '',
        })
      } catch(e) {}
      return res.result
    } catch (e) {
      console.error('[Network] login failed', e)
      throw e
    }
  }

  // ── 2. 获取本地玩家余额 ─────────────────────────
  async getMyBalance() {
    const res = await wx.cloud.callFunction({
      name: 'playerManager',
      data: { action: 'getPlayer', openid: this.openid }
    })
    return res.result.balance
  }

  // ── 3. 创建房间 ────────────────────────────────
  async createRoom({ stake = 10, maxPlayers = 6 } = {}) {
    // 生成5位房间号，重试确保不碰撞
    let roomCode
    let roomId
    let tries = 0
    while (tries < 10) {
      roomCode = generateRoomCode()
      roomId = buildRoomId(roomCode)
      const exists = await getDB().rooms.doc(roomId).get().catch(() => null)
      if (!exists) break
      tries++
    }

    const res = await wx.cloud.callFunction({
      name: 'roomManager',
      data: {
        action: 'createRoom',
        roomCode,       // 5位，玩家可见
        roomId,         // 日期-房间号，数据库唯一ID
        stake,
        maxPlayers,
        hostOpenid: this.openid,
        nickname: this.nickname,
        avatarUrl: this.avatarUrl,
      }
    })

    if (res.result.success) {
      this.currentRoomId = roomId
      this.currentRoomCode = roomCode
      this._watchRoom(roomId)
    }
    return res.result
  }

  // ── 4. 加入房间 ────────────────────────────────
  async joinRoom(inputCode) {
    const roomCode = inputCode.trim()
    // 用5位房间号 + 今日日期拼出内部ID
    const roomId = buildRoomId(roomCode)

    const res = await wx.cloud.callFunction({
      name: 'roomManager',
      data: {
        action: 'joinRoom',
        roomCode,
        roomId,
        openid: this.openid,
        nickname: this.nickname,
        avatarUrl: this.avatarUrl,
      }
    })

    if (res.result.success) {
      this.currentRoomId = roomId
      this.currentRoomCode = roomCode
      this._watchRoom(roomId)
    }
    return res.result
  }

  // ── 5. 摇骰子（只有当前玩家可操作）──────────────
  async rollDice(diceValues) {
    if (!this.currentRoomId) return
    return wx.cloud.callFunction({
      name: 'roomManager',
      data: {
        action: 'rollDice',
        roomId: this.currentRoomId,
        openid: this.openid,
        diceValues,
      }
    })
  }

  // ── 6. 结算并进入下一回合 ────────────────────────
  async nextTurn() {
    if (!this.currentRoomId) return
    return wx.cloud.callFunction({
      name: 'roomManager',
      data: {
        action: 'nextTurn',
        roomId: this.currentRoomId,
        openid: this.openid,
      }
    })
  }

  // ── 7. 离开房间 ────────────────────────────────
  // 中途结束游戏
  async abortGame() {
    const res = await wx.cloud.callFunction({
      name: 'roomManager',
      data: { action: 'abortGame', roomId: this.currentRoomId }
    })
    return res.result
  }

  // 添加机器人
  async addBot() {
    const res = await wx.cloud.callFunction({
      name: 'roomManager',
      data: {
        action: 'addBot',
        roomId: this.currentRoomId,
        hostOpenid: this.openid,
      }
    })
    return res.result
  }

  // 房主开始游戏
  async startGame() {
    const res = await wx.cloud.callFunction({
      name: 'roomManager',
      data: {
        action: 'startGame',
        roomId: this.currentRoomId,
        openid: this.openid,
      }
    })
    return res.result
  }

  async leaveRoom() {
    if (!this.currentRoomId) return
    this._stopWatch()
    await wx.cloud.callFunction({
      name: 'roomManager',
      data: {
        action: 'leaveRoom',
        roomId: this.currentRoomId,
        openid: this.openid,
      }
    })
    this.currentRoomId = null
    this.currentRoomCode = null
  }

  // ── 内部：实时监听房间变化 ─────────────────────
  _watchRoom(roomId) {
    this._stopWatch()
    this._watchRetries = (this._watchRetries || 0)
    clearTimeout(this._watchRetryTimer)

    try {
      this._watcher = getDB().rooms.doc(roomId).watch({
        onChange: (snapshot) => {
          this._watchRetries = 0  // 收到数据说明连接正常，重置重试计数
          const doc = snapshot.docs[0]
          if (doc && this.onRoomUpdate) {
            this.onRoomUpdate(doc)
          }
        },
        onError: (err) => {
          console.error('[Network] watch error', err)
          this._stopWatch()  // 先彻底关掉旧的 watcher

          this._watchRetries++
          if (this._watchRetries > 10) {
            // 超过10次放弃，通知用户
            if (this.onError) this.onError('网络连接已断开，请退出重进')
            return
          }
          // 指数退避：1s 2s 4s 8s ... 最大16s
          const delay = Math.min(1000 * Math.pow(2, this._watchRetries - 1), 16000)
          this._watchRetryTimer = setTimeout(() => this._watchRoom(roomId), delay)
        }
      })
    } catch(e) {
      console.error('[Network] watch init fail', e)
      this._watchRetries++
      const delay = Math.min(1000 * Math.pow(2, this._watchRetries - 1), 16000)
      this._watchRetryTimer = setTimeout(() => this._watchRoom(roomId), delay)
    }
  }

  _stopWatch() {
    clearTimeout(this._watchRetryTimer)
    if (this._watcher) {
      try { this._watcher.close() } catch(e) {}
      this._watcher = null
    }
  }

  // ── 工具：当前用户是否是该轮玩家 ───────────────
  isMyTurn(roomData) {
    const p = roomData.players[roomData.currentPlayerIndex]
    return p && p.openid === this.openid
  }
}
module.exports = { Network }