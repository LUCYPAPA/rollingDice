// js/Network.js
// v1.2.0
// 改动说明：
//   1. login — 回传新字段透传给调用方（nickname/avatarUrl 同步修正）
//   2. 新增 getMyGames     — 玩家手气记录列表
//   3. 新增 getMyGameSummary — 玩家某局摘要
//   4. 新增 getHostGames   — 房主对局列表
//   5. 新增 getGameDetail  — 房主查某局完整明细
//   6. 新增 adminGetGameDetail — 管理员查任意局明细

let _db = null
let _rooms = null

function getDB() {
  if (!_db) {
    // wx.cloud 已在 app.js onLaunch 中初始化，此处直接使用
    _db = wx.cloud.database()
    _rooms = _db.collection('rooms')
  }
  return { db: _db, rooms: _rooms }
}

function generateRoomCode() {
  return String(Math.floor(Math.random() * 90000) + 10000)
}

function todayPrefix() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function buildRoomId(code) {
  return `${todayPrefix()}-${code}`
}

class Network {
  constructor() {
    this.openid      = null
    this.nickname    = null
    this.avatarUrl   = null
    this.currentRoomId   = null
    this.currentRoomCode = null
    this._watcher    = null
    this._watchRetries   = 0
    this._watchRetryTimer = null
    this.onRoomUpdate = null
    this.onError      = null
  }

  // ── 1. 登录 ────────────────────────────────────────────────────
  async login(collectNickname, onStartLoading) {
    getDB()

    if (typeof collectNickname === 'function') {
      const result = await collectNickname()
      this.nickname  = result.nickname  || ''
      this.avatarUrl = result.avatarUrl || ''
    }

    if (typeof onStartLoading === 'function') onStartLoading()

    try {
      const res = await wx.cloud.callFunction({
        name: 'playerManager',
        data: {
          action: 'login',
          nickname:  this.nickname,
          avatarUrl: this.avatarUrl,
        }
      })

      if (res.result.blocked) {
        throw new Error(res.result.error || '内容安全检测未通过')
      }

      this.openid = res.result.openid

      // 改动：老用户以云端返回值为准，修正本地缓存不一致问题
      if (res.result.nickname)  this.nickname  = res.result.nickname
      if (res.result.avatarUrl) this.avatarUrl = res.result.avatarUrl
      if (!this.nickname) this.nickname = this.openid.slice(-6)

      if (res.result.gift) {
        wx.showToast({ title: `🎁 首次联机赠送 ${res.result.gift} 点！`, icon: 'none', duration: 2500 })
      }

      // 写缓存（唯一写入点）
      try {
        wx.setStorageSync('userProfile', {
          nickname:  this.nickname,
          avatarUrl: this.avatarUrl || '',
        })
      } catch (e) {}

      return res.result
    } catch (e) {
      console.error('[Network] login failed', e)
      throw e
    }
  }

  // ── 2. 获取余额 ────────────────────────────────────────────────
  async getMyBalance() {
    const res = await wx.cloud.callFunction({
      name: 'playerManager',
      data: { action: 'getPlayer', openid: this.openid }
    })
    return res.result.balance
  }

  // ── 3. 创建房间 ────────────────────────────────────────────────
  async createRoom({ stake = 10, maxPlayers = 6 } = {}) {
    let roomCode, roomId, tries = 0
    while (tries < 10) {
      roomCode = generateRoomCode()
      roomId   = buildRoomId(roomCode)
      const exists = await getDB().rooms.doc(roomId).get().catch(() => null)
      if (!exists) break
      tries++
    }

    const res = await wx.cloud.callFunction({
      name: 'roomManager',
      data: {
        action: 'createRoom',
        roomCode, roomId, stake, maxPlayers,
        hostOpenid: this.openid,
        nickname:   this.nickname,
        avatarUrl:  this.avatarUrl,
      }
    })

    if (res.result.success) {
      this.currentRoomId   = roomId
      this.currentRoomCode = roomCode
      this._watchRoom(roomId)
    }
    return res.result
  }

  // ── 4. 加入房间 ────────────────────────────────────────────────
  async joinRoom(inputCode) {
    const roomCode = inputCode.trim()
    const roomId   = buildRoomId(roomCode)

    const res = await wx.cloud.callFunction({
      name: 'roomManager',
      data: {
        action: 'joinRoom',
        roomCode, roomId,
        openid:   this.openid,
        nickname: this.nickname,
        avatarUrl: this.avatarUrl,
      }
    })

    if (res.result.success) {
      this.currentRoomId   = roomId
      this.currentRoomCode = roomCode
      this._watchRoom(roomId)
    }
    return res.result
  }

