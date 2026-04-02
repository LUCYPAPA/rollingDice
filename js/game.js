// js/game.js
// v1.2.0
// 改动说明：
//   1. 对决版 _startGame    — 初始化时 chips = 带入金额（setupStake），不再等于 0
//   2. 对决版 _collectPool  — 逻辑不变，但依赖正确的初始 chips
//   3. 对决版 _startNextRound — 基数取当前存活玩家最小余额，不再用 stake 字段
//   4. 联机大厅              — 新玩家欢迎卡（首次赠 100 点）、余额常驻显示
//   5. 联机大厅              — 「我的手气记录」入口、房主「我创建的房间」入口
//   6. 局后账单弹窗          — 结算后展示赛前→赛后余额 + 参与玩家列表
//   7. 「手气记录」页面      — Canvas 全屏绘制，列表+返回
//   8. 「房主明细」页面      — Canvas 全屏绘制，对局列表+点击查明细

const { UI }          = require('./UI.js')
const { PhysicsWorld } = require('./Physics.js')
const { evaluateDice } = require('./Rules.js')
const { Network }     = require('./Network.js')
const { AdminPanel }  = require('./AdminPanel.js')

const STATE = {
  SETUP:      'setup',
  LOBBY:      'lobby',
  IDLE:       'idle',
  WAITING:    'waiting',   // 联机：已点下一位，等服务端推送
  ROLLING:    'rolling',
  RESULT:     'result',
  NEXT_ROUND: 'next_round',
  WINNER:     'winner',
  // 新增：历史记录页和房主明细页
  MY_GAMES:    'my_games',
  HOST_GAMES:  'host_games',
  HOST_DETAIL: 'host_detail',
}

class Game {
  constructor(canvas, logicW, logicH, dpr) {
    this.canvas = canvas

    let safeTop = 60, safeBottom = 0
    try {
      const info = wx.getWindowInfo()
      safeTop    = (info.safeArea ? info.safeArea.top    : 0) + 16
      safeBottom =  info.safeArea ? (info.screenHeight - info.safeArea.bottom) : 0
    } catch (e) {}
    this.safeTop    = safeTop
    this.safeBottom = safeBottom

    this.ui = new UI(canvas, logicW, logicH, this.safeTop, dpr, this.safeBottom)
    this.w  = logicW || 375
    this.h  = logicH || 812

    this.bowlCX = this.w / 2
    this.bowlCY = this.h * 0.46
    this.bowlRX = this.w * 0.38
    this.bowlRY = this.h * 0.19

    // 游戏状态
    this.state         = STATE.SETUP
    this.players       = []
    this.currentPlayer = 0
    this.pool          = 0
    this.stake         = 32
    this.mode          = 'classic'
    this.round         = 1
    this.physics       = null
    this.diceValues    = [1, 2, 3, 4, 5, 6]
    this.lastResult    = null
    this.lastPayout    = 0
    this.rollPressed   = false
    this.autoRollTimer     = null
    this.autoRollSeconds   = 60
    this.autoRollRemaining = 60

    // Setup 页状态
    this.setupPlayers = ['阿七头', '曹莱西', '桌西君']
    this.setupStake   = 32
    this.setupMode    = 'classic'
    this.setupFocus   = null

    // 联机相关
    this.isOnline      = false
    this.network       = new Network()
    this.adminPanel    = new AdminPanel(this.ui, this.network)
    this.roomData      = null
    this.activityCode  = ''
    this._titleTapCount = 0
    this._titleTapTimer = null
    this._lobbyView    = 'main'   // 'main' | 'waiting'
    this._lobbyJoinCode = ''
    this._lobbyLoading = false
    this._lobbyError   = ''
    this._isHost       = false

    this._lastServerDiceKey  = ''
    this._pendingServerRoll   = false
    this._serverRollTimeout   = null
    this._pendingServerResult = null
    this._waitingRoundEnd     = false  // 联机：缓存云端结算结果，等本地动画结束后消费
    this._waitingRoundEnd     = false // 动画已结束但 round_end 推送还没到

    // ── 新增：余额与首次赠礼 ──────────────────────────────────
    this._myBalance    = 0      // 当前账号余额，login 后赋值
    this._isNewPlayer  = false  // 是否首次登录，决定是否显示欢迎卡
    this._showWelcome  = false  // 欢迎卡显示标记
    this._welcomeTimer = null   // 欢迎卡自动消失计时器

    // ── 新增：局后账单 ────────────────────────────────────────
    this._showSettleCard  = false   // 是否显示局后账单
    this._settleData      = null    // 账单数据 { balanceBefore, balanceAfter, players }

    // ── 新增：手气记录页 ──────────────────────────────────────
    this._myGamesList   = []
    this._myGamesLoading = false
    this._myGamesFrom   = 'lobby'  // 从哪里进来的（lobby / settle），用于返回

    // ── 新增：房主对局列表页 ──────────────────────────────────
    this._hostGamesList    = []
    this._hostGamesLoading = false
    this._hostDetailData   = null   // 当前查看的明细
    this._hostDetailLoading = false
  }

  start() {
    this._loop()
    this._startShakeListener()
    // 打开小程序时显示欢迎卡，3秒后自动消失
    this._showWelcome = true
    this._welcomeTimer = setTimeout(() => { this._showWelcome = false }, 3000)
  }

  _startShakeListener() {
    let lastShake = 0
    wx.onAccelerometerChange((res) => {
      const { x, y, z } = res
      const force = Math.sqrt(x * x + y * y + z * z)
      if (force > 2.0) {
        const now = Date.now()
        if (now - lastShake < 1500) return
        lastShake = now
        this._onShake()
      }
    })
    wx.startAccelerometer({ interval: 'game' })
  }

  _onShake() {
    if (this.state !== STATE.IDLE) return
    if (this.isOnline && !this._isMyTurn()) return
    this.rollPressed = true
    this._startRoll()
  }

  destroy() {
    wx.stopAccelerometer()
    this._clearAutoRollTimer()
    clearTimeout(this._welcomeTimer)
    if (this.network) this.network.leaveRoom().catch(() => {})
  }

