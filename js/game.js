// js/Game.js - 主游戏逻辑
// v1.1.0：接入联机层（Network.js）+ 管理员面板（AdminPanel.js）
// 原有单机逻辑完整保留，isOnline 标志切换两种模式

const { UI } = require('./UI.js')
const { PhysicsWorld } = require('./Physics.js')
const { evaluateDice } = require('./Rules.js')
const { Network } = require('./Network.js')
const { AdminPanel } = require('./AdminPanel.js')

// ── 游戏状态 ──────────────────────────────────────
const STATE = {
  SETUP: 'setup',
  LOBBY: 'lobby',          // ← 新增：联机大厅
  IDLE: 'idle',
  ROLLING: 'rolling',
  RESULT: 'result',
  NEXT_ROUND: 'next_round',
  WINNER: 'winner',
}

class Game {
  constructor(canvas, logicW, logicH, dpr) {
    this.canvas = canvas

    // 读取安全区，避免灵动岛/刘海遮挡
    let safeTop = 60
    let safeBottom = 0
    try {
      const info = wx.getWindowInfo()
      safeTop = (info.safeArea ? info.safeArea.top : 0) + 16
      safeBottom = info.safeArea ? (info.screenHeight - info.safeArea.bottom) : 0
    } catch(e) {}
    this.safeTop = safeTop
    this.safeBottom = safeBottom

    this.ui = new UI(canvas, logicW, logicH, this.safeTop, dpr, this.safeBottom)
    this.w = logicW || 375   // 兜底：iPhone 逻辑宽
    this.h = logicH || 812   // 兜底：iPhone 逻辑高

    // Bowl position
    this.bowlCX = this.w / 2
    this.bowlCY = this.h * 0.46
    this.bowlRX = this.w * 0.38
    this.bowlRY = this.h * 0.19

    // Game state
    this.state = STATE.SETUP
    this.players = []
    this.currentPlayer = 0
    this.pool = 0
    this.stake = 32
    this.mode = 'classic'
    this.round = 1
    this.physics = null
    this.diceValues = [1, 2, 3, 4, 5, 6]
    this.lastResult = null
    this.lastPayout = 0
    this.rollPressed = false
    this.autoRollTimer = null
    this.autoRollSeconds = 60
    this.autoRollRemaining = 60

    // Setup screen state
    this.setupPlayers = ['阿七头', '曹莱西', '桌西君']
    this.setupStake = 32
    this.setupMode = 'classic'
    this.setupFocus = null

    // ── 联机相关 ──────────────────────────────────
    this.isOnline = false
    this.network = new Network()
    this.adminPanel = new AdminPanel(this.ui, this.network)
    this.roomData = null
    this.activityCode = ''
    this._titleTapCount = 0
    this._titleTapTimer = null
    // 大厅界面状态
    this._lobbyView = 'main'     // 'main' | 'waiting'
    this._lobbyJoinCode = ''
    this._lobbyLoading = false
    this._lobbyError = ''
    this._isHost = false         // 是否是房主
  }

  start() {
    this._loop()
    this._startShakeListener()
  }

  // 问题6：手机摇动触发摇骰子
  _startShakeListener() {
    let lastShake = 0
    wx.onAccelerometerChange((res) => {
      const { x, y, z } = res
      const force = Math.sqrt(x * x + y * y + z * z)
      if (force > 2.0) {
        const now = Date.now()
        if (now - lastShake < 1500) return  // 1.5秒冷却
        lastShake = now
        this._onShake()
      }
    })
    wx.startAccelerometer({ interval: 'game' })
  }

  _onShake() {
    if (this.state !== STATE.IDLE) return
    // 联机模式：只有轮到自己才能摇
    if (this.isOnline && !this._isMyTurn()) return
    this.rollPressed = true
    this._startRoll()
  }

  destroy() {
    wx.stopAccelerometer()
    this._clearAutoRollTimer()
    if (this.network) this.network.leaveRoom().catch(() => {})
  }

  // ── Main Loop ──────────────────────────────────
  _loop() {
    // 小程序 type="2d" canvas 必须用 canvas.requestAnimationFrame
    const raf = this.canvas.requestAnimationFrame
      ? (cb) => this.canvas.requestAnimationFrame(cb)
      : (cb) => setTimeout(cb, 16)
    const tick = () => {
      this._update()
      this._draw()
      raf(tick)
    }
    raf(tick)
  }

  _update() {
    if (this.state === STATE.ROLLING && this.physics) {
      const settled = this.physics.tick()
      if (settled) {
        this.diceValues = this.physics.dice.map(d => d.value)
        this._finishRoll()
      }
    }
    this.ui.updateParticles()
  }

  _draw() {
    // 尺寸未就绪时跳过，避免 createLinearGradient 收到 NaN/Infinity
    if (!this.w || !this.h || !isFinite(this.w) || !isFinite(this.h)) return
    const ui = this.ui
    ui.clear()

    if (this.state === STATE.SETUP) {
      this._drawSetup()
      this.adminPanel.draw()
      return
    }

    if (this.state === STATE.LOBBY) {
      this._drawLobby()
      return
    }

    if (this.state === STATE.WINNER) {
      const winner = this.players.find(p => p.active)
      ui.drawWinner(winner ? (winner.nickname || winner.name) : '大家')
      ui.drawParticles()
      this.adminPanel.draw()
      return
    }

    // Header
    const subtitle = this.isOnline
      ? `房间号 ${this.network.currentRoomCode || this.activityCode}  ·  第 ${this.round} 轮`
      : `第 ${this.round} 轮`
    ui.drawHeader('好婆叫侬来白相', subtitle)
    ui.drawExitButton()
    ui.drawPool(this.pool)

    // 游戏中，房主左上角「终止游戏」按钮（避开右侧系统胶囊）
    if (this.isOnline && this._isHost) {
      const ctx = ui.ctx
      const bw = 60, bh = 26, bx = 12, by = this.safeTop + 8
      ctx.fillStyle = 'rgba(120,30,15,0.75)'
      ctx.strokeStyle = 'rgba(255,80,60,0.35)'
      ctx.lineWidth = 1
      ui._roundRect(bx, by, bw, bh, 7)
      ctx.fill(); ctx.stroke()
      ctx.fillStyle = 'rgba(255,190,170,0.9)'
      ctx.font = 'bold 11px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('⏹ 终止', bx + bw / 2, by + 17)
    }
    ui.drawBowl(this.bowlCX, this.bowlCY, this.bowlRX, this.bowlRY)

    if (this.physics) {
      for (const die of this.physics.dice) {
        ui.drawDie(die.x, die.y, die.angle, die.value, die.settled, die.displayValue)
      }
    } else {
      this._drawStaticDice()
    }

    if (this.state === STATE.RESULT || this.state === STATE.NEXT_ROUND) {
      ui.drawResult(this.lastResult, this.lastPayout)
    }

    if (this.state === STATE.RESULT) {
      ui.drawNextButton('下一位 →')
    } else if (this.state === STATE.NEXT_ROUND) {
      ui.drawNextButton('开始下一轮 🔄')
    }

    if (this.state === STATE.IDLE) {
      // 联机模式：非当前玩家不显示摇骰子按钮
      const showRoll = !this.isOnline || this._isMyTurn()
      if (showRoll) {
        const label = this.autoRollRemaining < 60
          ? `摇 骰 子  (${this.autoRollRemaining}s)`
          : '摇 骰 子'
        ui.drawRollButton(this.rollPressed, label)
      } else {
        this._drawWaitingLabel()
      }
      ui.drawTurnLabel(this._currentPlayerName())
    }

    ui.drawPlayers(this.players, this.currentPlayer)
    ui.drawParticles()

    // 管理员面板叠在最上层
    this.adminPanel.draw()
  }

