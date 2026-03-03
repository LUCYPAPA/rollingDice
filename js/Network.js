// js/Network.js
// 联机层：微信云开发 + 云数据库实时监听
// v1.1.0

const DB_ENV = 'cloud1-0gw8283g4b8815c5'  // ← 替换为你的云开发环境ID

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
export class Network {
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
  // 小游戏无法用 getUserProfile，直接用云函数拿 openid
  // 昵称/头像让玩家在设置页自己填，或用 openid 后6位作默认昵称
  async login() {
    // 第一次调用时才初始化云开发，本地单机完全不触碰这里
    getDB()
    try {
      const res = await wx.cloud.callFunction({
        name: 'playerManager',
        data: {
          action: 'login',
          nickname: this.nickname || '',
          avatarUrl: this.avatarUrl || '',
        }
      })
      // 内容安全拦截
      if (res.result.blocked) {
        throw new Error(res.result.error || '内容安全检测未通过')
      }
      this.openid = res.result.openid
      if (res.result.nickname) this.nickname = res.result.nickname
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
    this._watcher = getDB().rooms.doc(roomId).watch({
      onChange: (snapshot) => {
        const doc = snapshot.docs[0]
        if (doc && this.onRoomUpdate) {
          this.onRoomUpdate(doc)
        }
      },
      onError: (err) => {
        console.error('[Network] watch error', err)
        if (this.onError) this.onError('网络断开，请重新连接')
        // 3秒后自动重连
        setTimeout(() => this._watchRoom(roomId), 3000)
      }
    })
  }

  _stopWatch() {
    if (this._watcher) {
      this._watcher.close()
      this._watcher = null
    }
  }

  // ── 工具：当前用户是否是该轮玩家 ───────────────
  isMyTurn(roomData) {
    const p = roomData.players[roomData.currentPlayerIndex]
    return p && p.openid === this.openid
  }
}