  // ── Main Loop ────────────────────────────────────────────────
  _loop() {
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
        if (this.isOnline) {
          // 联机版：动画播完后消费云端缓存的结果
          if (this._pendingServerResult) {
            const sr = this._pendingServerResult
            this._pendingServerResult = null
            // 把物理骰子的显示值替换成云端真实值，保持骰子位置不变
            if (sr.diceValues && sr.diceValues.length === this.physics.dice.length) {
              sr.diceValues.forEach((v, i) => {
                this.physics.dice[i].value        = v
                this.physics.dice[i].displayValue = v
              })
            }
            this.diceValues  = sr.diceValues || this.physics.dice.map(d => d.value)
            this.lastResult  = sr.result
            this.lastPayout  = sr.payout
            // 动画结束时才更新底池和玩家余额，保持与结果展示同步
            if (sr.pool !== undefined) this.pool = sr.pool
            if (sr.players) {
              this.players = sr.players.map(p => ({ ...p, name: p.nickname, chips: p.chips, balance: p.balance ?? null, active: p.active }))
            }
            this.state       = STATE.RESULT
            this._speak(sr.result)
            if (sr.result && sr.result.type !== 'none') {
              const emojis = sr.result.amount === Infinity
                ? ['🎲', '💰', '🎰', '⭐', '🔥']
                : ['🎲', '✨', '💛']
              this.ui.spawnParticles(this.bowlCX, this.bowlCY, emojis,
                sr.result.amount === Infinity ? 20 : 10)
            }
            // 动画结束时总是重置机器人状态（包括机器人清空底池触发 round_end 的情况）
            this._botAnimating = false
            if (sr.isBot) {
              setTimeout(() => this._triggerBotNext(), 2000)
            }
            // 如果是轮末，弹轮次结算弹窗
            if (sr.isRoundEnd) {
              if (sr.roundEndData) {
                // round_end 推送已经到了，1.5秒后弹窗（让玩家看清骰子结果）
                setTimeout(() => {
                  this._applyRoundEndState(sr.roundEndData)
                  this._showRoundEndResult(sr.roundEndData)
                }, 1500)
              } else {
                // round_end 推送还没到，把标记存起来，等推送到来时触发
                this._waitingRoundEnd = true
              }
            }
          }
          // 如果云端结果还没到，动画结束了先停在 settled 状态等
          // （超时保护会在7秒后回退到 IDLE）
        } else {
          // 单机版：本地直接结算
          this.diceValues = this.physics.dice.map(d => d.value)
          this._finishRoll()
        }
      }
    }
    this.ui.updateParticles()
  }

  _draw() {
    if (!this.w || !this.h || !isFinite(this.w) || !isFinite(this.h)) return
    const ui = this.ui
    ui.clear()

    // ── 历史记录页 ────────────────────────────────────────────
    if (this.state === STATE.MY_GAMES) {
      this._drawMyGames()
      return
    }
    if (this.state === STATE.HOST_GAMES) {
      this._drawHostGames()
      return
    }
    if (this.state === STATE.HOST_DETAIL) {
      this._drawHostDetail()
      return
    }

    if (this.state === STATE.SETUP) {
      this._drawSetup()
      this.adminPanel.draw()
      // this._drawAssistantBtn()  // 暂时隐藏：AI功能待企业主体审核
      if (this._showWelcome) this._drawWelcomeCard()
      return
    }

    if (this.state === STATE.LOBBY) {
      this._drawLobby()
      // this._drawAssistantBtn()  // 暂时隐藏：AI功能待企业主体审核
      return
    }

    if (this.state === STATE.WINNER) {
      const winner = this.players.find(p => p.active)
      ui.drawWinner(winner ? (winner.nickname || winner.name) : '大家')
      ui.drawParticles()
      this.adminPanel.draw()
      // this._drawAssistantBtn()  // 暂时隐藏：AI功能待企业主体审核
      // 局后账单叠在最上层
      if (this._showSettleCard) this._drawSettleCard()
      return
    }

    // 游戏中主画面
    const subtitle = this.isOnline
      ? `房间号 ${this.network.currentRoomCode || this.activityCode}  ·  第 ${this.round} 轮`
      : `第 ${this.round} 轮`
    ui.drawHeader('好婆叫侬掷骰子了', subtitle)
    if (!this.isOnline) ui.drawExitButton()
    ui.drawPool(this.pool)

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
    // 联机版：「下一位」和「开始下一轮」只有当前回合玩家才能看到和点击
    // 联机底池归零时不显示"下一位"，等结算弹窗引导流程
    const showNextBtn = (!this.isOnline || this._isMyTurn()) && !(this.isOnline && this.pool === 0)
    if (this.state === STATE.RESULT && showNextBtn) {
      ui.drawNextButton('下一位 →')
    } else if (this.state === STATE.NEXT_ROUND && showNextBtn) {
      ui.drawNextButton('开始下一轮 🔄')
    }

    if (this.state === STATE.WAITING) {
      // 联机：已发出 nextTurn，等服务端响应，不显示任何操作按钮
      this._drawWaitingLabel()
    }

    if (this.state === STATE.IDLE) {
      const showRoll = !this.isOnline || this._isMyTurn()
      if (showRoll) {
        ui.drawRollButton(this.rollPressed, '摇 骰 子')
      } else {
        this._drawWaitingLabel()
      }
      ui.drawTurnLabel(this._currentPlayerName())
    }

    ui.drawPlayers(this.players, this.currentPlayer)
    ui.drawParticles()
    this.adminPanel.draw()
    // this._drawAssistantBtn()  // 暂时隐藏：AI功能待企业主体审核

    // 局后账单叠最上层
    if (this._showSettleCard) this._drawSettleCard()
  }

  // ── Setup ────────────────────────────────────────────────────
  _drawSetup() {
    const ctx = this.ui.ctx
    const ui  = this.ui
    const w   = this.w
    const h   = this.h
    const st  = this.safeTop

    ctx.textAlign = 'center'
    ctx.fillStyle = '#D4AC0D'
    ctx.font = 'bold 34px serif'
    ctx.fillText('好婆叫侬掷骰子了', w / 2, st + 36)

    ctx.strokeStyle = 'rgba(212,172,13,0.2)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(40, st + 76)
    ctx.lineTo(w - 40, st + 76)
    ctx.stroke()

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
      ctx.fillStyle   = this.setupMode === m ? 'rgba(192,57,43,0.4)' : 'rgba(255,255,255,0.05)'
      ctx.strokeStyle = this.setupMode === m ? '#C0392B' : 'rgba(255,255,255,0.15)'
      ctx.lineWidth   = this.setupMode === m ? 2 : 1
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
      ctx.fillStyle   = this.setupFocus === `player_${i}` ? 'rgba(212,172,13,0.15)' : 'rgba(255,255,255,0.05)'
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
      ctx.fillStyle   = 'rgba(212,172,13,0.08)'
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

    const btnY = h - 148 - (this.safeBottom || 0)
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

    ctx.fillStyle   = 'rgba(192,57,43,0.15)'
    ctx.strokeStyle = 'rgba(192,57,43,0.5)'
    ctx.lineWidth = 1.5
    ui._roundRect(40, btnY + 64, w - 80, 48, 14)
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = '#FF6B5B'
    ctx.font = 'bold 18px serif'
    ctx.textAlign = 'center'
    ctx.fillText('🌐  联  机', w / 2, btnY + 94)

    // 关注作者按钮
    ctx.fillStyle   = 'rgba(255,255,255,0.04)'
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'
    ctx.lineWidth = 1
    ui._roundRect(40, btnY + 124, w - 80, 36, 10)
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,0.3)'
    ctx.font = '13px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('关注作者 CROSS-RANGE', w / 2, btnY + 148)
  }

  // ── 联机大厅 ─────────────────────────────────────────────────
  _drawLobby() {
    const ctx = this.ui.ctx
    const ui  = this.ui
    const w   = this.w
    const h   = this.h
    const st  = this.safeTop
    const sb  = this.safeBottom || 0
    const cx  = w / 2

    ctx.textAlign = 'center'
    ctx.fillStyle = '#D4AC0D'
    ctx.font = 'bold 26px serif'
    ctx.fillText('好婆叫侬掷骰子了', cx, st + 36)

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

    // ── 等待室 ────────────────────────────────────────────────
    if (this._lobbyView === 'waiting') {
      this._drawLobbyWaiting()
      return
    }

    // ── 主视图 ────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(212,172,13,0.5)'
    ctx.font = '13px sans-serif'
    ctx.fillText('联机大厅', cx, st + 62)

    // 昵称 + 余额行
    const nick = this.network.nickname || ''
    if (nick) {
      const avatarX = cx - 80
      const avatarY = st + 78
      const avatarR = 18
      this._drawAvatar(ctx, '_self', this.network.avatarUrl || '', avatarX, avatarY, avatarR)
      ctx.fillStyle = 'rgba(255,255,255,0.6)'
      ctx.font = '14px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(nick, cx - 20, st + 83)

      // ── 改动：余额常驻显示 ──────────────────────────────────
      ctx.fillStyle = '#D4AC0D'
      ctx.font = 'bold 13px sans-serif'
      ctx.fillText(`余额：${this._myBalance} 点`, cx - 20, st + 101)

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

    let y = st + 128
    if (this._lobbyError) {
      ctx.fillStyle = '#FF6B5B'
      ctx.font = '14px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(this._lobbyError, cx, y)
      y += 36
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
    ctx.fillStyle   = 'rgba(255,255,255,0.07)'
    ctx.strokeStyle = 'rgba(255,255,255,0.2)'
    ctx.lineWidth = 1
    ui._roundRect(40, y, w - 80, 60, 14)
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = '#FFFFFF'
    ctx.font = 'bold 19px serif'
    ctx.textAlign = 'center'
    ctx.fillText('🔑  输入房间号加入', cx, y + 38)
    y += 80

    // ── 改动：「我的手气记录」按钮 ────────────────────────────
    ctx.fillStyle   = 'rgba(212,172,13,0.08)'
    ctx.strokeStyle = 'rgba(212,172,13,0.3)'
    ctx.lineWidth = 1
    ui._roundRect(40, y, (w - 96) / 2, 48, 12)
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = 'rgba(212,172,13,0.8)'
    ctx.font = '14px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('📜 手气记录', 40 + (w - 96) / 4, y + 28)

    // ── 改动：房主「我创建的房间」按钮（同行右侧）────────────
    const btnR = 40 + (w - 96) / 2 + 16
    ctx.fillStyle   = 'rgba(212,172,13,0.08)'
    ctx.strokeStyle = 'rgba(212,172,13,0.3)'
    ctx.lineWidth = 1
    ui._roundRect(btnR, y, (w - 96) / 2, 48, 12)
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = 'rgba(212,172,13,0.8)'
    ctx.font = '14px sans-serif'
    ctx.fillText('🧾 我的房间', btnR + (w - 96) / 4, y + 28)

    // ── 改动：新玩家欢迎卡（叠在最上层）─────────────────────
    if (this._showWelcome) this._drawWelcomeCard()
  }

  _drawLobbyWaiting() {
    const ctx = this.ui.ctx
    const ui  = this.ui
    const w   = this.w
    const h   = this.h
    const st  = this.safeTop
    const sb  = this.safeBottom || 0
    const cx  = w / 2

    ctx.fillStyle = 'rgba(212,172,13,0.5)'
    ctx.font = '14px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(this._isHost ? '房间已创建，等待好友加入' : '已加入，等待房主开始', cx, st + 62)

    if (this.network.nickname) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.font = '13px sans-serif'
      ctx.fillText('👤  ' + this.network.nickname, cx, st + 86)
    }

    const cardY = st + 110
    ctx.fillStyle   = 'rgba(212,172,13,0.1)'
    ctx.strokeStyle = 'rgba(212,172,13,0.45)'
    ctx.lineWidth = 1.5
    ui._roundRect(32, cardY, w - 64, 108, 18)
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('房间号（点击下方按钮分享给好友）', cx, cardY + 24)
    ctx.fillStyle = '#D4AC0D'
    ctx.font = 'bold 56px serif'
    ctx.fillText(this.activityCode || '----', cx, cardY + 88)

    const shareY = cardY + 124
    ctx.fillStyle   = 'rgba(7,193,96,0.18)'
    ctx.strokeStyle = 'rgba(7,193,96,0.55)'
    ctx.lineWidth = 1
    ui._roundRect(32, shareY, w - 64, 50, 13)
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = '#07C160'
    ctx.font = 'bold 16px sans-serif'
    ctx.fillText('📤  分享房间号给微信好友', cx, shareY + 32)

    const listY = shareY + 68
    const players = this._waitingPlayers || []
    ctx.fillStyle = 'rgba(255,255,255,0.28)'
    ctx.font = '13px sans-serif'
    ctx.fillText('已加入 ' + players.length + ' 人', cx, listY)
    players.forEach((p, i) => {
      const rowX = cx + (i - (players.length - 1) / 2) * 72
      this._drawAvatar(ctx, p.openid, p.avatarUrl || '', rowX, listY + 52, 22)
      ctx.fillStyle = p.isBot ? 'rgba(255,200,80,0.7)' : 'rgba(255,255,255,0.7)'
      const maxW = 64
      let nick = p.nickname, fontSize = 12
      ctx.font = fontSize + 'px sans-serif'
      while (ctx.measureText(nick).width > maxW && fontSize > 8) {
        fontSize--; ctx.font = fontSize + 'px sans-serif'
      }
      if (ctx.measureText(nick).width > maxW) {
        while (ctx.measureText(nick + '…').width > maxW && nick.length > 1) nick = nick.slice(0, -1)
        nick = nick + '…'
      }
      ctx.fillText(nick, rowX, listY + 90)
    })

    if (this._isHost) {
      const botY   = h - 136 - sb
      const startY = h - 72  - sb
      const canStart = players.length >= 2
      ctx.fillStyle   = 'rgba(255,255,255,0.06)'
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
      ctx.lineWidth = 1
      ui._roundRect(32, botY, w - 64, 48, 12)
      ctx.fill(); ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.5)'
      ctx.font = '15px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('🤖  添加机器人陪练', cx, botY + 30)

      ctx.fillStyle = canStart ? '#C0392B' : 'rgba(80,30,20,0.6)'
      ui._roundRect(32, startY, w - 64, 52, 14)
      ctx.fill()
      ctx.fillStyle = canStart ? '#FFFFFF' : 'rgba(255,255,255,0.25)'
      ctx.font = 'bold 19px serif'
      ctx.fillText(canStart ? '开 始 游 戏' : '至少 2 人才能开始', cx, startY + 34)
    }
  }

  // ── 新增：新玩家欢迎卡 ───────────────────────────────────────
  _drawWelcomeCard() {
    const ctx = this.ui.ctx
    const ui  = this.ui
    const w   = this.w
    const cx  = w / 2
    const cardW = w - 64
    const cardH = 168
    const cardX = 32
    const cardY = this.h * 0.3

    // 遮罩
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(0, 0, w, this.h)

    // 卡片
    ctx.fillStyle   = 'rgba(30,15,8,0.97)'
    ctx.strokeStyle = '#D4AC0D'
    ctx.lineWidth   = 1.5
    ui._roundRect(cardX, cardY, cardW, cardH, 18)
    ctx.fill(); ctx.stroke()

    ctx.textAlign = 'center'
    ctx.fillStyle = '#D4AC0D'
    ctx.font = 'bold 22px serif'
    ctx.fillText('好婆叫侬来白相', cx, cardY + 38)

    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.font = '13px sans-serif'
    ctx.fillText('收录民间互动游戏，搬到线上，四世共乐。', cx, cardY + 66)

    ctx.strokeStyle = 'rgba(212,172,13,0.2)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(cardX + 20, cardY + 84)
    ctx.lineTo(cardX + cardW - 20, cardY + 84)
    ctx.stroke()

    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.font = '12px sans-serif'
    ctx.fillText('CROSS-RANGE · 家庭传承系列', cx, cardY + 102)

    ctx.fillStyle = 'rgba(255,255,255,0.2)'
    ctx.font = '11px sans-serif'
    ctx.fillText('点击任意处继续', cx, cardY + 150)
  }

  // ── 新增：局后账单弹窗 ───────────────────────────────────────
  _drawSettleCard() {
    if (!this._settleData) return
    const ctx = this.ui.ctx
    const ui  = this.ui
    const w   = this.w
    const h   = this.h
    const cx  = w / 2
    const d   = this._settleData

    // 遮罩
    ctx.fillStyle = 'rgba(0,0,0,0.75)'
    ctx.fillRect(0, 0, w, h)

    const evCount = Math.min((d.events || []).length, 8)
    const playerCount = Math.min((d.players || []).length, 6)
    const cardH = Math.min(h - 60, 230 + playerCount * 38 + (evCount > 0 ? 28 + evCount * 22 : 0) + 100)
    const cardY = (h - cardH) / 2
    ctx.fillStyle   = 'rgba(26,10,6,0.98)'
    ctx.strokeStyle = 'rgba(212,172,13,0.5)'
    ctx.lineWidth   = 1.5
    ui._roundRect(24, cardY, w - 48, cardH, 20)
    ctx.fill(); ctx.stroke()

    ctx.textAlign = 'center'
    ctx.fillStyle = '#D4AC0D'
    ctx.font = 'bold 18px serif'
    ctx.fillText('本局结算', cx, cardY + 30)

    // 分割线
    ctx.strokeStyle = 'rgba(212,172,13,0.2)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(40, cardY + 44)
    ctx.lineTo(w - 40, cardY + 44)
    ctx.stroke()

    // 自己的余额变动
    const earned  = (d.balanceAfter || 0) - (d.balanceBefore || 0)
    const earnStr = earned > 0 ? `+${earned}` : String(earned)
    const earnColor = earned > 0 ? '#2ECC71' : earned < 0 ? '#E74C3C' : 'rgba(255,255,255,0.4)'

    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.font = '12px sans-serif'
    ctx.fillText('赛前余额', cx - 60, cardY + 72)
    ctx.fillText('赛后余额', cx + 60, cardY + 72)

    ctx.fillStyle = '#FFFFFF'
    ctx.font = 'bold 22px serif'
    ctx.fillText(`${d.balanceBefore ?? '--'}`, cx - 60, cardY + 98)
    ctx.fillText(`${d.balanceAfter  ?? '--'}`, cx + 60, cardY + 98)

    ctx.fillStyle = 'rgba(255,255,255,0.3)'
    ctx.font = '18px sans-serif'
    ctx.fillText('→', cx, cardY + 98)

    ctx.fillStyle = earnColor
    ctx.font = 'bold 16px sans-serif'
    ctx.fillText(earnStr + ' 点', cx, cardY + 122)

    // 参与玩家列表
    ctx.fillStyle = 'rgba(255,255,255,0.3)'
    ctx.font = '12px sans-serif'
    ctx.fillText('本局玩家', cx, cardY + 150)

    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(40, cardY + 158)
    ctx.lineTo(w - 40, cardY + 158)
    ctx.stroke()

    const playerList = (d.players || []).slice(0, 6)
    playerList.forEach((p, i) => {
      const ry = cardY + 170 + i * 38
      ctx.fillStyle = '#FFFFFF'
      ctx.font = '14px sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(p.nickname || '玩家', 48, ry + 16)
      const pEarned = (p.balanceAfter || 0) - (p.balanceBefore || 0)
      ctx.fillStyle = pEarned > 0 ? '#2ECC71' : pEarned < 0 ? '#E74C3C' : 'rgba(255,255,255,0.4)'
      ctx.font = 'bold 14px sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText(`${p.balanceAfter ?? '--'} 点`, w - 48, ry + 16)
    })

    // 每把记录
    const evList = (d.events || []).slice(-8)
    if (evList.length > 0) {
      const evTop = cardY + 170 + playerList.length * 38 + 10
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(40, evTop)
      ctx.lineTo(w - 40, evTop)
      ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.3)'
      ctx.font = '12px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('每把记录（最近）', cx, evTop + 16)
      evList.forEach((ev, i) => {
        const ey = evTop + 28 + i * 22
        const dice = (ev.diceValues || []).join(' ')
        const payout = ev.payout > 0 ? `+${ev.payout}` : String(ev.payout || 0)
        const nick = (ev.playerNickname || '?').slice(0, 4)
        ctx.fillStyle = 'rgba(255,255,255,0.5)'
        ctx.font = '11px sans-serif'
        ctx.textAlign = 'left'
        ctx.fillText(`${nick}  🎲${dice}`, 40, ey)
        ctx.fillStyle = ev.payout > 0 ? '#2ECC71' : 'rgba(255,255,255,0.35)'
        ctx.font = 'bold 11px sans-serif'
        ctx.textAlign = 'right'
        ctx.fillText(payout, w - 40, ey)
      })
    }

    // 操作按钮
    const btnY = cardY + cardH - 96
    ctx.fillStyle = 'rgba(212,172,13,0.12)'
    ctx.strokeStyle = 'rgba(212,172,13,0.4)'
    ctx.lineWidth = 1
    ui._roundRect(32, btnY, (w - 80) / 2, 40, 10)
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = '#D4AC0D'
    ctx.font = '13px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('📜 手气记录', 32 + (w - 80) / 4, btnY + 25)

    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.strokeStyle = 'rgba(255,255,255,0.2)'
    ui._roundRect(32 + (w - 80) / 2 + 16, btnY, (w - 80) / 2, 40, 10)
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.fillText('返回大厅', 32 + (w - 80) / 2 + 16 + (w - 80) / 4, btnY + 25)

    // 关闭小叉
    ctx.fillStyle = 'rgba(255,255,255,0.25)'
    ctx.font = '18px sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText('✕', w - 32, cardY + 24)
  }

  // ── 新增：手气记录页 ─────────────────────────────────────────
  _drawMyGames() {
    const ctx = this.ui.ctx
    const ui  = this.ui
    const w   = this.w
    const h   = this.h
    const st  = this.safeTop
    const cx  = w / 2

    ctx.textAlign = 'center'
    ctx.fillStyle = '#D4AC0D'
    ctx.font = 'bold 20px serif'
    ctx.fillText('我的手气记录', cx, st + 28)

    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ui._roundRect(12, st + 10, 60, 30, 8)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '13px sans-serif'
    ctx.fillText('← 返回', 42, st + 30)

    if (this._myGamesLoading) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)'
      ctx.font = '15px sans-serif'
      ctx.fillText('加载中...', cx, h / 2)
      return
    }

    if (this._myGamesList.length === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)'
      ctx.font = '15px sans-serif'
      ctx.fillText('暂无对局记录', cx, h / 2)
      return
    }

    const startY = st + 56
    this._myGamesList.forEach((g, i) => {
      const ry = startY + i * 78
      if (ry > h - 20) return

      // 行背景
      ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.04)' : 'transparent'
      ctx.fillRect(0, ry, w, 76)

      // 房间号 + 日期
      ctx.fillStyle = 'rgba(255,255,255,0.8)'
      ctx.font = 'bold 14px sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(`房间 ${g.roomCode || '--'}`, 20, ry + 20)

      ctx.fillStyle = 'rgba(255,255,255,0.3)'
      ctx.font = '11px sans-serif'
      const dateStr = g.createdAt ? new Date(g.createdAt).toLocaleDateString('zh-CN') : ''
      ctx.fillText(dateStr, 20, ry + 38)

      // 参与玩家昵称
      ctx.fillStyle = 'rgba(255,255,255,0.25)'
      ctx.font = '11px sans-serif'
      ctx.fillText((g.playerNicknames || []).slice(0, 4).join('、'), 20, ry + 56)

      // 结束方式标签
      const tag = g.endReason === 'aborted' ? '终止' : '正常'
      const tagColor = g.endReason === 'aborted' ? 'rgba(192,57,43,0.6)' : 'rgba(46,204,113,0.4)'
      ctx.fillStyle = tagColor
      ui._roundRect(w - 70, ry + 8, 48, 22, 6)
      ctx.fill()
      ctx.fillStyle = '#FFFFFF'
      ctx.font = '11px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(tag, w - 46, ry + 23)

      // 余额变动
      const earned = g.earned
      if (earned !== null && earned !== undefined) {
        const sign  = earned > 0 ? '+' : ''
        const color = earned > 0 ? '#2ECC71' : earned < 0 ? '#E74C3C' : 'rgba(255,255,255,0.3)'
        ctx.fillStyle = color
        ctx.font = 'bold 15px sans-serif'
        ctx.textAlign = 'right'
        ctx.fillText(`${sign}${earned}`, w - 20, ry + 38)
      }

      // 分割线
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, ry + 76)
      ctx.lineTo(w, ry + 76)
      ctx.stroke()
    })
  }

  // ── 新增：房主对局列表页 ─────────────────────────────────────
  _drawHostGames() {
    const ctx = this.ui.ctx
    const ui  = this.ui
    const w   = this.w
    const h   = this.h
    const st  = this.safeTop
    const cx  = w / 2

    ctx.textAlign = 'center'
    ctx.fillStyle = '#D4AC0D'
    ctx.font = 'bold 20px serif'
    ctx.fillText('我创建的房间', cx, st + 28)

    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ui._roundRect(12, st + 10, 60, 30, 8)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '13px sans-serif'
    ctx.fillText('← 返回', 42, st + 30)

    if (this._hostGamesLoading) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)'
      ctx.font = '15px sans-serif'
      ctx.fillText('加载中...', cx, h / 2)
      return
    }

    if (this._hostGamesList.length === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)'
      ctx.font = '15px sans-serif'
      ctx.fillText('暂无创建记录', cx, h / 2)
      return
    }

    const startY = st + 56
    this._hostGamesList.forEach((g, i) => {
      const ry = startY + i * 68
      if (ry > h - 20) return

      ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.04)' : 'transparent'
      ctx.fillRect(0, ry, w, 66)

      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.font = 'bold 14px sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(`房间 ${g.roomCode || '--'}`, 20, ry + 22)

      ctx.fillStyle = 'rgba(255,255,255,0.3)'
      ctx.font = '11px sans-serif'
      const dateStr = g.createdAt ? new Date(g.createdAt).toLocaleDateString('zh-CN') : ''
      ctx.fillText(`${dateStr}  ·  ${g.playerCount || 0} 人`, 20, ry + 42)

      // 校验状态
      const vColor = g.verifyPassed === false ? '#E74C3C' : 'rgba(255,255,255,0.2)'
      const vText  = g.verifyPassed === false ? '⚠ 校验异常' : '✓'
      ctx.fillStyle = vColor
      ctx.font = '12px sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText(vText, w - 20, ry + 32)

      // 结束方式
      const tag = g.endReason === 'aborted' ? '终止' : '正常'
      ctx.fillStyle = g.endReason === 'aborted' ? 'rgba(192,57,43,0.6)' : 'rgba(46,204,113,0.4)'
      ui._roundRect(w - 70, ry + 8, 44, 20, 6)
      ctx.fill()
      ctx.fillStyle = '#FFFFFF'
      ctx.font = '11px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(tag, w - 48, ry + 22)

      // 点击进入明细的提示
      ctx.fillStyle = 'rgba(212,172,13,0.4)'
      ctx.font = '11px sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText('查看明细 >', w - 20, ry + 54)

      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, ry + 66)
      ctx.lineTo(w, ry + 66)
      ctx.stroke()
    })
  }

  // ── 新增：房主明细页 ─────────────────────────────────────────
  _drawHostDetail() {
    const ctx = this.ui.ctx
    const ui  = this.ui
    const w   = this.w
    const h   = this.h
    const st  = this.safeTop
    const cx  = w / 2
    const d   = this._hostDetailData

    ctx.textAlign = 'center'
    ctx.fillStyle = '#D4AC0D'
    ctx.font = 'bold 18px serif'
    ctx.fillText('对账明细', cx, st + 28)

    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ui._roundRect(12, st + 10, 60, 30, 8)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '13px sans-serif'
    ctx.fillText('← 返回', 42, st + 30)

    if (this._hostDetailLoading) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)'
      ctx.font = '15px sans-serif'
      ctx.fillText('加载中...', cx, h / 2)
      return
    }
    if (!d) return

    // 页头：房间号 + 时间 + 结束方式
    let y = st + 52
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'center'
    const dateStr = d.createdAt ? new Date(d.createdAt).toLocaleString('zh-CN') : ''
    ctx.fillText(`房间 ${d.roomCode}  ·  ${dateStr}`, cx, y)
    y += 18
    const endTag = d.endReason === 'aborted' ? '房主终止' : '正常结束'
    ctx.fillStyle = d.endReason === 'aborted' ? '#E74C3C' : '#2ECC71'
    ctx.fillText(endTag, cx, y)
    y += 6

    // 分割线
    ctx.strokeStyle = 'rgba(212,172,13,0.2)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(w - 20, y); ctx.stroke()
    y += 12

    // 校验摘要
    ctx.textAlign = 'left'
    ;(d.verifyRows || []).forEach(r => {
      if (r.isBot) return
      ctx.fillStyle = r.verified ? 'rgba(255,255,255,0.7)' : '#E74C3C'
      ctx.font = '13px sans-serif'
      ctx.fillText(`${r.nickname}（${r.openidSuffix}）`, 20, y + 14)
      ctx.fillStyle = 'rgba(255,255,255,0.4)'
      ctx.font = '11px sans-serif'
      const e = r.earnedInGame >= 0 ? `+${r.earnedInGame}` : String(r.earnedInGame)
      ctx.fillText(`${r.balanceBefore} → ${r.balanceAfter}  （${e}）`, 20, y + 30)
      if (!r.verified) {
        ctx.fillStyle = '#E74C3C'
        ctx.font = 'bold 11px sans-serif'
        ctx.textAlign = 'right'
        ctx.fillText('⚠ 校验异常', w - 20, y + 22)
        ctx.textAlign = 'left'
      }
      y += 44
    })

    // 分割线
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(w - 20, y); ctx.stroke()
    y += 12

    // 每把流水（最多显示到屏幕底部）
    ctx.fillStyle = 'rgba(255,255,255,0.3)'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('── 摇骰流水 ──', cx, y + 10)
    y += 24

    ;(d.events || []).forEach(ev => {
      if (y > h - 20) return
      if (ev.eventType === 'round_end') {
        ctx.fillStyle = 'rgba(212,172,13,0.3)'
        ctx.font = '11px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText(`── 第 ${ev.round} 轮结束 ──`, cx, y + 10)
        y += 22
        return
      }
      const timeStr = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''
      ctx.fillStyle = 'rgba(255,255,255,0.6)'
      ctx.font = '12px sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(`第${ev.round}轮  ${ev.playerNickname}（${ev.openidSuffix}）`, 20, y + 14)
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.font = '11px sans-serif'
      ctx.fillText(`${ev.resultCall || ev.resultLabel || '轮空'}  ${timeStr}`, 20, y + 28)
      if (ev.payout > 0) {
        ctx.fillStyle = '#2ECC71'
        ctx.font = 'bold 13px sans-serif'
        ctx.textAlign = 'right'
        ctx.fillText(`+${ev.payout}`, w - 20, y + 22)
      }
      y += 38
    })
  }

  // ── 好婆助手悬浮按钮（透明气泡风格）──────────────────────────
  _drawAssistantBtn() {
    const ctx = this.ui.ctx
    const w   = this.w
    const h   = this.h
    const sb  = this.safeBottom || 0
    const r   = 34
    const cx  = w - 20 - r
    const cy  = h - 210 - sb - r

    ctx.save()

    // 外层柔和光晕
    ctx.shadowColor = 'rgba(255, 255, 255, 0.25)'
    ctx.shadowBlur  = 18

    // 主体：极透明白色气泡
    const grad = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.25, r * 0.05, cx, cy, r)
    grad.addColorStop(0,   'rgba(255,255,255,0.22)')
    grad.addColorStop(0.6, 'rgba(255,255,255,0.10)')
    grad.addColorStop(1,   'rgba(255,255,255,0.04)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()

    // 高光：左上角月牙反光
    ctx.shadowBlur = 0
    const hlGrad = ctx.createRadialGradient(
      cx - r * 0.3, cy - r * 0.35, 0,
      cx - r * 0.15, cy - r * 0.2, r * 0.55
    )
    hlGrad.addColorStop(0,   'rgba(255,255,255,0.55)')
    hlGrad.addColorStop(0.5, 'rgba(255,255,255,0.12)')
    hlGrad.addColorStop(1,   'rgba(255,255,255,0)')
    ctx.fillStyle = hlGrad
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()

    // 边框：细白半透明圆圈
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth   = 1.2
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()

    // 文字：AI好婆，撑满气球
    ctx.shadowBlur  = 0
    ctx.textAlign   = 'center'
    ctx.fillStyle   = 'rgba(255,255,255,0.92)'

    // 上行：AI — 小一点让好婆更突出
    ctx.font = 'bold 13px serif'
    ctx.fillText('AI', cx, cy - 7)

    // 下行：好婆 — 大字撑满
    ctx.font = 'bold 20px serif'
    ctx.fillText('好婆', cx, cy + 16)

    ctx.restore()
  }

  // ── 等待其他玩家 ─────────────────────────────────────────────
  _drawWaitingLabel() {
    const ctx = this.ui.ctx
    const name = this._currentPlayerName()
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.font = '15px sans-serif'
    ctx.fillText(`等待 ${name} 摇骰子...`, this.w / 2, this.h - 130 - (this.safeBottom || 0))
  }

  _drawStaticDice() {
    const positions = this._getDicePositions(this.diceValues.length)
    this.diceValues.forEach((v, i) => {
      const [x, y] = positions[i]
      this.ui.drawDie(x, y, 0, v, true, v)
    })
  }

  _getDicePositions(count) {
    const cx = this.bowlCX, cy = this.bowlCY
    const spread = this.bowlRX * 0.52
    const positions = []
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2
      const r = count <= 3 ? spread * 0.5 : spread * (0.3 + (i % 2) * 0.42)
      positions.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r * 0.55])
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

  // ── Touch ────────────────────────────────────────────────────
  onTouchStart(touch) { this._onTouch(touch) }
  onTouchEnd()        { this.rollPressed = false }
  onHide()            { this._wasHidden = true }
  onShow() {
    if (this._wasHidden && this.state !== STATE.SETUP && this.state !== STATE.LOBBY) {
      this._wasHidden = false
      wx.showModal({
        title: '继续？', content: '要继续当前局还是退出？',
        confirmText: '继续', cancelText: '退出',
        success: (res) => { if (!res.confirm) wx.navigateBack() }
      })
    } else {
      this._wasHidden = false
    }
  }

  _onTouch(touch) {
    const tx = touch.clientX, ty = touch.clientY

    if (this.adminPanel.onTouch(tx, ty)) return

    // 好婆助手按钮点击检测
    {
      const w  = this.w
      const h  = this.h
      const sb = this.safeBottom || 0
      const r  = 28
      const cx = w - 20 - r
      const cy = h - 200 - sb - r
      const dx = tx - cx, dy = ty - cy
      if (Math.sqrt(dx*dx + dy*dy) < r + 8) {
        wx.navigateTo({ url: '/pages/assistant/index' })
        return
      }
    }

    // ── 历史记录页触摸 ────────────────────────────────────────
    if (this.state === STATE.MY_GAMES) {
      this._handleMyGamesTouch(tx, ty)
      return
    }
    if (this.state === STATE.HOST_GAMES) {
      this._handleHostGamesTouch(tx, ty)
      return
    }
    if (this.state === STATE.HOST_DETAIL) {
      this._handleHostDetailTouch(tx, ty)
      return
    }

    if (this.state === STATE.SETUP) {
      // 欢迎卡点击关闭
      if (this._showWelcome) { this._showWelcome = false; return }
      if (ty < this.safeTop + 70) { this._onTitleTap(); return }
      this._handleSetupTouch(tx, ty)
      return
    }

    if (this.state === STATE.LOBBY) {
      this._handleLobbyTouch(tx, ty)
      return
    }

    if (this.state === STATE.WINNER) {
      // 局后账单交互
      if (this._showSettleCard) {
        this._handleSettleCardTouch(tx, ty)
        return
      }
      this._restartGame()
      return
    }

    if (!this.isOnline && this.state !== STATE.SETUP) {
      if (this.ui.hitTestExitButton(tx, ty)) {
        wx.showModal({
          title: '退出', content: '确定退出当前局？',
          confirmText: '退出', cancelText: '继续', confirmColor: '#C0392B',
          success: (res) => { if (res.confirm) this._restartGame() }
        })
        return
      }
    }

    if (this.isOnline && this._isHost && this.state !== STATE.SETUP && this.state !== STATE.LOBBY) {
      const bw = 60, bh = 26, bx = 12, by = this.safeTop + 8
      if (tx >= bx && tx <= bx + bw && ty >= by && ty <= by + bh) {
        this._confirmAbortGame(); return
      }
    }

    if (ty < this.safeTop + 50 && tx < this.w - 28) { this._onTitleTap(); return }

    if (this.state === STATE.IDLE && this.ui.hitTestRollButton(tx, ty)) {
      if (this.isOnline && !this._isMyTurn()) return
      this.rollPressed = true
      this._startRoll()
    }
    const canClickNext = !this.isOnline || this._isMyTurn()
    if (this.state === STATE.RESULT     && canClickNext && this.ui.hitTestNextButton(tx, ty)) this._nextTurn()
    if (this.state === STATE.NEXT_ROUND && canClickNext && this.ui.hitTestNextButton(tx, ty)) this._startNextRound()

    // 局后账单在 RESULT/NEXT_ROUND 也可能显示
    if (this._showSettleCard) {
      this._handleSettleCardTouch(tx, ty)
    }
  }

  // ── 局后账单触摸 ─────────────────────────────────────────────
  _handleSettleCardTouch(tx, ty) {
    const w = this.w, h = this.h
    const cardH = Math.min(480, h - 100)
    const cardY = (h - cardH) / 2

    // 关闭叉
    if (tx > w - 50 && ty < cardY + 40) {
      this._showSettleCard = false; return
    }
    // 手气记录按钮
    const btnY = cardY + cardH - 96
    const halfBtnW = (w - 80) / 2
    if (ty >= btnY && ty <= btnY + 40) {
      if (tx >= 32 && tx <= 32 + halfBtnW) {
        this._openMyGames('settle'); return
      }
      if (tx >= 32 + halfBtnW + 16 && tx <= w - 32) {
        this._showSettleCard = false
        this._restartGame()
        return
      }
    }
  }

  // ── 手气记录页触摸 ───────────────────────────────────────────
  _handleMyGamesTouch(tx, ty) {
    const st = this.safeTop
    if (tx < 80 && ty >= st + 10 && ty <= st + 40) {
      // 返回
      if (this._myGamesFrom === 'settle') {
        this._showSettleCard = false
        this.state = STATE.LOBBY
      } else {
        this.state = STATE.LOBBY
      }
    }
  }

  // ── 房主对局列表触摸 ─────────────────────────────────────────
  _handleHostGamesTouch(tx, ty) {
    const st = this.safeTop
    if (tx < 80 && ty >= st + 10 && ty <= st + 40) {
      this.state = STATE.LOBBY; return
    }
    // 点击某一行进入明细
    const startY = st + 56
    const idx = Math.floor((ty - startY) / 68)
    if (idx >= 0 && idx < this._hostGamesList.length) {
      this._openHostDetail(this._hostGamesList[idx].roomId)
    }
  }

  // ── 房主明细页触摸 ───────────────────────────────────────────
  _handleHostDetailTouch(tx, ty) {
    const st = this.safeTop
    if (tx < 80 && ty >= st + 10 && ty <= st + 40) {
      this.state = STATE.HOST_GAMES
    }
  }

  // ── 打开手气记录 ─────────────────────────────────────────────
  async _openMyGames(from = 'lobby') {
    this._myGamesFrom  = from
    this._myGamesLoading = true
    this.state = STATE.MY_GAMES
    try {
      const res = await this.network.getMyGames()
      if (res && res.success) this._myGamesList = res.list || []
    } catch (e) {
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
    this._myGamesLoading = false
  }

  // ── 打开房主对局列表 ─────────────────────────────────────────
  async _openHostGames() {
    this._hostGamesLoading = true
    this.state = STATE.HOST_GAMES
    try {
      const res = await this.network.getHostGames()
      if (res && res.success) this._hostGamesList = res.list || []
    } catch (e) {
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
    this._hostGamesLoading = false
  }

  // ── 打开房主明细 ─────────────────────────────────────────────
  async _openHostDetail(roomId) {
    this._hostDetailLoading = true
    this._hostDetailData    = null
    this.state = STATE.HOST_DETAIL
    try {
      const res = await this.network.getGameDetail(roomId)
      if (res && res.success) this._hostDetailData = res.detail
    } catch (e) {
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
    this._hostDetailLoading = false
  }

  // ── 标题5次点击进管理员 ──────────────────────────────────────
  _onTitleTap() {
    this._titleTapCount++
    clearTimeout(this._titleTapTimer)
    this._titleTapTimer = setTimeout(() => { this._titleTapCount = 0 }, 2000)
    const remain = 5 - this._titleTapCount
    if (remain > 0 && remain <= 3) {
      wx.showToast({ title: `再点 ${remain} 次`, icon: 'none', duration: 600 })
    }
    if (this._titleTapCount >= 5) {
      this._titleTapCount = 0
      this._promptAdminPassword()
    }
  }

  _promptAdminPassword() {
    this._adminInputValue = ''
    wx.showModal({
      title: '管理员验证', content: '请输入管理密码后点击确认',
      showCancel: true, confirmText: '确认',
      success: (r) => {
        if (!r.confirm) return
        wx.showKeyboard({ defaultValue: '', maxLength: 32, multiple: false, confirmHold: false, confirmType: 'done' })
        const onInput   = (res) => { this._adminInputValue = res.value }
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

  // ── Setup 触摸 ───────────────────────────────────────────────
  _handleSetupTouch(tx, ty) {
    const w  = this.w, ui = this.ui, st = this.safeTop, h = this.h

    if (tx >= 40 && tx <= w - 40 && ty >= st + 112 && ty <= st + 156) {
      wx.showActionSheet({
        itemList: ['16点', '32点', '50点', '100点', '自定义'],
        success: res => {
          const stakes = [16, 32, 50, 100]
          if (res.tapIndex < 4) {
            this.setupStake = stakes[res.tapIndex]
          } else {
            wx.showModal({
              title: '自定义底池', editable: true, placeholderText: '输入数额',
              success: r => { if (r.confirm && r.content) { const v = parseInt(r.content); if (v > 0) this.setupStake = v } }
            })
          }
        }
      })
    }

    const bw = (w - 88) / 2
    if (ty >= st + 184 && ty <= st + 224) {
      if (tx >= 40 && tx <= 40 + bw)            this.setupMode = 'classic'
      if (tx >= 40 + bw + 8 && tx <= w - 40)    this.setupMode = 'battle'
    }

    let handled = false
    for (let i = 0; i < this.setupPlayers.length; i++) {
      const name = this.setupPlayers[i]
      const by   = st + 254 + i * 52
      if (this.setupPlayers.length > 2) {
        const dx = tx - (w - 56), dy = ty - (by + 20)
        if (Math.sqrt(dx * dx + dy * dy) < 16) { this.setupPlayers.splice(i, 1); handled = true; break }
      }
      if (tx >= 40 && tx <= w - 80 && ty >= by && ty <= by + 40) {
        wx.showModal({
          title: `玩家 ${i + 1} 名字`, editable: true, placeholderText: `玩家${i + 1}`, content: name,
          success: r => { if (r.confirm && r.content.trim()) this.setupPlayers[i] = r.content.trim() }
        })
        handled = true; break
      }
    }

    const addY = st + 254 + this.setupPlayers.length * 52
    if (!handled && this.setupPlayers.length < 10 && tx >= 40 && tx <= w - 40 && ty >= addY && ty <= addY + 40) {
      this.setupPlayers.push(`玩家${this.setupPlayers.length + 1}`)
    }

    const btnY = h - 148 - (this.safeBottom || 0)
    if (ty >= btnY && ty <= btnY + 52)           { this.isOnline = false; this._startGame() }
    if (ty >= btnY + 64 && ty <= btnY + 112)     { this._enterLobby() }
    if (ty >= btnY + 124 && ty <= btnY + 160)    { this._showFollowModal() }
  }

  // ── 关注作者弹窗 ─────────────────────────────────────────────
  _showFollowModal() {
    wx.showModal({
      title: '关注作者 🎲',
      content: '关注公众号「CROSS-RANGE」\n后台留言「hopucallyouplay」\n有惊喜等你！',
      confirmText: '这就关注',
      cancelText: '下次一定',
      success: (res) => {
        if (res.confirm) {
          wx.openOfficialAccountProfile({
            username: 'gh_96b560453c3b',
            success: () => {},
            fail: () => {
              // 不同主体时兜底：复制暗号
              wx.setClipboardData({
                data: 'hopucallyouplay',
                success: () => wx.showToast({
                  title: '搜索「CROSS-RANGE」并留言暗号',
                  icon: 'none',
                  duration: 3000
                })
              })
            }
          })
        }
      }
    })
  }

  // ── 进入联机大厅 ─────────────────────────────────────────────
  async _enterLobby() {
    this.isOnline      = true
    this.state         = STATE.LOBBY
    this._lobbyLoading = false
    this._lobbyError   = ''
    this._lobbyView    = 'main'
    this._isHost       = false
    this.activityCode  = ''
    this._waitingPlayers = []
    // 进大厅时清掉上一局的结算卡片，避免新局开始时误弹
    this._showSettleCard      = false
    this._settleData          = null
    this._pendingServerResult = null

    try {
      const result = await this.network.login(
        this.collectNickname,
        () => { this._lobbyLoading = true }
      )
      this._lobbyLoading = false

      // ── 改动：保存余额，判断是否新玩家 ──────────────────────
      if (result) {
        this._myBalance   = result.balance || 0
        this._isNewPlayer = !!result.isNew
      }
    } catch (e) {
      this._lobbyLoading = false
      this._lobbyError   = e.message || '登录失败，请检查网络'
    }
  }

  // ── 大厅触摸 ─────────────────────────────────────────────────
  _handleLobbyTouch(tx, ty) {
    const st = this.safeTop, sb = this.safeBottom || 0
    const w  = this.w, h = this.h, cx = w / 2

    // 返回
    if (tx < 80 && ty >= st + 10 && ty <= st + 40) {
      if (this._lobbyView === 'waiting') {
        this.network.leaveRoom().catch(() => {})
        this._lobbyView = 'main'
        this._isHost    = false
        this._waitingPlayers = []
        this.activityCode = ''
      } else {
        this.state    = STATE.SETUP
        this.isOnline = false
      }
      return
    }

    // 等待室
    if (this._lobbyView === 'waiting') {
      const cardY  = st + 110
      const shareY = cardY + 124
      if (ty >= shareY && ty <= shareY + 50) {
        wx.setClipboardData({ data: this.activityCode, success: () => wx.showToast({ title: '房间号已复制', icon: 'success' }) })
        wx.showShareMenu({ withShareTicket: false, menus: ['shareAppMessage'] })
        return
      }
      if (this._isHost) {
        const botY   = h - 136 - sb
        const startY = h - 72  - sb
        if (ty >= botY   && ty <= botY + 48)  { this._addBot(); return }
        if (ty >= startY && ty <= startY + 52) { this._hostStartGame(); return }
      }
      return
    }

    // 主视图
    // 修改昵称
    if (this.network.nickname && ty >= st + 76 && ty <= st + 100 && tx >= cx + 30 && tx <= cx + 82) {
      this._changeNickname(); return
    }

    let y = st + 128
    if (this._lobbyError) y += 36

    // 创建房间
    if (ty >= y && ty <= y + 60) { this._promptStakeAndCreate(); return }
    y += 80

    // 加入房间
    if (ty >= y && ty <= y + 60) {
      wx.showModal({
        title: '输入房间号', editable: true, placeholderText: '5位数字，如 36721',
        success: (res) => { if (res.confirm && res.content.trim()) this._joinOnlineRoom(res.content.trim()) }
      })
      return
    }
    y += 80

    // ── 改动：手气记录 / 我的房间 两个按钮 ──────────────────────
    const halfBtnW = (w - 96) / 2
    if (ty >= y && ty <= y + 48) {
      if (tx >= 40 && tx <= 40 + halfBtnW) {
        this._openMyGames('lobby'); return
      }
      const btnR = 40 + halfBtnW + 16
      if (tx >= btnR && tx <= btnR + halfBtnW) {
        this._openHostGames(); return
      }
    }
  }

  // ── 房主确认终止游戏 ─────────────────────────────────────────
  _confirmAbortGame() {
    wx.showModal({
      title: '终止游戏', content: '底池将平分退还给所有玩家，确认终止？',
      confirmText: '确认终止', confirmColor: '#C0392B', cancelText: '继续游戏',
      success: async (res) => {
        if (!res.confirm) return
        try {
          const result = await this.network.abortGame()
          if (!result || !result.success) {
            wx.showToast({ title: result?.error || '操作失败', icon: 'none' })
          }
        } catch (e) {
          wx.showToast({ title: '网络错误', icon: 'none' })
        }
      }
    })
  }

  _changeNickname() {
    if (typeof this.collectNickname === 'function') {
      try { wx.removeStorageSync('userProfile') } catch (e) {}
      this.collectNickname().then((result) => {
        if (result.nickname) {
          this.network.nickname  = result.nickname
          this.network.avatarUrl = result.avatarUrl || this.network.avatarUrl
          wx.cloud.callFunction({
            name: 'playerManager',
            data: { action: 'login', nickname: result.nickname, avatarUrl: result.avatarUrl || '' }
          }).catch(() => {})
        }
      })
    }
  }

  async _addBot() {
    const existing = (this._waitingPlayers || []).filter(p => p.isBot)
    if (existing.length >= 3) { wx.showToast({ title: '最多添加3个机器人', icon: 'none' }); return }
    try {
      const res = await this.network.addBot()
      if (!res || !res.success) wx.showToast({ title: res?.error || '添加失败', icon: 'none' })
    } catch (e) { wx.showToast({ title: '网络错误', icon: 'none' }) }
  }

  async _hostStartGame() {
    try {
      const res = await this.network.startGame()
      if (res && res.success) this._startOnlineGame(res.roomData)
      else wx.showToast({ title: res?.error || '开始失败', icon: 'none' })
    } catch (e) { wx.showToast({ title: '网络错误', icon: 'none' }) }
  }

  _promptStakeAndCreate() {
    const defaultStake = this.setupStake || 32
    wx.showModal({
      title: '设置底池', content: `每人底池默认 ${defaultStake} 点，首次联机赠送 100 点。`,
      confirmText: '去设置', cancelText: '用默认',
      success: (res) => {
        if (!res.confirm) { this._createOnlineRoom(); return }
        wx.showModal({
          title: '输入底池金额', editable: true, placeholderText: String(defaultStake),
          success: (r) => {
            if (!r.confirm) return
            const raw = parseInt((r.content || '').trim())
            if (isNaN(raw) || raw <= 0) { wx.showToast({ title: '请输入正整数', icon: 'none' }); return }
            this.setupStake = raw
            this._createOnlineRoom()
          }
        })
      }
    })
  }

  async _createOnlineRoom() {
    this._lobbyLoading = true
    this._lobbyError   = ''
    try {
      const res = await this.network.createRoom({ stake: this.setupStake || 32, maxPlayers: 6 })
      if (res.success) {
        this.activityCode = res.roomCode || res.activityCode
        this._isHost      = true
        this._bindRoomCallbacks()
        this._lobbyView   = 'waiting'
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
    this._lobbyError   = ''
    try {
      const res = await this.network.joinRoom(code)
      if (res.success) {
        const rd = res.roomData
        if (rd && rd.phase === 'playing') {
          this._lobbyError = '游戏已开始，无法加入'
          this.network.leaveRoom().catch(() => {})
        } else {
          this.activityCode = res.roomCode || code
          this._isHost      = (rd && rd.hostOpenid === this.network.openid)
          this._bindRoomCallbacks()
          this._lobbyView   = 'waiting'
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

  _bindRoomCallbacks() {
    this.network.onRoomUpdate = (roomData) => this._onRoomUpdate(roomData)
    this.network.onError      = (msg) => wx.showToast({ title: msg, icon: 'none' })
  }

  _onRoomUpdate(roomData) {
    this.roomData = roomData
    this.round    = roomData.round || this.round
    // pool 只在非动画阶段立即更新
    // settled / round_end 阶段 pool 缓存到 _pendingServerResult，等动画结束后一起显示
    // ROLLING 状态时也不更新，防止 waiting 推送提前刷新显示
    if (roomData.phase !== 'settled' && roomData.phase !== 'rolling' &&
        roomData.phase !== 'round_end' && this.state !== STATE.ROLLING) {
      this.pool = roomData.pool !== undefined ? roomData.pool : this.pool
    }

    if (this.isOnline && roomData && roomData.hostOpenid && this.network && this.network.openid) {
      this._isHost = roomData.hostOpenid === this.network.openid
    }

    if (this._lobbyView === 'waiting' && roomData.players) {
      this._waitingPlayers = roomData.players.map(p => ({
        openid: p.openid, nickname: p.nickname, avatarUrl: p.avatarUrl || '', isBot: !!p.isBot
      }))
    }

    if (roomData.phase === 'playing' && this.state === STATE.LOBBY && !this._isHost) {
      this._startOnlineGame(roomData); return
    }

    // players 在 settled / round_end / 动画播放期间不立即更新，等动画结束后一起显示
    if (roomData.phase !== 'settled' && roomData.phase !== 'round_end' && this.state !== STATE.ROLLING) {
      this.players       = (roomData.players || []).map(p => ({ ...p, name: p.nickname, chips: p.chips, balance: p.balance ?? null, active: p.active }))
      this.currentPlayer = roomData.currentPlayerIndex
    }

    if (roomData.phase === 'waiting' && this.state !== STATE.SETUP && this.state !== STATE.LOBBY && this.state !== STATE.WINNER) {
      this.lastResult       = null
      this.lastPayout       = 0
      this.rollPressed      = false
      this.physics          = null
      this.state            = STATE.IDLE
      this._pendingServerResult = null  // 清除上一把缓存
      this._waitingRoundEnd = false     // 防止残留标记误触发下一轮的结算弹窗
    }

    if (Array.isArray(roomData.diceValues) && roomData.diceValues.length) {
      const key = `${roomData.phase || ''}|${roomData.diceValues.join(',')}`
      if (key !== this._lastServerDiceKey) {
        this._lastServerDiceKey = key
        this.diceValues = roomData.diceValues
        // rolling推送只在非自己发起、且机器人动画未在播时才触发远端动画
        // _pendingServerRoll=true 说明是自己摇骰，本地已有物理动画不能被覆盖
        // _botAnimating=true 说明 host 已在 _triggerBotRoll 里启动了动画，防止重复
        if (roomData.phase === 'rolling' && !this._pendingServerRoll && !this._botAnimating) {
          this._playRemoteDice(roomData.diceValues)
        }
      }
    }

    // Bug修复2：机器人触发加 !this._botAnimating 防止重复触发
    const botPhase = roomData.phase === 'waiting'
    if (this._isHost && botPhase && !this._botAnimating && roomData.players) {
      const cur = roomData.players[roomData.currentPlayerIndex]
      if (cur && cur.isBot) {
        clearTimeout(this._botTimer)
        this._botTimer = setTimeout(() => this._triggerBotRoll(), 1200)
      }
    }

    // Fix：settled 推送来时先把云端结果缓存起来，不立即切 RESULT
    // 等本地物理动画自然播完（_update 里检测），再用云端值替换骰子点数展示结果
    // 这样动画时长完全由本地物理引擎决定，和单机版体验一致
    if (roomData.lastResult && roomData.phase === 'settled') {
      clearTimeout(this._serverRollTimeout)
      this._pendingServerRoll = false
      if (!this._botAnimating) {
        // 如果 rolling 推送被合并跳过、动画从未启动，补起动画
        if (this.state !== STATE.ROLLING && roomData.diceValues && roomData.diceValues.length) {
          this._playRemoteDice(roomData.diceValues)
        }
        // 缓存云端结算结果（含更新后的 pool），等动画结束后一起显示
        this._pendingServerResult = {
          result:     roomData.lastResult,
          payout:     roomData.lastPayout || 0,
          diceValues: roomData.diceValues || [],
          pool:       roomData.pool !== undefined ? roomData.pool : this.pool,
          players:    roomData.players || null,
          isRoundEnd: false,
        }
      }
    }

    if (roomData.phase === 'round_end') {
      clearTimeout(this._serverRollTimeout)
      this._pendingServerRoll = false
      // 注意：不加 _botAnimating 限制——机器人动画播完后才消费 _pendingServerResult
      // 推送先到没关系，存好等动画结束时弹
      if (this._pendingServerResult) {
        // 已有缓存，直接打标记（机器人或普通玩家动画还在播）
        this._pendingServerResult.isRoundEnd = true
        this._pendingServerResult.roundEndData = roomData
      } else if (this._waitingRoundEnd || this.state === STATE.RESULT) {
        // 动画已播完（_waitingRoundEnd），或结果页已展示（STATE.RESULT）
        // round_end 推送后到 → 直接弹结算弹窗，无需再等动画
        this._waitingRoundEnd = false
        this._applyRoundEndState(roomData)
        this._showRoundEndResult(roomData)
      } else if (this.state === STATE.ROLLING) {
        // 动画在播但推送比 _triggerBotRoll.then 先到，建缓存等动画结束
        this._pendingServerResult = {
          result:       roomData.lastResult,
          payout:       roomData.lastPayout || 0,
          diceValues:   roomData.diceValues || [],
          pool:         roomData.pool !== undefined ? roomData.pool : this.pool,
          players:      roomData.players || null,
          isRoundEnd:   true,
          roundEndData: roomData,
        }
      } else {
        // rolling推送被合并跳过、动画从未启动 → 立即补起动画，再建缓存等它结束
        if (roomData.diceValues && roomData.diceValues.length) {
          this._playRemoteDice(roomData.diceValues)
        }
        this._pendingServerResult = {
          result:       roomData.lastResult,
          payout:       roomData.lastPayout || 0,
          diceValues:   roomData.diceValues || [],
          pool:         roomData.pool !== undefined ? roomData.pool : this.pool,
          players:      roomData.players || null,
          isRoundEnd:   true,
          roundEndData: roomData,
        }
      }
      return
    }

    if (roomData.phase === 'aborted') {
      this._showAbortResult(roomData); return
    }

    if (roomData.status === 'finished') {
      // ── 改动：游戏结束时构建账单数据 ─────────────────────────
      this._buildAndShowSettleCard(roomData)
      this.state = STATE.WINNER
    }

    if (this.isOnline && roomData.phase === 'waiting' && this.state === STATE.IDLE && this._isMyTurn()) {
      this._startAutoRollTimer()
    }
  }

  // ── 新增：构建局后账单 ───────────────────────────────────────
  async _buildAndShowSettleCard(roomData) {
    try {
      // 从云端拉自己这局的摘要（含赛前余额）
      const res = await this.network.getMyGameSummary(
        this.network.currentRoomId || this.activityCode
      )
      if (res && res.success && res.summary) {
        const s = res.summary
        this._settleData = {
          balanceBefore: s.myBalance.before,
          balanceAfter:  s.myBalance.after,
          players: [
            // 自己排第一
            { nickname: this.network.nickname, balanceBefore: s.myBalance.before, balanceAfter: s.myBalance.after },
            // 其他玩家
            ...(s.otherPlayers || []).map(p => ({ nickname: p.nickname, balanceAfter: p.balanceAfter })),
          ],
          events: s.events || [],
        }
        this._showSettleCard = true
        // 同步更新大厅余额显示
        if (s.myBalance.after !== null) this._myBalance = s.myBalance.after
      }
    } catch (e) {
      console.error('buildSettleCard', e)
    }
  }

  async _triggerBotRoll() {
    if (!this.roomData) return
    if (this._botAnimating) return
    const cur = this.roomData.players[this.roomData.currentPlayerIndex]
    if (!cur || !cur.isBot) return
    this._botAnimating = true
    try {
      const res = await wx.cloud.callFunction({
        name: 'roomManager',
        data: { action: 'botRoll', roomId: this.network.currentRoomId, botOpenid: cur.openid, hostOpenid: this.network.openid }
      })
      const result = res.result
      if (result && result.success && result.diceValues) {
        this.state   = STATE.ROLLING
        this.physics = new PhysicsWorld(this.bowlCX, this.bowlCY, this.bowlRX, this.bowlRY)
        this.physics.spawnAll(result.diceValues)
        // 把云端结果缓存起来，等物理动画自然播完后在 _update 里消费
        // 这样骰子最终停稳的点数 = 云端真实值，不会不一致
        const botRoundEnd = (result.newPool === 0 || result.pool === 0)
        // 竞态保护：round_end 的 watch 回调可能在 callFunction.then 之前就到了，
        // 此时 _pendingServerResult 里已经有 roundEndData，覆盖时必须保留
        const existingRoundEndData = this._pendingServerResult && this._pendingServerResult.roundEndData
        this._pendingServerResult = {
          result:       result.result,
          payout:       result.payout || 0,
          diceValues:   result.diceValues,
          pool:         result.newPool !== undefined ? result.newPool : (result.pool !== undefined ? result.pool : this.pool),
          players:      this.roomData ? this.roomData.players : null,
          isBot:        !botRoundEnd,
          isRoundEnd:   botRoundEnd,
          roundEndData: existingRoundEndData || null,  // 保留先到的 round_end 推送数据
        }
      } else {
        this._botAnimating = false
        setTimeout(() => this._triggerBotNext(), 800)
      }
    } catch (e) {
      console.error('botRoll fail', e)
      this._botAnimating = false
      setTimeout(() => this._triggerBotNext(), 2000)
    }
  }

  async _triggerBotNext() {
    try { await this.network.nextTurn() } catch (e) { console.error('botNext fail', e) }
  }

  _applyRoundEndState(roomData) {
    // 更新底池和玩家状态
    if (roomData.pool !== undefined) this.pool = roomData.pool
    if (roomData.players) {
      this.players = roomData.players.map(p => ({
        ...p, name: p.nickname, chips: p.chips, balance: p.balance ?? null, active: p.active
      }))
    }
    this.state = STATE.RESULT  // 保持 RESULT 状态，等弹窗
  }

    _showRoundEndResult(roomData) {
    const players  = (roomData.players || []).filter(p => p.active)
    const round    = roomData.round || 1
    const mode     = roomData.mode || 'classic'
    const roundEndByPlayer = (roomData.players || []).find(p => p.openid === roomData.roundEndBy)
    const roundEndByName   = roundEndByPlayer ? roundEndByPlayer.nickname : '收尾玩家'
    const roundEndIsBot    = roundEndByPlayer && roundEndByPlayer.isBot
    // 收尾玩家本人，或收尾玩家是机器人时由房主代理
    const isFinisher = roomData.roundEndBy === this.network.openid ||
                       (roundEndIsBot && this._isHost)

    // 构建战绩文本
    const lines = players.map(p => {
      const sign = p.chips > 0 ? '+' : ''
      return `${p.nickname}：${sign}${p.chips} 点`
    }).join('\n')

    const modeText = mode === 'classic' ? '经典版' : '对决版'
    const content  = '第 ' + round + ' 轮结束\n\n' + lines

    if (isFinisher) {
      // 收尾玩家（或机器人收尾时的房主）：有「开始新一轮」按钮
      wx.showModal({
        title: `🎲 ${modeText} · 第 ${round} 轮结束`,
        content,
        confirmText: '开始新一轮',
        cancelText: '终止游戏',
        success: async (res) => {
          if (res.confirm) {
            try {
              const r = await wx.cloud.callFunction({
                name: 'roomManager',
                data: { action: 'startNewRound', roomId: this.network.currentRoomId }
              })
              if (r.result && !r.result.success && r.result.terminated) {
                const names = (r.result.cannotPay || []).join('、')
                wx.showToast({
                  title: names ? `${names} 余额不足，房间终止` : '余额不足，房间终止',
                  icon: 'none', duration: 3000
                })
                // 让 status:finished 的 watch 触发结算流程，此处不手动 restartGame
              }
            } catch (e) {
              wx.showToast({ title: '操作失败，请重试', icon: 'none' })
            }
          } else {
            // 终止游戏
            try {
              await this.network.abortGame()
            } catch (e) {}
          }
        }
      })
    } else {
      // 非收尾玩家：只显示结果，等待
      wx.showModal({
        title: `🎲 第 ${round} 轮结束`,
        content: content + `\n\n等待 ${roundEndByName} 启动新一轮...`,
        showCancel: false,
        confirmText: '知道了',
      })
    }
  }

    _showAbortResult(roomData) {
    // ── 改动：终止时也构建账单，先拉摘要再弹窗 ──────────────
    this._buildAndShowSettleCard(roomData).catch(() => {})

    const share    = roomData.pool > 0
      ? Math.floor(roomData.pool / (roomData.players || []).filter(p => !p.isBot).length) : 0
    const myPlayer = (roomData.players || []).find(p => p.openid === this.network.openid)
    const myChips  = myPlayer ? myPlayer.chips : 0
    wx.showModal({
      title: '游戏已终止',
      content: `底池已平分退还。\n你本局最终余额：${myChips + share} 点`,
      showCancel: false, confirmText: '返回主页',
      success: () => {
        this.network.leaveRoom().catch(() => {})
        this.isOnline = false
        this.state    = STATE.SETUP
      }
    })
  }

  _playRemoteDice(values) {
    if (!Array.isArray(values) || values.length === 0) return
    this.state   = STATE.ROLLING
    this.physics = new PhysicsWorld(this.bowlCX, this.bowlCY, this.bowlRX, this.bowlRY)
    this.physics.spawnAll(values)
    // 对方摇骰时也播放音效
    try {
      if (!this._shakeAudio) {
        this._shakeAudio = wx.createInnerAudioContext()
        this._shakeAudio.src = 'audio/shake.m4a'
        this._shakeAudio.onError(e => console.log('shake音效错误:', e))
      }
      this._shakeAudio.stop()
      this._shakeAudio.play()
    } catch (e) {}
  }

  _startOnlineGame(roomData) {
    this.roomData      = roomData
    this.stake         = roomData.stake
    this.mode          = roomData.mode || 'classic'
    this.round         = roomData.round || 1
    this.pool          = roomData.pool  || 0
    this.players       = roomData.players.map(p => ({ ...p, name: p.nickname, active: p.active }))
    this.currentPlayer = roomData.currentPlayerIndex
    this.physics       = null
    this.diceValues    = [1, 2, 3, 4, 5, 6]
    this.lastResult    = null
    this.state         = STATE.IDLE
    this._startAutoRollTimer()
  }

  // ── 单机游戏启动 ─────────────────────────────────────────────
  _startGame() {
    const names = this.setupPlayers.filter(n => n.trim())
    if (names.length < 2) { wx.showToast({ title: '至少需要2位玩家', icon: 'none' }); return }

    this.stake  = this.setupStake
    this.mode   = this.setupMode

    // ── 改动：对决版 chips 初始值 = 带入金额 setupStake（不是0）
    // 经典版同样以 setupStake 作为初始余额，_collectPool 再扣底注
    this.players = names.map(name => ({
      name,
      chips:        this.setupStake,  // 带入游戏的余额
      initialChips: this.setupStake,  // 记录带入值，供对决版基数计算用
      active: true,
    }))
    this.currentPlayer = 0
    this.round         = 1
    this.pool          = 0
    this.lastResult    = null
    this.physics       = null
    this.diceValues    = [1, 2, 3, 4, 5, 6]

    this._collectPool()
    this.state = STATE.IDLE
    this._startAutoRollTimer()
  }

  _collectPool() {
    if (this.mode === 'battle') {
      const alive    = this.players.filter(p => p.active)
      // ── 改动：基数 = 当前存活玩家中余额最少者 ──────────────
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
    this.state      = STATE.ROLLING
    this.lastResult = null

    const values = Array.from({ length: 6 }, () => Math.floor(Math.random() * 6) + 1)
    this.physics = new PhysicsWorld(this.bowlCX, this.bowlCY, this.bowlRX, this.bowlRY)
    this.physics.spawnAll(values)

    if (this.isOnline) {
      this._pendingServerRoll = true
      clearTimeout(this._serverRollTimeout)
      this._serverRollTimeout = setTimeout(() => {
        if (this._pendingServerRoll && this.state === STATE.ROLLING) {
          this._pendingServerRoll = false
          this.physics = null
          this.state   = STATE.IDLE
          wx.showToast({ title: '联机结算超时，请重试', icon: 'none' })
          this._startAutoRollTimer()
        }
      }, 7000)
      this.network.rollDice([]).catch((e) => {
        console.error('rollDice err', e)
        clearTimeout(this._serverRollTimeout)
        this._pendingServerRoll = false
        this.physics = null
        this.state   = STATE.IDLE
        wx.showToast({ title: '摇骰失败，请重试', icon: 'none' })
        this._startAutoRollTimer()
      })
    }

    try {
      if (!this._shakeAudio) {
        this._shakeAudio = wx.createInnerAudioContext()
        this._shakeAudio.src = 'audio/shake.m4a'
        this._shakeAudio.onError(e => console.log('shake音效错误:', e))
      }
      this._shakeAudio.stop()
      this._shakeAudio.play()
    } catch (e) { console.log('音效失败:', e) }
  }

  _finishRoll() {
    const finalValues = this.physics.dice.map(d => d.value)
    this.diceValues   = finalValues
    const result      = evaluateDice(finalValues)
    this.lastResult   = result
    this._speak(result)

    if (result.type === 'none') {
      this.lastPayout = 0
      this.state      = STATE.RESULT
    } else {
      const payout    = result.amount === Infinity ? this.pool : Math.min(result.amount, this.pool)
      this.lastPayout = payout
      this.pool      -= payout
      if (this.pool < 0) this.pool = 0
      this.players[this.currentPlayer].chips += payout
      const emojis = result.amount === Infinity ? ['🎲', '💰', '🎰', '⭐', '🔥'] : ['🎲', '✨', '💛']
      this.ui.spawnParticles(this.bowlCX, this.bowlCY, emojis, result.amount === Infinity ? 20 : 10)
      this.state = STATE.RESULT
      if (this.pool === 0) { setTimeout(() => this._endRound(), 1200); return }
    }
  }

  // 喊法 → 本地预生成音频文件映射（audio/tts/*.m4a，Tingting zh_CN）
  _callAudioMap() {
    return {
      '六红，夯特！': 'audio/tts/liu_hong_hang_te.m4a',
      '五红！！！':   'audio/tts/wu_hong.m4a',
      '四红！！':     'audio/tts/si_hong.m4a',
      '红格二十四！': 'audio/tts/hong_ge_24.m4a',
      '格子十六！':   'audio/tts/ge_zi_16.m4a',
      '三红！':       'audio/tts/san_hong.m4a',
      '八洞！':       'audio/tts/ba_dong.m4a',
      '腻三靠！':     'audio/tts/ni_san_kao.m4a',
      '一两三！':     'audio/tts/yi_liang_san.m4a',
      '四五六！':     'audio/tts/si_wu_liu.m4a',
      '红三对！':     'audio/tts/hong_san_dui.m4a',
      '三对！':       'audio/tts/san_dui.m4a',
      '六十四！！！': 'audio/tts/liu_shi_si.m4a',
      '三十三！！':   'audio/tts/san_shi_san.m4a',
      '三十两！':     'audio/tts/san_shi_liang.m4a',
      '十九～':       'audio/tts/shi_jiu.m4a',
      '十七～':       'audio/tts/shi_qi.m4a',
      '十六～':       'audio/tts/shi_liu.m4a',
      '两红':         'audio/tts/liang_hong.m4a',
      '一红':         'audio/tts/yi_hong.m4a',
      '格2！！！':    'audio/tts/ge_2.m4a',
      '格3！！！':    'audio/tts/ge_3.m4a',
      '格5！！！':    'audio/tts/ge_5.m4a',
      '格6！！！':    'audio/tts/ge_6.m4a',
    }
  }


  _speak(result) {
    if (!result || result.type === 'none') return
    const text = result.call
    if (!text) return
    const src = this._callAudioMap()[text]
    if (!src) { console.warn('[speak] 未找到音频:', text); return }
    try {
      const audio = wx.createInnerAudioContext()
      audio.src = src
      audio.onError((err) => { console.error('[speak]', src, err); audio.destroy() })
      audio.onEnded(() => audio.destroy())
      audio.play()
    } catch (e) {
      console.error('[speak catch]', e)
    }
  }

  _nextTurn() {
    // 联机底池归零时禁止调用，防止覆盖 round_end phase
    if (this.isOnline && this.pool === 0) return
    if (this.isOnline) {
      this.state = STATE.WAITING
      this.network.nextTurn().then(res => {
        if (!res || !res.result) return
        const r = res.result

        // 经典版新一轮：显示补充/清退提示
        if (r.topupNotices && r.topupNotices.length > 0) {
          const kicked   = r.topupNotices.filter(n => n.kicked)
          const topupped = r.topupNotices.filter(n => !n.kicked)
          if (kicked.length > 0) {
            const kickedNames = kicked.map(n => n.nickname).join('、')
            wx.showToast({ title: `${kickedNames} 余额不足已清退`, icon: 'none', duration: 3000 })
          }
          if (topupped.length > 0) {
            const delay = kicked.length > 0 ? 3200 : 0
            setTimeout(() => {
              const msg = topupped.map(n => `${n.nickname}补${n.amount}点`).join('，')
              wx.showToast({ title: msg.length > 28 ? '新一轮已开始' : msg, icon: 'none', duration: 3000 })
            }, delay)
          }
        }

        // 对决版：有人淘汰，需要房主确认
        if (r.needConfirm && this._isHost) {
          const names = (r.eliminated || []).map(p => p.nickname).join('、')
          wx.showModal({
            title: '有玩家出局',
            content: `${names} 余额归零出局。
是否重开新局？`,
            confirmText: '重开',
            cancelText: '结束游戏',
            success: (modal) => {
              if (modal.confirm) {
                // 重开：让房主输入新底注
                wx.showModal({
                  title: '新局底注',
                  editable: true,
                  placeholderText: String(this.stake || 32),
                  success: (stakeModal) => {
                    const newStake = stakeModal.confirm && stakeModal.content
                      ? parseInt(stakeModal.content) || this.stake
                      : this.stake
                    wx.cloud.callFunction({
                      name: 'roomManager',
                      data: { action: 'confirmNewRound', roomId: this.network.currentRoomId, restart: true, newStake }
                    }).catch(e => console.error('confirmNewRound err', e))
                  }
                })
              } else {
                wx.cloud.callFunction({
                  name: 'roomManager',
                  data: { action: 'confirmNewRound', roomId: this.network.currentRoomId, restart: false }
                }).catch(e => console.error('confirmNewRound err', e))
              }
            }
          })
        }
      }).catch(e => console.error('nextTurn err', e))
      return
    }
    let next = (this.currentPlayer + 1) % this.players.length, tries = 0
    while (!this.players[next].active && tries < this.players.length) {
      next = (next + 1) % this.players.length; tries++
    }
    this.currentPlayer = next
    this.physics       = null
    this.state         = STATE.IDLE
    this._startAutoRollTimer()
  }

  _endRound() {
    if (this.mode === 'battle') {
      this.players.forEach(p => { if (p.active && p.chips <= 0) p.active = false })
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
      // ── 改动：找当前存活玩家中余额最小者，作为新一轮起点 ──
      // 不再用 this.stake 字段（stake 只是初始带入配置，不随轮次变化）
      alive.sort((a, b) => a.chips - b.chips)
      this.currentPlayer = this.players.indexOf(alive[0])
      // stake 字段更新为本轮实际基数，仅用于 UI 展示，不影响 _collectPool 逻辑
      this.stake = alive[0].chips
    } else {
      this.currentPlayer = 0
    }

    this._collectPool()
    this.physics    = null
    this.diceValues = [1, 2, 3, 4, 5, 6]
    this.state      = STATE.IDLE
    this._startAutoRollTimer()
  }

  _restartGame() {
    if (this.isOnline) this.network.leaveRoom().catch(() => {})
    this.isOnline         = false
    this.activityCode     = ''
    this.roomData         = null
    this.state            = STATE.SETUP
    this.players          = []
    this.pool             = 0
    this.physics          = null
    this._showSettleCard      = false
    this._settleData          = null
    this._pendingServerResult = null
  }

  // ── Auto Roll Timer ──────────────────────────────────────────
  _startAutoRollTimer() {
    // 联机版不自动摇，玩家自己决定什么时候摇
    if (this.isOnline) return
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
    if (this.autoRollTimer !== null) { clearInterval(this.autoRollTimer); this.autoRollTimer = null }
    this.autoRollRemaining = this.autoRollSeconds
  }

  // ── 联机工具 ─────────────────────────────────────────────────
  _isMyTurn() {
    if (!this.roomData) return true
    return this.network.isMyTurn(this.roomData)
  }

  _currentPlayerName() {
    const p = this.players[this.currentPlayer]
    return p ? (p.nickname || p.name || '玩家') : ''
  }

  _loadAvatar(player) {
    if (!this._avatarCache) this._avatarCache = {}
    const key = player.openid
    if (key in this._avatarCache) return
    if (!player.avatarUrl) { this._avatarCache[key] = null; return }
    this._avatarCache[key] = 'loading'

    const doLoad = (src) => {
      wx.getImageInfo({
        src,
        success: (info) => {
          const img = this.canvas.createImage()
          img.onload  = () => { this._avatarCache[key] = img }
          img.onerror = () => { this._avatarCache[key] = null }
          img.src = info.path
        },
        fail: () => { this._avatarCache[key] = null }
      })
    }

    // cloud:// 路径需要先转成 https 临时链接才能在 canvas 里使用
    if (player.avatarUrl.startsWith('cloud://')) {
      wx.cloud.getTempFileURL({
        fileList: [player.avatarUrl],
        success: (res) => {
          const item = res.fileList && res.fileList[0]
          if (item && item.tempFileURL) {
            doLoad(item.tempFileURL)
          } else {
            this._avatarCache[key] = null
          }
        },
        fail: () => { this._avatarCache[key] = null }
      })
    } else {
      doLoad(player.avatarUrl)
    }
  }

  _drawAvatar(ctx, key, url, x, y, r) {
    if (!this._avatarCache) this._avatarCache = {}
    const img = this._avatarCache[key]
    ctx.fillStyle = 'rgba(212,172,13,0.2)'
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
    if (img && img !== 'loading' && img !== null) {
      try {
        ctx.save()
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.clip()
        ctx.drawImage(img, x - r, y - r, r * 2, r * 2)
        ctx.restore()
      } catch (e) { this._avatarCache[key] = null }
    } else if (!img) {
      this._loadAvatar({ openid: key, avatarUrl: url })
    }
  }

  autoJoinRoom(roomCode) {
    this._enterLobby().then(() => { this._joinOnlineRoom(roomCode) })
  }
}

module.exports = Game