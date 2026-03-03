// js/Game.js - 主游戏逻辑
// v1.1.0：接入联机层（Network.js）+ 管理员面板（AdminPanel.js）
// 原有单机逻辑完整保留，isOnline 标志切换两种模式

import { UI } from './UI.js'
import { PhysicsWorld, PhysicsDie } from './Physics.js'
import { evaluateDice } from './Rules.js'
import { Network } from './Network.js'
import { AdminPanel } from './AdminPanel.js'

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

export default class Game {
  constructor(canvas) {
    this.canvas = canvas

    const logicW = canvas.width
    const logicH = canvas.height

    // 读取安全区，避免灵动岛/刘海遮挡
    let safeTop = 60
    try {
      const info = wx.getWindowInfo()
      safeTop = (info.safeArea ? info.safeArea.top : 0) + 16
    } catch(e) {}
    this.safeTop = safeTop

    this.ui = new UI(canvas, logicW, logicH, this.safeTop)
    this.w = logicW
    this.h = logicH

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
    this._lobbyView = 'main'     // 'main' | 'join'
    this._lobbyJoinCode = ''
    this._lobbyLoading = false
    this._lobbyError = ''

    this._bindEvents()
  }

  start() {
    // 不在启动时登录，只有玩家主动点「联机游戏」才触发网络请求
    this._loop()
  }

  // ── Main Loop ──────────────────────────────────
  _loop() {
    const tick = () => {
      this._update()
      this._draw()
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
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
    ui.drawHeader('阿嗲好婆叫侬白相', subtitle)
    ui.drawExitButton()
    ui.drawPool(this.pool)
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
    ctx.fillText(`等待 ${name} 摇骰子...`, this.w / 2, this.h - 130)
  }

  // ── Setup Screen ──────────────────────────────
  _drawSetup() {
    const ctx = this.canvas.getContext('2d')
    const ui = this.ui
    const w = this.w
    const h = this.h
    const st = this.safeTop

    ctx.textAlign = 'center'
    ctx.fillStyle = '#D4AC0D'
    ctx.font = 'bold 34px serif'
    ctx.fillText('阿嗲好婆叫侬白相', w / 2, st + 36)
    ctx.fillStyle = 'rgba(212,172,13,0.5)'
    ctx.font = '13px sans-serif'
    ctx.fillText('苏州祖传骰子游戏', w / 2, st + 62)

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
    ctx.fillText('底池金额（每人）', 40, st + 104)

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
    ctx.fillText('游戏模式', 40, st + 176)

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
    const btnY = h - 148
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
    ctx.fillText('🌐  联 机 游 戏', w / 2, btnY + 94)
  }

  // ── 联机大厅 ────────────────────────────────────
  _drawLobby() {
    const ctx = this.ui.ctx
    const ui = this.ui
    const w = this.w
    const h = this.h
    const st = this.safeTop

    // Header
    ctx.textAlign = 'center'
    ctx.fillStyle = '#D4AC0D'
    ctx.font = 'bold 28px serif'
    ctx.fillText('阿嗲好婆叫侬白相', w / 2, st + 36)
    ctx.fillStyle = 'rgba(212,172,13,0.5)'
    ctx.font = '13px sans-serif'
    ctx.fillText('联机游戏大厅', w / 2, st + 60)

    // 返回按钮
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ui._roundRect(12, st + 12, 56, 30, 8)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '13px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('← 返回', 40, st + 32)

    // 玩家信息
    if (this.network.nickname) {
      ctx.fillStyle = 'rgba(255,255,255,0.3)'
      ctx.font = '13px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(`👤  ${this.network.nickname}`, w / 2, st + 90)
    }

    const cx = w / 2
    let y = st + 130

    if (this._lobbyLoading) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)'
      ctx.font = '16px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('连接中...', cx, h / 2)
      return
    }

    if (this._lobbyError) {
      ctx.fillStyle = '#FF6B5B'
      ctx.font = '14px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(this._lobbyError, cx, y)
      y += 32
    }