  // ── 5. 摇骰子 ──────────────────────────────────────────────────
  async rollDice(diceValues) {
    if (!this.currentRoomId) return
    return wx.cloud.callFunction({
      name: 'roomManager',
      data: {
        action: 'rollDice',
        roomId:  this.currentRoomId,
        openid:  this.openid,
        diceValues,
      }
    })
  }

  // ── 6. 下一回合 ────────────────────────────────────────────────
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

  // ── 7. 终止游戏 ────────────────────────────────────────────────
  async abortGame() {
    const res = await wx.cloud.callFunction({
      name: 'roomManager',
      data: { action: 'abortGame', roomId: this.currentRoomId }
    })
    return res.result
  }

  // ── 8. 添加机器人 ──────────────────────────────────────────────
  async addBot() {
    const res = await wx.cloud.callFunction({
      name: 'roomManager',
      data: {
        action: 'addBot',
        roomId:     this.currentRoomId,
        hostOpenid: this.openid,
      }
    })
    return res.result
  }

  // ── 9. 开始游戏 ────────────────────────────────────────────────
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

  // ── 10. 离开房间 ───────────────────────────────────────────────
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
    this.currentRoomId   = null
    this.currentRoomCode = null
  }

  // ── 11. 玩家手气记录列表 ── 新增 ───────────────────────────────
  async getMyGames({ limit = 20, skip = 0 } = {}) {
    const res = await wx.cloud.callFunction({
      name: 'playerManager',
      data: { action: 'getMyGames', limit, skip }
    })
    return res.result
  }

  // ── 12. 玩家某局摘要 ── 新增 ───────────────────────────────────
  async getMyGameSummary(roomId) {
    const res = await wx.cloud.callFunction({
      name: 'playerManager',
      data: { action: 'getMyGameSummary', roomId }
    })
    return res.result
  }

  // ── 13. 房主对局列表 ── 新增 ───────────────────────────────────
  async getHostGames({ limit = 20, skip = 0 } = {}) {
    const res = await wx.cloud.callFunction({
      name: 'roomManager',
      data: { action: 'getHostGames', limit, skip }
    })
    return res.result
  }

  // ── 14. 房主查某局完整明细 ── 新增 ────────────────────────────
  async getGameDetail(roomId) {
    const res = await wx.cloud.callFunction({
      name: 'roomManager',
      data: { action: 'getGameDetail', roomId }
    })
    return res.result
  }

  // ── 15. 管理员查任意局明细 ── 新增 ────────────────────────────
  async adminGetGameDetail(roomId) {
    const res = await wx.cloud.callFunction({
      name: 'playerManager',
      data: { action: 'adminGetGameDetail', roomId }
    })
    return res.result
  }

  // ── 实时监听房间 ───────────────────────────────────────────────
  _watchRoom(roomId) {
    this._stopWatch()
    this._watchRetries = this._watchRetries || 0
    clearTimeout(this._watchRetryTimer)

    try {
      this._watcher = getDB().rooms.doc(roomId).watch({
        onChange: (snapshot) => {
          this._watchRetries = 0
          const doc = snapshot.docs[0]
          if (doc && this.onRoomUpdate) {
            this.onRoomUpdate(doc)
          }
        },
        onError: (err) => {
          console.error('[Network] watch error', err)
          this._stopWatch()
          this._watchRetries++
          if (this._watchRetries > 10) {
            if (this.onError) this.onError('网络连接已断开，请退出重进')
            return
          }
          const delay = Math.min(1000 * Math.pow(2, this._watchRetries - 1), 16000)
          this._watchRetryTimer = setTimeout(() => this._watchRoom(roomId), delay)
        }
      })
    } catch (e) {
      console.error('[Network] watch init fail', e)
      this._watchRetries++
      const delay = Math.min(1000 * Math.pow(2, this._watchRetries - 1), 16000)
      this._watchRetryTimer = setTimeout(() => this._watchRoom(roomId), delay)
    }
  }

  _stopWatch() {
    clearTimeout(this._watchRetryTimer)
    if (this._watcher) {
      try { this._watcher.close() } catch (e) {}
      this._watcher = null
    }
  }

  // ── 工具 ───────────────────────────────────────────────────────
  isMyTurn(roomData) {
    const p = roomData.players[roomData.currentPlayerIndex]
    return p && p.openid === this.openid
  }
}

module.exports = { Network }