  _drawStaticDice() {
    const positions = this._getDicePositions(this.diceValues.length)
    this.diceValues.forEach((v, i) => {
      const [x, y] = positions[i]
      this.ui.drawDie(x, y, 0, v, true, v)
    })
  }

  _getDicePositions(count) {
    const cx = this.bowlCX
    const cy = this.bowlCY
    const spread = this.bowlRX * 0.52
    const positions = []
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2
      const r = count <= 3 ? spread * 0.5 : spread * (0.3 + (i % 2) * 0.42)
      positions.push([
        cx + Math.cos(angle) * r,
        cy + Math.sin(angle) * r * 0.55,
      ])
    }
    const minDist = 48
    for (let pass = 0; pass < 8; pass++) {
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          const dx = positions[i][0] - positions[j][0]
          const dy = positions[i][1] - positions[j][1]
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < minDist && dist > 0.5) {
            const nx = dx / dist, ny = dy / dist
            const push = (minDist - dist) * 0.55
            positions[i][0] += nx * push; positions[i][1] += ny * push
            positions[j][0] -= nx * push; positions[j][1] -= ny * push
          }
        }
      }
    }
    return positions
  }

  // ── 等待其他玩家提示 ────────────────────────────
  _drawWaitingLabel() {
    const ctx = this.ui.ctx
    const name = this._currentPlayerName()
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.font = '15px sans-serif'
    ctx.fillText(`等待 ${name} 摇骰子...`, this.w / 2, this.h - 130 - (this.safeBottom || 0))
  }

  // ── Setup Screen ──────────────────────────────
  _drawSetup() {
    const ctx = this.ui.ctx
    const ui = this.ui
    const w = this.w
    const h = this.h
    const st = this.safeTop

    ctx.textAlign = 'center'
    ctx.fillStyle = '#D4AC0D'
    ctx.font = 'bold 34px serif'
    ctx.fillText('好婆叫侬来白相', w / 2, st + 36)
    ctx.fillStyle = 'rgba(212,172,13,0.5)'
    ctx.font = '13px sans-serif'

    ctx.strokeStyle = 'rgba(212,172,13,0.2)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(40, st + 76)
    ctx.lineTo(w - 40, st + 76)
    ctx.stroke()

    // Stake label
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText('底池（每人）', 40, st + 104)

    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.strokeStyle = this.setupFocus === 'stake' ? '#D4AC0D' : 'rgba(255,255,255,0.15)'
    ctx.lineWidth = 1
    ui._roundRect(40, st + 112, w - 80, 44, 8)
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = '#FFFFFF'
    ctx.font = '18px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(`${this.setupStake} 点`, w / 2, st + 140)

    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText('模式', 40, st + 176)

    const modes = [['classic', '经典版'], ['battle', '对决版']]
    modes.forEach(([m, label], i) => {
      const bx = 40 + i * ((w - 88) / 2 + 8)
      const bw = (w - 88) / 2
      ctx.fillStyle = this.setupMode === m ? 'rgba(192,57,43,0.4)' : 'rgba(255,255,255,0.05)'
      ctx.strokeStyle = this.setupMode === m ? '#C0392B' : 'rgba(255,255,255,0.15)'
      ctx.lineWidth = this.setupMode === m ? 2 : 1
      ui._roundRect(bx, st + 184, bw, 40, 8)
      ctx.fill(); ctx.stroke()
      ctx.fillStyle = this.setupMode === m ? '#FFFFFF' : 'rgba(255,255,255,0.5)'
      ctx.font = '14px serif'
      ctx.textAlign = 'center'
      ctx.fillText(label, bx + bw / 2, st + 210)
    })

    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText('玩家（点击修改名字）', 40, st + 246)

    this.setupPlayers.forEach((name, i) => {
      const by = st + 254 + i * 52
      ctx.fillStyle = this.setupFocus === `player_${i}` ? 'rgba(212,172,13,0.15)' : 'rgba(255,255,255,0.05)'
      ctx.strokeStyle = this.setupFocus === `player_${i}` ? '#D4AC0D' : 'rgba(255,255,255,0.1)'
      ctx.lineWidth = 1
      ui._roundRect(40, by, w - 80, 40, 8)
      ctx.fill(); ctx.stroke()
      ctx.fillStyle = name ? '#FFFFFF' : 'rgba(255,255,255,0.3)'
      ctx.font = '16px sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(name || `玩家 ${i + 1}`, 64, by + 26)
      if (this.setupPlayers.length > 2) {
        ctx.fillStyle = 'rgba(192,57,43,0.5)'
        ctx.beginPath()
        ctx.arc(w - 56, by + 20, 12, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.font = 'bold 14px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('✕', w - 56, by + 25)
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.2)'
        ctx.font = '11px sans-serif'
        ctx.textAlign = 'right'
        ctx.fillText(`P${i + 1}`, w - 56, by + 26)
      }
    })

    const addY = st + 254 + this.setupPlayers.length * 52
    if (this.setupPlayers.length < 10) {
      ctx.fillStyle = 'rgba(212,172,13,0.08)'
      ctx.strokeStyle = 'rgba(212,172,13,0.25)'
      ctx.lineWidth = 1
      ctx.setLineDash([5, 4])
      ui._roundRect(40, addY, w - 80, 40, 8)
      ctx.fill(); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(212,172,13,0.5)'
      ctx.font = '14px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('＋ 添加玩家', w / 2, addY + 26)
    }

    // ── 底部两个按钮：单机 / 联机 ──────────────────
    const btnY = h - 148 - (this.safeBottom || 0)
    // 单机开始
    const grad = ctx.createLinearGradient(40, btnY, 40, btnY + 52)
    grad.addColorStop(0, '#D4AC0D')
    grad.addColorStop(1, '#B7950B')
    ctx.fillStyle = grad
    ui._roundRect(40, btnY, w - 80, 52, 14)
    ctx.fill()
    ctx.fillStyle = '#2C1810'
    ctx.font = 'bold 20px serif'
    ctx.textAlign = 'center'
    ctx.fillText('单 机 开 始', w / 2, btnY + 34)

    // 联机游戏
    ctx.fillStyle = 'rgba(192,57,43,0.15)'
    ctx.strokeStyle = 'rgba(192,57,43,0.5)'
    ctx.lineWidth = 1.5
    ui._roundRect(40, btnY + 64, w - 80, 48, 14)
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = '#FF6B5B'
    ctx.font = 'bold 18px serif'
    ctx.textAlign = 'center'
    ctx.fillText('🌐  联  机', w / 2, btnY + 94)
  }

  // ── 联机大厅 ────────────────────────────────────
  _drawLobby() {
    const ctx = this.ui.ctx
    const ui = this.ui
    const w = this.w
    const h = this.h
    const st = this.safeTop
    const sb = this.safeBottom || 0
    const cx = w / 2

    // 通用 Header
    ctx.textAlign = 'center'
    ctx.fillStyle = '#D4AC0D'
    ctx.font = 'bold 26px serif'
    ctx.fillText('好婆叫侬来白相', cx, st + 36)

    // 返回按钮
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ui._roundRect(12, st + 10, 60, 30, 8)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '13px sans-serif'
    ctx.fillText('← 返回', 42, st + 30)

    if (this._lobbyLoading) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)'
      ctx.font = '16px sans-serif'
      ctx.fillText('连接中...', cx, h / 2)
      return
    }

    // ══ 等待室视图（创建或加入成功后显示）══════════════
    if (this._lobbyView === 'waiting') {
      ctx.fillStyle = 'rgba(212,172,13,0.5)'
      ctx.font = '14px sans-serif'
      ctx.fillText(this._isHost ? '房间已创建，等待好友加入' : '已加入，等待房主开始', cx, st + 62)

      if (this.network.nickname) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        ctx.font = '13px sans-serif'
        ctx.fillText('👤  ' + this.network.nickname, cx, st + 86)
      }

      // 房间号大卡片
      const cardY = st + 110
      ctx.fillStyle = 'rgba(212,172,13,0.1)'
      ctx.strokeStyle = 'rgba(212,172,13,0.45)'
      ctx.lineWidth = 1.5
      ui._roundRect(32, cardY, w - 64, 108, 18)
      ctx.fill(); ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.font = '12px sans-serif'
      ctx.fillText('房间号（点击下方按钮分享给好友）', cx, cardY + 24)
      ctx.fillStyle = '#D4AC0D'
      ctx.font = 'bold 56px serif'
      ctx.fillText(this.activityCode || '----', cx, cardY + 88)

      // 分享按钮
      const shareY = cardY + 124
      ctx.fillStyle = 'rgba(7,193,96,0.18)'
      ctx.strokeStyle = 'rgba(7,193,96,0.55)'
      ctx.lineWidth = 1
      ui._roundRect(32, shareY, w - 64, 50, 13)
      ctx.fill(); ctx.stroke()
      ctx.fillStyle = '#07C160'
      ctx.font = 'bold 16px sans-serif'
      ctx.fillText('📤  分享房间号给微信好友', cx, shareY + 32)

      // 已加入玩家列表
      const listY = shareY + 68
      const players = this._waitingPlayers || []
      ctx.fillStyle = 'rgba(255,255,255,0.28)'
      ctx.font = '13px sans-serif'
      ctx.fillText('已加入 ' + players.length + ' 人', cx, listY)
      players.forEach((p, i) => {
        const rowX = cx + (i - (players.length - 1) / 2) * 72
        // 头像
        this._drawAvatar(ctx, p.openid, p.avatarUrl || '', rowX, listY + 52, 22)
        // 昵称：自适应字号，最宽 64px
        ctx.fillStyle = p.isBot ? 'rgba(255,200,80,0.7)' : 'rgba(255,255,255,0.7)'
        const maxW = 64
        let nick = p.nickname
        let fontSize = 12
        ctx.font = fontSize + 'px sans-serif'
        while (ctx.measureText(nick).width > maxW && fontSize > 8) {
          fontSize--
          ctx.font = fontSize + 'px sans-serif'
        }
        // 还超就截断加省略号
        if (ctx.measureText(nick).width > maxW) {
          while (ctx.measureText(nick + '…').width > maxW && nick.length > 1) {
            nick = nick.slice(0, -1)
          }
          nick = nick + '…'
        }
        ctx.fillText(nick, rowX, listY + 90)
      })

      // 房主按钮区
      if (this._isHost) {
        const botY = h - 136 - sb
        const startY = h - 72 - sb
        const canStart = players.length >= 2

        // 添加机器人按钮
        ctx.fillStyle = 'rgba(255,255,255,0.06)'
        ctx.strokeStyle = 'rgba(255,255,255,0.18)'
        ctx.lineWidth = 1
        ui._roundRect(32, botY, w - 64, 48, 12)
        ctx.fill(); ctx.stroke()
        ctx.fillStyle = 'rgba(255,255,255,0.5)'
        ctx.font = '15px sans-serif'
        ctx.fillText('🤖  添加机器人陪练', cx, botY + 30)

        // 开始游戏按钮
        ctx.fillStyle = canStart ? '#C0392B' : 'rgba(80,30,20,0.6)'
        ui._roundRect(32, startY, w - 64, 52, 14)
        ctx.fill()
        ctx.fillStyle = canStart ? '#FFFFFF' : 'rgba(255,255,255,0.25)'
        ctx.font = 'bold 19px serif'
        ctx.fillText(canStart ? '开 始 游 戏' : '至少 2 人才能开始', cx, startY + 34)
      }
      return
    }

    // ══ 主视图 ═══════════════════════════════════
    ctx.fillStyle = 'rgba(212,172,13,0.5)'
    ctx.font = '13px sans-serif'
    ctx.fillText('联机大厅', cx, st + 62)

    // 昵称行：头像圆 + 昵称 + 修改按钮
    const nick = this.network.nickname || ''
    if (nick) {
      const avatarX = cx - 80
      const avatarY = st + 78
      const avatarR = 18
      // 头像
      this._drawAvatar(ctx, '_self', this.network.avatarUrl || '', avatarX, avatarY, avatarR)
      // 昵称文字
      ctx.fillStyle = 'rgba(255,255,255,0.6)'
      ctx.font = '14px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(nick, cx - 20, st + 83)
      // 修改按钮
      ctx.fillStyle = 'rgba(255,255,255,0.08)'
      ctx.strokeStyle = 'rgba(255,255,255,0.2)'
      ctx.lineWidth = 1
      ui._roundRect(cx + 30, st + 68, 52, 24, 6)
      ctx.fill(); ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.font = '11px sans-serif'
      ctx.fillText('修改', cx + 56, st + 85)
    }

    let y = st + 130
    if (this._lobbyError) {
      ctx.fillStyle = '#FF6B5B'
      ctx.font = '14px sans-serif'
      ctx.fillText(this._lobbyError, cx, y)
      y += 36
    }

    ctx.fillStyle = '#C0392B'
    ui._roundRect(40, y, w - 80, 60, 14)
    ctx.fill()
    ctx.fillStyle = '#FFFFFF'
    ctx.font = 'bold 19px serif'
    ctx.fillText('🎲  创建新房间', cx, y + 38)
    y += 80

    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.strokeStyle = 'rgba(255,255,255,0.2)'
    ctx.lineWidth = 1
    ui._roundRect(40, y, w - 80, 60, 14)
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = '#FFFFFF'
    ctx.font = 'bold 19px serif'
    ctx.fillText('🔑  输入房间号加入', cx, y + 38)
  }

  // ── Events ─────────────────────────────────────
  _bindEvents() {
    // 事件现在由 Page 直接调用 onTouchStart / onTouchEnd / onHide / onShow
  }

  // ── 供 Page 调用的公开方法 ─────────────────────
  onTouchStart(touch) {
    this._onTouch(touch)
  }

  onTouchEnd() {
    this.rollPressed = false
  }

  onHide() {
    this._wasHidden = true
  }

  onShow() {
    if (this._wasHidden && this.state !== STATE.SETUP && this.state !== STATE.LOBBY) {
      this._wasHidden = false
      wx.showModal({
        title: '继续？',
        content: '要继续当前局还是退出？',
        confirmText: '继续',
        cancelText: '退出',
        success: (res) => {
          if (!res.confirm) wx.navigateBack()
        }
      })
    } else {
      this._wasHidden = false
    }
  }

  destroy() {
    this._clearAutoRollTimer()
    if (this.network) this.network.leaveRoom().catch(() => {})
  }

  _bindEvents() {
    // 已迁移到 Page 的 bindtouchstart/bindtouchend，此方法保留空壳
  }

  _onTouch(touch) {
    const tx = touch.clientX
    const ty = touch.clientY

    // 管理员面板优先消费触摸
    if (this.adminPanel.onTouch(tx, ty)) return

    if (this.state === STATE.SETUP) {
      // 标题区点击计数（5次进管理员）
      if (ty < this.safeTop + 70) {
        this._onTitleTap()
        return
      }
      this._handleSetupTouch(tx, ty)
      return
    }

    if (this.state === STATE.LOBBY) {
      this._handleLobbyTouch(tx, ty)
      return
    }

    if (this.state === STATE.WINNER) {
      this._restartGame()
      return
    }

    // 退出按钮优先（在标题区判断之前，避免被拦截）
    if (this.state !== STATE.SETUP && this.ui.hitTestExitButton(tx, ty)) {
      wx.showModal({
        title: '退出',
        content: '确定退出当前局？',
        confirmText: '退出',
        cancelText: '继续',
        confirmColor: '#C0392B',
        success: (res) => {
          if (res.confirm) this._restartGame()
        }
      })
      return
    }

    // 标题区点击
    // 房主「终止游戏」按钮
    if (this.isOnline && this._isHost && this.state !== STATE.SETUP && this.state !== STATE.LOBBY) {
      const bw = 60, bh = 26, bx = 12, by = this.safeTop + 8
      if (tx >= bx && tx <= bx + bw && ty >= by && ty <= by + bh) {
        this._confirmAbortGame()
        return
      }
    }
    if (ty < this.safeTop + 50 && tx < this.w - 28) {
      this._onTitleTap()
      return
    }

    if (this.state === STATE.IDLE) {
      if (this.ui.hitTestRollButton(tx, ty)) {
        // 联机模式：只有当前玩家可摇
        if (this.isOnline && !this._isMyTurn()) return
        this.rollPressed = true
        this._startRoll()
      }
    }

    if (this.state === STATE.RESULT) {
      if (this.ui.hitTestNextButton(tx, ty)) {
        this._nextTurn()
      }
    }

    if (this.state === STATE.NEXT_ROUND) {
      if (this.ui.hitTestNextButton(tx, ty)) {
        this._startNextRound()
      }
    }
  }

  // ── 标题点击5次进管理员 ─────────────────────────
  _onTitleTap() {
    this._titleTapCount++
    clearTimeout(this._titleTapTimer)
    this._titleTapTimer = setTimeout(() => { this._titleTapCount = 0 }, 2000)

    // 倒数提示，帮助确认点击有效
    const remain = 5 - this._titleTapCount
    if (remain > 0 && remain <= 3) {
      wx.showToast({ title: `再点 ${remain} 次`, icon: 'none', duration: 600 })
    }

    if (this._titleTapCount >= 5) {
      this._titleTapCount = 0
      this._promptAdminPassword()
    }
  }

  // 管理员密码输入（使用 wx.showKeyboard 兼容小游戏环境）
  _promptAdminPassword() {
    this._adminInputValue = ''
    wx.showModal({
      title: '管理员验证',
      content: '请输入管理密码后点击确认',
      showCancel: true,
      confirmText: '确认',
      success: (r) => {
        if (!r.confirm) return
        wx.showKeyboard({
          defaultValue: '',
          maxLength: 32,
          multiple: false,
          confirmHold: false,
          confirmType: 'done',
        })
        const onInput = (res) => { this._adminInputValue = res.value }
        const onConfirm = (res) => {
          wx.offKeyboardInput(onInput)
          wx.offKeyboardConfirm(onConfirm)
          wx.hideKeyboard()
          this.adminPanel._verifyAndOpen(this._adminInputValue || res.value)
        }
        wx.onKeyboardInput(onInput)
        wx.onKeyboardConfirm(onConfirm)
      }
    })
  }

  // ── Setup Touch ───────────────────────────────
  _handleSetupTouch(tx, ty) {
    const w = this.w
    const ui = this.ui
    const st = this.safeTop
    const h = this.h

    if (tx >= 40 && tx <= w - 40 && ty >= st + 112 && ty <= st + 156) {
      wx.showActionSheet({
        itemList: ['16点', '32点', '50点', '100点', '自定义'],
        success: res => {
          const stakes = [16, 32, 50, 100]
          if (res.tapIndex < 4) {
            this.setupStake = stakes[res.tapIndex]
          } else {
            wx.showModal({
              title: '自定义底池',
              editable: true,
              placeholderText: '输入数额',
              success: r => {
                if (r.confirm && r.content) {
                  const v = parseInt(r.content)
                  if (v > 0) this.setupStake = v
                }
              }
            })
          }
        }
      })
    }

    const bw = (w - 88) / 2
    if (ty >= st + 184 && ty <= st + 224) {
      if (tx >= 40 && tx <= 40 + bw) this.setupMode = 'classic'
      if (tx >= 40 + bw + 8 && tx <= w - 40) this.setupMode = 'battle'
    }

    let handled = false
    for (let i = 0; i < this.setupPlayers.length; i++) {
      const name = this.setupPlayers[i]
      const by = st + 254 + i * 52
      if (this.setupPlayers.length > 2) {
        const dx = tx - (w - 56), dy = ty - (by + 20)
        if (Math.sqrt(dx * dx + dy * dy) < 16) {
          this.setupPlayers.splice(i, 1)
          handled = true
          break
        }
      }
      if (tx >= 40 && tx <= w - 80 && ty >= by && ty <= by + 40) {
        wx.showModal({
          title: `玩家 ${i + 1} 名字`,
          editable: true,
          placeholderText: `玩家${i + 1}`,
          content: name,
          success: r => {
            if (r.confirm && r.content.trim()) this.setupPlayers[i] = r.content.trim()
          }
        })
        handled = true
        break
      }
    }

    const addY = st + 254 + this.setupPlayers.length * 52
    if (!handled && this.setupPlayers.length < 10 && tx >= 40 && tx <= w - 40 && ty >= addY && ty <= addY + 40) {
      this.setupPlayers.push(`玩家${this.setupPlayers.length + 1}`)
    }

    // 单机开始
    const btnY = h - 148 - (this.safeBottom || 0)
    if (ty >= btnY && ty <= btnY + 52) {
      this.isOnline = false
      this._startGame()
    }

    // 联机游戏 → 进大厅
    if (ty >= btnY + 64 && ty <= btnY + 112) {
      this._enterLobby()
    }
  }

  // ── 进入联机大厅 ────────────────────────────────
  async _enterLobby() {
    this.isOnline = true
    this.state = STATE.LOBBY
    this._lobbyLoading = false
    this._lobbyError = ''
    this._lobbyView = 'main'      // ← 每次进大厅都重置到主视图
    this._isHost = false
    this.activityCode = ''
    this._waitingPlayers = []

    try {
      await this.network.login(
        this.collectNickname,
        () => { this._lobbyLoading = true }
      )
      this._lobbyLoading = false
    } catch {
      this._lobbyLoading = false
      this._lobbyError = '登录失败，请检查网络'
    }
  }

  _handleLobbyTouch(tx, ty) {
    const st = this.safeTop
    const sb = this.safeBottom || 0
    const w = this.w
    const h = this.h

    // 返回按钮（等待室也可以退出）
    if (tx < 80 && ty >= st + 10 && ty <= st + 40) {
      if (this._lobbyView === 'waiting') {
        // 退出房间
        this.network.leaveRoom().catch(() => {})
        this._lobbyView = 'main'
        this._isHost = false
        this._waitingPlayers = []
        this.activityCode = ''
      } else {
        this.state = STATE.SETUP
        this.isOnline = false
      }
      return
    }

    // ── 等待室触摸 ────────────────────────────────
    if (this._lobbyView === 'waiting') {
      const cardY = st + 110
      const shareY = cardY + 124

      // 分享/复制 按钮
      if (ty >= shareY && ty <= shareY + 50) {
        wx.setClipboardData({
          data: this.activityCode,
          success: () => wx.showToast({ title: '房间号已复制', icon: 'success' })
        })
        // 同时触发系统分享（右上角菜单里也有）
        wx.showShareMenu({ withShareTicket: false, menus: ['shareAppMessage'] })
        return
      }

      // 房主按钮区
      if (this._isHost) {
        const botY = h - 136 - sb
        const startY = h - 72 - sb
        // 添加机器人
        if (ty >= botY && ty <= botY + 48) {
          this._addBot()
          return
        }
        // 开始游戏
        if (ty >= startY && ty <= startY + 52) {
          this._hostStartGame()
          return
        }
      }
      return
    }

    // ── 主视图触摸 ────────────────────────────────
    const cx = this.w / 2
    // 修改昵称按钮
    if (this.network.nickname && ty >= st + 76 && ty <= st + 100 && tx >= cx + 30 && tx <= cx + 82) {
      this._changeNickname()
      return
    }

    let y = st + 130
    if (this._lobbyError) y += 36

    if (ty >= y && ty <= y + 60) {
      this._promptStakeAndCreate()
      return
    }
    y += 80

    if (ty >= y && ty <= y + 60) {
      wx.showModal({
        title: '输入房间号',
        editable: true,
        placeholderText: '5位数字，如 36721',
        success: (res) => {
          if (res.confirm && res.content.trim()) {
            this._joinOnlineRoom(res.content.trim())
          }
        }
      })
    }
  }

  // 房主确认终止游戏
  _confirmAbortGame() {
    wx.showModal({
      title: '终止游戏',
      content: '底池将平分退还给所有玩家，确认终止？',
      confirmText: '确认终止',
      confirmColor: '#C0392B',
      cancelText: '继续游戏',
      success: async (res) => {
        if (!res.confirm) return
        try {
          const result = await this.network.abortGame()
          if (!result || !result.success) {
            wx.showToast({ title: result?.error || '操作失败', icon: 'none' })
          }
          // 结果通过 _onRoomUpdate 的 phase==='aborted' 分支处理
        } catch(e) {
          wx.showToast({ title: '网络错误', icon: 'none' })
        }
      }
    })
  }

  // 修改昵称 → 重新跳 profile 页
  _changeNickname() {
    if (typeof this.collectNickname === 'function') {
      // 清掉缓存，强制重填
      try { wx.removeStorageSync('userProfile') } catch(e) {}
      this.collectNickname().then((result) => {
        if (result.nickname) {
          this.network.nickname = result.nickname
          this.network.avatarUrl = result.avatarUrl || this.network.avatarUrl
          // 同步到云端
          wx.cloud.callFunction({
            name: 'playerManager',
            data: { action: 'login', nickname: result.nickname, avatarUrl: result.avatarUrl || '' }
          }).catch(() => {})
        }
      })
    }
  }

  // 添加机器人
  async _addBot() {
    const existing = (this._waitingPlayers || []).filter(p => p.isBot)
    if (existing.length >= 3) {
      wx.showToast({ title: '最多添加3个机器人', icon: 'none' })
      return
    }
    try {
      const res = await this.network.addBot()
      if (!res || !res.success) {
        wx.showToast({ title: res?.error || '添加失败', icon: 'none' })
      }
    } catch(e) {
      wx.showToast({ title: '网络错误', icon: 'none' })
    }
  }

  // 房主点「开始游戏」──────────────────────────────
  async _hostStartGame() {
    try {
      const res = await this.network.startGame()
      if (res && res.success) {
        this._startOnlineGame(res.roomData)
      } else {
        wx.showToast({ title: res?.error || '开始失败', icon: 'none' })
      }
    } catch (e) {
      wx.showToast({ title: '网络错误', icon: 'none' })
    }
  }

  _promptStakeAndCreate() {
    const defaultStake = this.setupStake || 32
    wx.showModal({
      title: '设置底池',
      content: `每人底池默认 ${defaultStake} 点，首次联机赠送 100 点。`,
      confirmText: '去设置',
      cancelText: '用默认',
      success: (res) => {
        if (!res.confirm) {
          // 直接用默认值创建
          this._createOnlineRoom()
          return
        }
        // 弹输入框
        wx.showModal({
          title: '输入底池金额',
          editable: true,
          placeholderText: String(defaultStake),
          success: (r) => {
            if (!r.confirm) return
            const raw = parseInt((r.content || '').trim())
            if (isNaN(raw) || raw <= 0) {
              wx.showToast({ title: '请输入正整数', icon: 'none' })
              return
            }
            this.setupStake = raw
            this._createOnlineRoom()
          }
        })
      }
    })
  }

  async _createOnlineRoom() {
    this._lobbyLoading = true
    this._lobbyError = ''
    try {
      const res = await this.network.createRoom({
        stake: this.setupStake || 32,
        maxPlayers: 6,
      })
      if (res.success) {
        this.activityCode = res.roomCode || res.activityCode
        this._isHost = true
        this._bindRoomCallbacks()
        // 进入等待室，房主手动点「开始」才进游戏
        this._lobbyView = 'waiting'
      } else {
        this._lobbyError = res.error || '创建失败'
      }
    } catch (e) {
      this._lobbyError = '网络错误，请重试'
    }
    this._lobbyLoading = false
  }

  async _joinOnlineRoom(code) {
    this._lobbyLoading = true
    this._lobbyError = ''
    try {
      const res = await this.network.joinRoom(code)
      if (res.success) {
        const rd = res.roomData
        if (rd && rd.phase === 'playing') {
          // 游戏已在进行中，直接进游戏（旁观/补位场景暂不支持）
          this._lobbyError = '游戏已开始，无法加入'
          this.network.leaveRoom().catch(() => {})
        } else {
          this.activityCode = res.roomCode || code
          this._isHost = (rd && rd.hostOpenid === this.network.openid)
          this._bindRoomCallbacks()
          this._lobbyView = 'waiting'
          if (rd) this._waitingPlayers = (rd.players || []).map(p => ({
            openid: p.openid, nickname: p.nickname, avatarUrl: p.avatarUrl || '', isBot: !!p.isBot
          }))
        }
      } else {
        this._lobbyError = res.error || '加入失败'
      }
    } catch {
      this._lobbyError = '找不到该房间号'
    }
    this._lobbyLoading = false
  }

  // ── 联机：绑定云端推送回调 ─────────────────────
  _bindRoomCallbacks() {
    this.network.onRoomUpdate = (roomData) => this._onRoomUpdate(roomData)
    this.network.onError = (msg) => {
      wx.showToast({ title: msg, icon: 'none' })
    }
  }

  // ── 联机：收到云端房间状态更新 ─────────────────
  _onRoomUpdate(roomData) {
    this.roomData = roomData
    this.round = roomData.round || this.round
    this.pool = roomData.pool || 0

    // 等待室：同步已加入玩家列表
    if (this._lobbyView === 'waiting' && roomData.players) {
      this._waitingPlayers = roomData.players.map(p => ({ openid: p.openid, nickname: p.nickname, avatarUrl: p.avatarUrl || '', isBot: !!p.isBot }))
    }

    // 房主点开始后，非房主自动进入游戏
    if (roomData.phase === 'playing' && this.state === STATE.LOBBY && !this._isHost) {
      this._startOnlineGame(roomData)
      return
    }

    // 同步玩家列表（用云端数据，nickname/avatarUrl替代本地name）
    this.players = (roomData.players || []).map(p => ({
      ...p,
      name: p.nickname,
      chips: p.chips,
      active: p.active,
    }))
    this.currentPlayer = roomData.currentPlayerIndex

    // 轮到机器人时，房主客户端自动代为摇骰子（1秒延迟模拟思考）
    const botPhase = roomData.phase === 'waiting' || roomData.phase === 'settled'
    if (this._isHost && botPhase && roomData.players) {
      const cur = roomData.players[roomData.currentPlayerIndex]
      if (cur && cur.isBot) {
        clearTimeout(this._botTimer)
        this._botTimer = setTimeout(() => this._triggerBotRoll(), 1200)
      }
    }

    // 其他玩家摇了骰子 → 在本地播放骰子动画
    if (roomData.phase === 'rolling' && !this._isMyTurn()) {
      this._playRemoteDice(roomData.diceValues)
    }

    // 结算
    if (roomData.lastResult && roomData.phase === 'settled') {
      this.lastResult = roomData.lastResult
      this.lastPayout = roomData.lastPayout || 0
      this.state = STATE.RESULT
    }

    // 中途终止
    if (roomData.phase === 'aborted') {
      this._showAbortResult(roomData)
      return
    }

    // 游戏结束
    if (roomData.status === 'finished') {
      this.state = STATE.WINNER
    }
  }

  async _triggerBotRoll() {
    if (!this.roomData) return
    const cur = this.roomData.players[this.roomData.currentPlayerIndex]
    if (!cur || !cur.isBot) return
    try {
      // 先在本地播摇骰动画（随机值，稍后用云端结果覆盖）
      this.state = STATE.ROLLING
      this.physics = new PhysicsWorld(this.bowlCX, this.bowlCY, this.bowlRX, this.bowlRY)
      this.physics.spawnAll([1,1,1,1,1])

      const res = await wx.cloud.callFunction({
        name: 'roomManager',
        data: {
          action: 'botRoll',
          roomId: this.network.currentRoomId,
          botOpenid: cur.openid,
          hostOpenid: this.network.openid,
        }
      })
      const result = res.result
      if (result && result.success) {
        // 动画结束后用真实骰子值显示结果
        setTimeout(() => {
          if (result.diceValues) {
            this.physics = new PhysicsWorld(this.bowlCX, this.bowlCY, this.bowlRX, this.bowlRY)
            this.physics.spawnAll(result.diceValues)
          }
          // _onRoomUpdate 会把 state 设成 RESULT，这里等云端推送自然触发
          // 2.5秒后自动点下一位
          setTimeout(() => this._triggerBotNext(), 2500)
        }, 800)
      } else {
        setTimeout(() => this._triggerBotNext(), 1500)
      }
    } catch(e) {
      console.error('botRoll fail', e)
      setTimeout(() => this._triggerBotNext(), 2000)
    }
  }

  async _triggerBotNext() {
    // 只有当前仍是 settled 状态才推进（防止重复触发）
    if (!this.roomData || this.roomData.phase !== 'settled') return
    const cur = this.roomData.players[this.roomData.currentPlayerIndex]
    if (!cur || !cur.isBot) return
    try {
      await this.network.nextTurn()
    } catch(e) {
      console.error('botNext fail', e)
    }
  }

  _showAbortResult(roomData) {
    const share = roomData.pool > 0
      ? Math.floor(roomData.pool / (roomData.players || []).filter(p => !p.isBot).length)
      : 0
    const myPlayer = (roomData.players || []).find(p => p.openid === this.network.openid)
    const myChips = myPlayer ? myPlayer.chips : 0
    wx.showModal({
      title: '游戏已终止',
      content: `底池已平分退还。
你本局最终余额：${myChips + share} 点`,
      showCancel: false,
      confirmText: '返回主页',
      success: () => {
        this.network.leaveRoom().catch(() => {})
        this.isOnline = false
        this.state = STATE.SETUP
      }
    })
  }

  _playRemoteDice(values) {
    if (this.state === STATE.ROLLING) return
    this.state = STATE.ROLLING
    this.physics = new PhysicsWorld(this.bowlCX, this.bowlCY, this.bowlRX, this.bowlRY)
    this.physics.spawnAll(values)
  }

  // ── 联机：初始化游戏状态（进入IDLE）─────────────
  _startOnlineGame(roomData) {
    this.roomData = roomData
    this.stake = roomData.stake
    this.mode = roomData.mode || 'classic'
    this.round = roomData.round || 1
    this.pool = roomData.pool || 0
    this.players = roomData.players.map(p => ({
      ...p,
      name: p.nickname,
      active: p.active,
    }))
    this.currentPlayer = roomData.currentPlayerIndex
    this.physics = null
    this.diceValues = [1, 2, 3, 4, 5, 6]
    this.lastResult = null
    this.state = STATE.IDLE
    this._startAutoRollTimer()
  }

  // ── Game Flow（原有逻辑，单机不变）───────────────
  _startGame() {
    const names = this.setupPlayers.filter(n => n.trim())
    if (names.length < 2) {
      wx.showToast({ title: '至少需要2位玩家', icon: 'none' })
      return
    }

    this.stake = this.setupStake
    this.mode = this.setupMode
    this.players = names.map(name => ({ name, chips: this.stake, active: true }))
    this.currentPlayer = 0
    this.round = 1
    this.pool = 0
    this.lastResult = null
    this.physics = null
    this.diceValues = [1, 2, 3, 4, 5, 6]

    this._preloadAllTTS()
    this._collectPool()
    this.state = STATE.IDLE
    this._startAutoRollTimer()
  }

  _collectPool() {
    if (this.mode === 'battle') {
      const alive = this.players.filter(p => p.active)
      const minChips = Math.min(...alive.map(p => p.chips))
      alive.forEach(p => {
        p.chips -= minChips
        this.pool += minChips
      })
    } else {
      this.players.forEach(p => {
        if (p.active) {
          const amount = Math.min(this.stake, p.chips)
          p.chips -= amount
          this.pool += amount
        }
      })
    }
  }

  _startRoll() {
    if (this.state !== STATE.IDLE) return
    this._clearAutoRollTimer()
    this.state = STATE.ROLLING
    this.lastResult = null

    const values = Array.from({ length: 6 }, () => Math.ceil(Math.random() * 6))
    this.physics = new PhysicsWorld(this.bowlCX, this.bowlCY, this.bowlRX, this.bowlRY)
    this.physics.spawnAll(values)

    // 联机模式：通知云端"该我摇了"，云端生成骰子值后推送给所有人
    // 本地先播动画，watch 回调收到真实骰子值后以云端为准
    if (this.isOnline) {
      this.network.rollDice([]).catch(e => console.error('rollDice err', e))
    }

    try {
      if (!this._shakeAudio) {
        this._shakeAudio = wx.createInnerAudioContext()
        this._shakeAudio.src = 'audio/shake.mp3'
        this._shakeAudio.onError(e => console.log('shake音效错误:', e))
      }
      this._shakeAudio.stop()
      this._shakeAudio.play()
    } catch (e) { console.log('音效失败:', e) }
  }

  _finishRoll() {
    const finalValues = this.physics.dice.map(d => d.value)
    this.diceValues = finalValues

    const result = evaluateDice(finalValues)
    this.lastResult = result

    this._speak(result)

    if (result.type === 'none') {
      this.lastPayout = 0
      this.state = STATE.RESULT
    } else {
      const payout = result.amount === Infinity ? this.pool : Math.min(result.amount, this.pool)
      this.lastPayout = payout
      this.pool -= payout
      if (this.pool < 0) this.pool = 0
      this.players[this.currentPlayer].chips += payout

      const emojis = result.amount === Infinity
        ? ['🎲', '💰', '🎰', '⭐', '🔥']
        : ['🎲', '✨', '💛']
      this.ui.spawnParticles(this.bowlCX, this.bowlCY, emojis, result.amount === Infinity ? 20 : 10)

      this.state = STATE.RESULT

      if (this.pool === 0) {
        setTimeout(() => this._endRound(), 1200)
        return
      }
    }
  }

  _preloadAllTTS() {}

  _speak(result) {
    if (!result || result.type === 'none') return
    const text = result.call || result.label
    if (!text) return
    try {
      const filename = 'audio/tts/' + text.replace(/[！!～~]/g, '') + '.mp3'
      const audio = wx.createInnerAudioContext()
      audio.src = filename
      audio.onError(() => audio.destroy())
      audio.onEnded(() => audio.destroy())
      audio.play()
    } catch(e) {}
  }

  _nextTurn() {
    if (this.isOnline) {
      // 联机：通知云端换人，本地等待watch推送
      this.network.nextTurn().catch(e => console.error('nextTurn err', e))
      this.state = STATE.IDLE
      return
    }
    // 单机逻辑不变
    let next = (this.currentPlayer + 1) % this.players.length
    let tries = 0
    while (!this.players[next].active && tries < this.players.length) {
      next = (next + 1) % this.players.length
      tries++
    }
    this.currentPlayer = next
    this.physics = null
    this.state = STATE.IDLE
    this._startAutoRollTimer()
  }

  _endRound() {
    if (this.mode === 'battle') {
      this.players.forEach(p => {
        if (p.active && p.chips <= 0) p.active = false
      })
      const alive = this.players.filter(p => p.active)
      if (alive.length === 1) {
        this.state = STATE.WINNER
        this.ui.spawnParticles(this.w / 2, this.h / 2, ['🏆', '⭐', '🎉', '🎊'], 30)
        return
      }
    }
    this.state = STATE.NEXT_ROUND
  }

  _startNextRound() {
    this.round++
    this.pool = 0

    if (this.mode === 'battle') {
      const alive = this.players.filter(p => p.active)
      alive.sort((a, b) => a.chips - b.chips)
      this.currentPlayer = this.players.indexOf(alive[0])
      const minChips = alive[0].chips
      this.stake = minChips * alive.length
    } else {
      this.currentPlayer = 0
    }

    this._collectPool()
    this.physics = null
    this.diceValues = [1, 2, 3, 4, 5, 6]
    this.state = STATE.IDLE
    this._startAutoRollTimer()
  }

  _restartGame() {
    if (this.isOnline) this.network.leaveRoom().catch(() => {})
    this.isOnline = false
    this.activityCode = ''
    this.roomData = null
    this.state = STATE.SETUP
    this.players = []
    this.pool = 0
    this.physics = null
  }

  // ── Auto Roll Timer ────────────────────────────
  _startAutoRollTimer() {
    // 联机模式：只有当前玩家计时
    if (this.isOnline && !this._isMyTurn()) return
    this._clearAutoRollTimer()
    this.autoRollRemaining = this.autoRollSeconds
    this.autoRollTimer = setInterval(() => {
      this.autoRollRemaining--
      if (this.autoRollRemaining <= 0) {
        this._clearAutoRollTimer()
        if (this.state === STATE.IDLE) this._startRoll()
      }
    }, 1000)
  }

  _clearAutoRollTimer() {
    if (this.autoRollTimer !== null) {
      clearInterval(this.autoRollTimer)
      this.autoRollTimer = null
    }
    this.autoRollRemaining = this.autoRollSeconds
  }

  // ── 联机工具方法 ────────────────────────────────
  _isMyTurn() {
    if (!this.roomData) return true
    return this.network.isMyTurn(this.roomData)
  }

  _currentPlayerName() {
    const p = this.players[this.currentPlayer]
    return p ? (p.nickname || p.name || '玩家') : ''
  }


  // 头像图片缓存加载
  _loadAvatar(player) {
    if (!this._avatarCache) this._avatarCache = {}
    const key = player.openid
    if (key in this._avatarCache) return
    if (!player.avatarUrl) { this._avatarCache[key] = null; return }
    this._avatarCache[key] = 'loading'
    // 微信临时路径需先 getImageInfo 转成可用路径再塞给 canvas image
    wx.getImageInfo({
      src: player.avatarUrl,
      success: (info) => {
        const img = this.canvas.createImage()
        img.onload = () => { this._avatarCache[key] = img }
        img.onerror = () => { this._avatarCache[key] = null }
        img.src = info.path
      },
      fail: () => { this._avatarCache[key] = null }
    })
  }

  // 安全绘制头像圆（处理 loading/null/image 三种状态）
  _drawAvatar(ctx, key, url, x, y, r) {
    if (!this._avatarCache) this._avatarCache = {}
    const img = this._avatarCache[key]
    // 背景圆
    ctx.fillStyle = 'rgba(212,172,13,0.2)'
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
    if (img && img !== 'loading' && img !== null) {
      try {
        ctx.save()
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.clip()
        ctx.drawImage(img, x - r, y - r, r * 2, r * 2)
        ctx.restore()
      } catch(e) {
        this._avatarCache[key] = null
      }
    } else if (!img) {
      this._loadAvatar({ openid: key, avatarUrl: url })
    }
  }

  // 从分享链接进入，自动触发联机加入流程
  autoJoinRoom(roomCode) {
    this._enterLobby().then(() => {
      this._joinOnlineRoom(roomCode)
    })
  }
}

module.exports = Game