    // 创建房间
    ctx.fillStyle = '#C0392B'
    ui._roundRect(40, y, w - 80, 60, 14)
    ctx.fill()
    ctx.fillStyle = '#FFFFFF'
    ctx.font = 'bold 19px serif'
    ctx.textAlign = 'center'
    ctx.fillText('🎲  创建新房间', cx, y + 38)
    y += 80

    // 加入房间
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.strokeStyle = 'rgba(255,255,255,0.2)'
    ctx.lineWidth = 1
    ui._roundRect(40, y, w - 80, 60, 14)
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = '#FFFFFF'
    ctx.font = 'bold 19px serif'
    ctx.textAlign = 'center'
    ctx.fillText('🔑  输入房间号加入', cx, y + 38)
    y += 80

    // 如果已在房间，显示当前活动码
    if (this.activityCode) {
      ctx.fillStyle = 'rgba(212,172,13,0.15)'
      ctx.strokeStyle = 'rgba(212,172,13,0.3)'
      ctx.lineWidth = 1
      ui._roundRect(40, y, w - 80, 72, 12)
      ctx.fill(); ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.4)'
      ctx.font = '12px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('当前房间号（分享给好友）', cx, y + 22)
      ctx.fillStyle = '#D4AC0D'
      ctx.font = 'bold 28px serif'
      ctx.fillText(this.activityCode, cx, y + 54)
    }
  }

  // ── Events ─────────────────────────────────────
  _bindEvents() {
    wx.onTouchStart(e => this._onTouch(e.touches[0]))
    wx.onTouchEnd(() => { this.rollPressed = false })

    wx.onHide(() => { this._wasHidden = true })
    wx.onShow(() => {
      if (this._wasHidden && this.state !== STATE.SETUP && this.state !== STATE.LOBBY) {
        this._wasHidden = false
        wx.showModal({
          title: '继续游戏？',
          content: '要继续当前游戏还是退出？',
          confirmText: '继续',
          cancelText: '退出',
          success: (res) => {
            if (!res.confirm) wx.exitMiniProgram()
          }
        })
      } else {
        this._wasHidden = false
      }
    })
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
        title: '退出游戏',
        content: '确定退出当前游戏？',
        confirmText: '退出',
        cancelText: '继续',
        confirmColor: '#C0392B',
        success: (res) => {
          if (res.confirm) this._restartGame()
        }
      })
      return
    }

    // 标题区点击（游戏中也可进管理员，排除退出按钮区域）
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
              placeholderText: '输入金额',
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
    const btnY = h - 148
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
    this._lobbyLoading = true
    this._lobbyError = ''
    try {
      await this.network.login()
      this._lobbyLoading = false
    } catch {
      this._lobbyLoading = false
      this._lobbyError = '登录失败，请检查网络'
    }
  }

  _handleLobbyTouch(tx, ty) {
    const st = this.safeTop
    const w = this.w

    // 返回
    if (tx < 80 && ty >= st + 12 && ty <= st + 42) {
      this.state = STATE.SETUP
      this.isOnline = false
      return
    }

    let y = st + 130
    if (this._lobbyError) y += 32

    // 创建房间
    if (ty >= y && ty <= y + 60) {
      this._createOnlineRoom()
      return
    }
    y += 80

    // 加入房间
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

  async _createOnlineRoom() {
    this._lobbyLoading = true
    this._lobbyError = ''
    try {
      const res = await this.network.createRoom({
        stake: this.setupStake,
        maxPlayers: 6,
      })
      if (res.success) {
        this.activityCode = res.roomCode || res.activityCode
        this._bindRoomCallbacks()
        this._startOnlineGame(res.roomData)
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
        this.activityCode = res.roomCode || code
        this._bindRoomCallbacks()
        this._startOnlineGame(res.roomData)
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

    // 同步玩家列表（用云端数据，nickname/avatarUrl替代本地name）
    this.players = roomData.players.map(p => ({
      ...p,
      name: p.nickname,   // 兼容本地渲染逻辑
      chips: p.chips,
      active: p.active,
    }))
    this.currentPlayer = roomData.currentPlayerIndex

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

    // 游戏结束
    if (roomData.status === 'finished') {
      this.state = STATE.WINNER
    }
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
}