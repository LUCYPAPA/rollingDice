// js/Game.js - 主游戏逻辑

import { UI } from './UI.js'
import { PhysicsWorld, PhysicsDie } from './Physics.js'
import { evaluateDice } from './Rules.js'

// ── 游戏状态 ──────────────────────────────────────
const STATE = {
  SETUP: 'setup',
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
    this.setupFocus = null // which input is focused

    this._bindEvents()
  }

  start() {
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

    // Auto roll countdown
    if (this.state === STATE.IDLE && this.autoRollTimer !== null) {
      // handled by setInterval
    }
  }

  _draw() {
    const ui = this.ui
    ui.clear()

    if (this.state === STATE.SETUP) {
      this._drawSetup()
      return
    }

    if (this.state === STATE.WINNER) {
      const winner = this.players.find(p => p.active)
      ui.drawWinner(winner ? winner.name : '大家')
      ui.drawParticles()
      return
    }

    // Header
    ui.drawHeader('阿嗲好婆叫侬白相', `第 ${this.round} 轮`)
    // Exit button top-right
    ui.drawExitButton()
    // Pool
    ui.drawPool(this.pool)
    // Bowl
    ui.drawBowl(this.bowlCX, this.bowlCY, this.bowlRX, this.bowlRY)

    // Dice
    if (this.physics) {
      for (const die of this.physics.dice) {
        ui.drawDie(die.x, die.y, die.angle, die.value, die.settled, die.displayValue)
      }
    } else {
      // Show static dice
      this._drawStaticDice()
    }

    // Result
    if (this.state === STATE.RESULT || this.state === STATE.NEXT_ROUND) {
      ui.drawResult(this.lastResult, this.lastPayout)
    }

    // Next / Next Round button
    if (this.state === STATE.RESULT) {
      ui.drawNextButton('下一位 →')
    } else if (this.state === STATE.NEXT_ROUND) {
      ui.drawNextButton('开始下一轮 🔄')
    }

    // Roll button (only in IDLE)
    if (this.state === STATE.IDLE) {
      const label = this.autoRollRemaining < 60
        ? `摇 骰 子  (${this.autoRollRemaining}s)`
        : '摇 骰 子'
      ui.drawRollButton(this.rollPressed, label)
      ui.drawTurnLabel(this.players[this.currentPlayer]?.name || '')
    }

    // Players bar
    ui.drawPlayers(this.players, this.currentPlayer)
    ui.drawParticles()
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
      // 奇偶交替半径 = 心型
      const r = count <= 3 ? spread * 0.5 : spread * (0.3 + (i % 2) * 0.42)
      positions.push([
        cx + Math.cos(angle) * r,
        cy + Math.sin(angle) * r * 0.55,
      ])
    }
    // 静态分离：防止心型骰子重叠
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

  // ── Setup Screen ──────────────────────────────
  _drawSetup() {
    const ctx = this.canvas.getContext('2d')
    const ui = this.ui
    const w = this.w
    const h = this.h

    ctx.textAlign = 'center'
    ctx.fillStyle = '#D4AC0D'
    ctx.font = 'bold 34px serif'
    ctx.fillText('阿嗲好婆叫侬白相', w / 2, this.safeTop + 36)
    ctx.fillStyle = 'rgba(212,172,13,0.5)'
    ctx.font = '13px sans-serif'
    ctx.fillText('苏州祖传骰子游戏', w / 2, this.safeTop + 62)

    // Divider
    ctx.strokeStyle = 'rgba(212,172,13,0.2)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(40, this.safeTop + 76)
    ctx.lineTo(w - 40, this.safeTop + 76)
    ctx.stroke()

    const st = this.safeTop  // safe area top shorthand

    // Stake label
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText('底池金额（每人）', 40, st + 104)

    // Stake box
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.strokeStyle = this.setupFocus === 'stake' ? '#D4AC0D' : 'rgba(255,255,255,0.15)'
    ctx.lineWidth = 1
    ui._roundRect(40, st + 112, w - 80, 44, 8)
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = '#FFFFFF'
    ctx.font = '18px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(`${this.setupStake} 点`, w / 2, st + 140)

    // Mode label
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText('游戏模式', 40, st + 176)

    // Mode buttons
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

    // Players label
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText('玩家（点击修改名字）', 40, st + 246)

    // Player slots
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
      // 删除按钮（玩家数>2时才显示）
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

    // Add player button
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

    // Start button
    const startY = h - 80
    const grad = ctx.createLinearGradient(40, startY, 40, startY + 56)
    grad.addColorStop(0, '#D4AC0D')
    grad.addColorStop(1, '#B7950B')
    ctx.fillStyle = grad
    ui._roundRect(40, startY, w - 80, 56, 14)
    ctx.fill()
    ctx.fillStyle = '#2C1810'
    ctx.font = 'bold 20px serif'
    ctx.textAlign = 'center'
    ctx.fillText('开 始 游 戏', w / 2, startY + 36)
  }

  // ── Events ─────────────────────────────────────
  _bindEvents() {
    wx.onTouchStart(e => this._onTouch(e.touches[0]))
    wx.onTouchEnd(e => {
      this.rollPressed = false
    })

    // 退出确认：用户按手机返回键或下滑关闭时弹窗
    wx.onHide(() => {
      // onHide 时游戏已在后台，下次 onShow 时提示是否继续
      this._wasHidden = true
    })
    wx.onShow(() => {
      if (this._wasHidden && this.state !== STATE.SETUP) {
        this._wasHidden = false
        wx.showModal({
          title: '继续游戏？',
          content: '要继续当前游戏还是退出？',
          confirmText: '继续',
          cancelText: '退出',
          success: (res) => {
            if (!res.confirm) {
              wx.exitMiniProgram()
            }
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

    if (this.state === STATE.SETUP) {
      this._handleSetupTouch(tx, ty)
      return
    }

    if (this.state === STATE.WINNER) {
      this._restartGame()
      return
    }

    // 退出按钮（游戏中右上角）
    if (this.state !== STATE.SETUP && this.ui.hitTestExitButton(tx, ty)) {
      wx.showModal({
        title: '退出游戏',
        content: '确定退出当前游戏？',
        confirmText: '退出',
        cancelText: '继续',
        confirmColor: '#C0392B',
        success: (res) => {
          if (res.confirm) wx.exitMiniProgram()
        }
      })
      return
    }

    if (this.state === STATE.IDLE) {
      if (this.ui.hitTestRollButton(tx, ty)) {
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

  _handleSetupTouch(tx, ty) {
    const w = this.w
    const ui = this.ui
    const st = this.safeTop

    // Stake area
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

    // Mode buttons
    const bw = (w - 88) / 2
    if (ty >= st + 184 && ty <= st + 224) {
      if (tx >= 40 && tx <= 40 + bw) this.setupMode = 'classic'
      if (tx >= 40 + bw + 8 && tx <= w - 40) this.setupMode = 'battle'
    }

    // Player slots
    let handled = false
    for (let i = 0; i < this.setupPlayers.length; i++) {
      const name = this.setupPlayers[i]
      const by = st + 254 + i * 52
      // 删除按钮
      if (this.setupPlayers.length > 2) {
        const dx = tx - (w - 56), dy = ty - (by + 20)
        if (Math.sqrt(dx * dx + dy * dy) < 16) {
          this.setupPlayers.splice(i, 1)
          handled = true
          break
        }
      }
      // 点名字区域 → 修改名字
      if (tx >= 40 && tx <= w - 80 && ty >= by && ty <= by + 40) {
        wx.showModal({
          title: `玩家 ${i + 1} 名字`,
          editable: true,
          placeholderText: `玩家${i + 1}`,
          content: name,
          success: r => {
            if (r.confirm && r.content.trim()) {
              this.setupPlayers[i] = r.content.trim()
            }
          }
        })
        handled = true
        break
      }
    }

    // Add player
    const addY = st + 254 + this.setupPlayers.length * 52
    if (!handled && this.setupPlayers.length < 10 && tx >= 40 && tx <= w - 40 && ty >= addY && ty <= addY + 40) {
      this.setupPlayers.push(`玩家${this.setupPlayers.length + 1}`)
    }

    // Start button
    if (ty >= this.h - 80 && ty <= this.h - 24) {
      this._startGame()
    }
  }

  // ── Game Flow ──────────────────────────────────
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

    // 开局在用户手势链路内启动TTS预加载
    this._preloadAllTTS()

    // Collect initial pool
    this._collectPool()
    this.state = STATE.IDLE
    this._startAutoRollTimer()
  }

  _collectPool() {
    if (this.mode === 'battle') {
      // 对决版：每人出最少那人的余额
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

    // 六颗骰子从碗中央同时落下，随机向四面散开
    const values = Array.from({ length: 6 }, () => Math.ceil(Math.random() * 6))
    this.physics = new PhysicsWorld(this.bowlCX, this.bowlCY, this.bowlRX, this.bowlRY)
    this.physics.spawnAll(values)

    // 播放摇骰子音效
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

    // 语音播报结果（上海话字，普通话腔）
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

  // ── TTS（微信小游戏不支持，预留录音接入口）────────
  _preloadAllTTS() {
    // wx.textToSpeech 仅限小程序，小游戏不可用
    // 如需语音，请将录音文件放入 audio/tts/ 目录
    // 文件名规则见 _speak()
  }

  _speak(result) {
    if (!result || result.type === 'none') return
    // 录音文件方案：audio/tts/三红.mp3 等
    // 文件存在时播放，不存在时静默跳过
    const text = result.call || result.label
    if (!text) return
    try {
      const filename = 'audio/tts/' + text.replace(/[！!～~]/g, '') + '.mp3'
      const audio = wx.createInnerAudioContext()
      audio.src = filename
      audio.onError(() => audio.destroy())  // 文件不存在静默跳过
      audio.onEnded(() => audio.destroy())
      audio.play()
    } catch(e) {}
  }

  _nextTurn() {
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
      // 对决版：本轮底注 = 余额最少的人 × 在场人数
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
    this.state = STATE.SETUP
    this.players = []
    this.pool = 0
    this.physics = null
  }

  // ── Auto Roll Timer ────────────────────────────
  _startAutoRollTimer() {
    this._clearAutoRollTimer()
    this.autoRollRemaining = this.autoRollSeconds
    this.autoRollTimer = setInterval(() => {
      this.autoRollRemaining--
      if (this.autoRollRemaining <= 0) {
        this._clearAutoRollTimer()
        if (this.state === STATE.IDLE) {
          this._startRoll()
        }
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
}