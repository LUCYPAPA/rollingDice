// js/UI.js - Canvas绘制（已修复高分屏模糊）

const DOT_POSITIONS = {
  1: [[0.5, 0.5]],
  2: [[0.25, 0.25], [0.75, 0.75]],
  3: [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]],
  4: [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]],
  5: [[0.25, 0.25], [0.75, 0.25], [0.5, 0.5], [0.25, 0.75], [0.75, 0.75]],
  6: [[0.25, 0.22], [0.75, 0.22], [0.25, 0.5], [0.75, 0.5], [0.25, 0.78], [0.75, 0.78]],
}

export class UI {
  constructor(canvas, logicW, logicH, safeTop) {
    this.canvas = canvas
    this.w = logicW || canvas.width
    this.h = logicH || canvas.height
    this.safeTop = safeTop || 60
    this.particles = []

    // ✅ 修复高分屏模糊：适配 devicePixelRatio（iPhone 15 Pro Max = 3×）
    // 微信小游戏环境用 wx.getSystemInfoSync().pixelRatio，H5 用 window.devicePixelRatio
    const dpr = (typeof wx !== 'undefined' && wx.getSystemInfoSync)
      ? wx.getSystemInfoSync().pixelRatio
      : (window.devicePixelRatio || 1)
    this.dpr = dpr

    // 将 canvas 的物理像素扩大到 dpr 倍
    canvas.width  = this.w * dpr
    canvas.height = this.h * dpr

    // CSS 尺寸保持逻辑尺寸（仅 H5 生效；微信小游戏通过 style.width 无效，可忽略）
    if (canvas.style) {
      canvas.style.width  = this.w + 'px'
      canvas.style.height = this.h + 'px'
    }

    this.ctx = canvas.getContext('2d')
    // 全局缩放，后续所有绘制坐标仍用逻辑像素，无需改其他代码
    this.ctx.scale(dpr, dpr)
  }

  clear() {
    const ctx = this.ctx
    ctx.fillStyle = '#1A0A06'
    ctx.fillRect(0, 0, this.w, this.h)

    const grad = ctx.createRadialGradient(this.w * 0.5, this.h * 0.3, 0, this.w * 0.5, this.h * 0.3, this.w * 0.8)
    grad.addColorStop(0, 'rgba(139,26,14,0.2)')
    grad.addColorStop(1, 'transparent')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, this.w, this.h)
  }

  drawHeader(title, subtitle) {
    const ctx = this.ctx
    const t = this.safeTop
    ctx.textAlign = 'center'
    ctx.fillStyle = '#D4AC0D'
    ctx.font = `bold 28px serif`
    ctx.fillText(title, this.w / 2, t + 22)
    ctx.fillStyle = 'rgba(212,172,13,0.5)'
    ctx.font = `14px sans-serif`
    ctx.fillText(subtitle, this.w / 2, t + 42)
  }

  drawPool(amount) {
    const ctx = this.ctx
    const x = this.w / 2
    const y = this.safeTop + 74

    ctx.fillStyle = 'rgba(192,57,43,0.12)'
    ctx.strokeStyle = 'rgba(192,57,43,0.25)'
    ctx.lineWidth = 1
    this._roundRect(x - 110, y - 26, 220, 52, 14)
    ctx.fill()
    ctx.stroke()

    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(255,255,255,0.3)'
    ctx.font = '11px sans-serif'
    ctx.fillText('底  池', x, y - 8)

    ctx.fillStyle = '#D4AC0D'
    ctx.font = 'bold 30px serif'
    ctx.fillText(amount === Infinity ? '???' : `${amount} 点`, x, y + 18)
  }

  drawBowl(cx, cy, rx, ry) {
    const ctx = this.ctx

    ctx.fillStyle = 'rgba(0,0,0,0.3)'
    ctx.beginPath()
    ctx.ellipse(cx + 6, cy + 8, rx, ry, 0, 0, Math.PI * 2)
    ctx.fill()

    const bowlGrad = ctx.createRadialGradient(cx - rx * 0.3, cy - ry * 0.3, 0, cx, cy, rx)
    bowlGrad.addColorStop(0, '#2A1208')
    bowlGrad.addColorStop(1, '#150804')
    ctx.fillStyle = bowlGrad
    ctx.beginPath()
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
    ctx.fill()

    ctx.strokeStyle = '#8B6914'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
    ctx.stroke()

    ctx.strokeStyle = 'rgba(212,172,13,0.35)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.ellipse(cx, cy, rx - 6, ry - 4, 0, 0, Math.PI * 2)
    ctx.stroke()
  }

  drawDie(x, y, angle, value, isSettled, displayValue) {
    const ctx = this.ctx
    const size = 44
    const shown = displayValue !== undefined ? displayValue : value
    const isFour = shown === 4
    const isOne = shown === 1
    const isRedDot = isFour || isOne

    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(angle)

    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    this._roundRect(-size / 2 + 3, -size / 2 + 5, size, size, 9)
    ctx.fill()

    if (isFour) {
      const grad = ctx.createLinearGradient(-size / 2, -size / 2, size / 2, size / 2)
      grad.addColorStop(0, '#FFE0E0')
      grad.addColorStop(1, '#FFBBBB')
      ctx.fillStyle = grad
    } else {
      const grad = ctx.createLinearGradient(-size / 2, -size / 2, size / 2, size / 2)
      grad.addColorStop(0, '#FFFBF0')
      grad.addColorStop(1, '#EAD9B0')
      ctx.fillStyle = grad
    }
    this._roundRect(-size / 2, -size / 2, size, size, 9)
    ctx.fill()

    if (isFour && isSettled) {
      ctx.strokeStyle = 'rgba(192,57,43,0.85)'
      ctx.lineWidth = 2.5
    } else {
      ctx.strokeStyle = 'rgba(180,150,80,0.4)'
      ctx.lineWidth = 1
    }
    this._roundRect(-size / 2, -size / 2, size, size, 9)
    ctx.stroke()

    const dots = DOT_POSITIONS[shown] || DOT_POSITIONS[1]
    const dotColor = isRedDot ? '#C0392B' : '#2C1810'
    const dotR = shown === 6 ? 4 : 4.8
    ctx.fillStyle = dotColor
    for (const [px, py] of dots) {
      ctx.beginPath()
      ctx.arc((px - 0.5) * (size - 14), (py - 0.5) * (size - 14), dotR, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.restore()
  }

  drawPlayers(players, currentIdx) {
    const ctx = this.ctx
    const count = players.length
    const cardW = Math.min(90, (this.w - 32) / count - 6)
    const cardH = 64
    const startX = (this.w - (cardW * count + (count - 1) * 6)) / 2
    const y = this.h - cardH - 16

    players.forEach((p, i) => {
      const x = startX + i * (cardW + 6)
      const isActive = i === currentIdx
      const isElim = !p.active

      ctx.globalAlpha = isElim ? 0.3 : 1

      ctx.fillStyle = isActive ? 'rgba(192,57,43,0.25)' : 'rgba(255,255,255,0.05)'
      ctx.strokeStyle = isActive ? '#C0392B' : 'rgba(255,255,255,0.1)'
      ctx.lineWidth = isActive ? 2 : 1
      this._roundRect(x, y, cardW, cardH, 10)
      ctx.fill()
      ctx.stroke()

      if (isActive) {
        ctx.fillStyle = '#C0392B'
        ctx.beginPath()
        ctx.arc(x + cardW - 8, y + 8, 4, 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.fillStyle = isActive ? '#FFFFFF' : 'rgba(255,255,255,0.7)'
      ctx.font = `bold ${cardW > 75 ? 13 : 11}px sans-serif`
      ctx.textAlign = 'center'
      const name = p.name.length > 4 ? p.name.slice(0, 4) : p.name
      ctx.fillText(name, x + cardW / 2, y + 22)

      ctx.fillStyle = '#D4AC0D'
      ctx.font = `bold 16px serif`
      ctx.fillText(`${p.chips}点`, x + cardW / 2, y + 44)

      ctx.globalAlpha = 1
    })
  }

  drawTurnLabel(name) {
    const ctx = this.ctx
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '13px sans-serif'
    ctx.fillText(`${name} 的回合`, this.w / 2, this.h - 170)
  }

  drawRollButton(pressed) {
    const ctx = this.ctx
    const bw = this.w - 64
    const bh = 52
    const bx = 32
    const by = this.h - 148
    const offset = pressed ? 3 : 0

    ctx.fillStyle = 'rgba(0,0,0,0.4)'
    this._roundRect(bx + 3, by + 6, bw, bh, 14)
    ctx.fill()

    const grad = ctx.createLinearGradient(bx, by + offset, bx, by + bh + offset)
    grad.addColorStop(0, pressed ? '#A93226' : '#C0392B')
    grad.addColorStop(1, pressed ? '#7B241C' : '#922B21')
    ctx.fillStyle = grad
    this._roundRect(bx, by + offset, bw, bh, 14)
    ctx.fill()

    ctx.fillStyle = '#FFFFFF'
    ctx.font = 'bold 20px serif'
    ctx.textAlign = 'center'
    ctx.fillText('摇 骰 子', this.w / 2, by + offset + 34)
  }

  drawExitButton() {
    const ctx = this.ctx
    const t = this.safeTop
    const x = this.w - 44
    const y = t + 10
    const r = 16
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.arc(x, y + r, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.font = '14px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('✕', x, y + r + 5)
  }

  hitTestExitButton(tx, ty) {
    const t = this.safeTop
    const x = this.w - 44
    const y = t + 26
    return Math.sqrt((tx - x) ** 2 + (ty - y) ** 2) < 24
  }

  drawResult(result, payout) {
    if (!result) return
    const ctx = this.ctx
    const cx = this.w / 2

    if (result.type === 'none') {
      ctx.fillStyle = 'rgba(255,255,255,0.25)'
      ctx.font = '16px serif'
      ctx.textAlign = 'center'
      ctx.fillText('💨  轮空', cx, this.h - 215)
    } else {
      ctx.fillStyle = 'rgba(212,172,13,0.6)'
      ctx.font = '13px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(`${result.emoji}  ${result.label}`, cx, this.h - 232)

      ctx.fillStyle = '#D4AC0D'
      ctx.font = 'bold 34px serif'
      ctx.fillText(result.call || '', cx, this.h - 198)

      ctx.fillStyle = 'rgba(255,255,255,0.5)'
      ctx.font = '18px serif'
      const payoutStr = payout === Infinity ? '全部' : `${payout} 点`
      ctx.fillText(payoutStr, cx, this.h - 170)
    }
  }

  drawNextButton(label) {
    const ctx = this.ctx
    const bw = 160
    const bh = 40
    const bx = (this.w - bw) / 2
    const by = this.h - 148

    ctx.fillStyle = 'rgba(212,172,13,0.15)'
    ctx.strokeStyle = 'rgba(212,172,13,0.4)'
    ctx.lineWidth = 1
    this._roundRect(bx, by, bw, bh, 10)
    ctx.fill()
    ctx.stroke()

    ctx.fillStyle = '#D4AC0D'
    ctx.font = '15px serif'
    ctx.textAlign = 'center'
    ctx.fillText(label || '下一位 →', this.w / 2, by + 26)
  }

  drawSetupScreen(players, stake, mode) {
    this.clear()
    const ctx = this.ctx
    ctx.textAlign = 'center'

    ctx.fillStyle = '#D4AC0D'
    ctx.font = 'bold 32px serif'
    ctx.fillText('阿嗲好婆叫侬白相', this.w / 2, 80)

    ctx.fillStyle = 'rgba(212,172,13,0.5)'
    ctx.font = '14px sans-serif'
    ctx.fillText('苏州祖传骰子游戏', this.w / 2, 108)
  }

  spawnParticles(x, y, emojis, count = 10) {
    for (let i = 0; i < count; i++) {
      this.particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 12,
        vy: -Math.random() * 14 - 4,
        emoji: emojis[Math.floor(Math.random() * emojis.length)],
        life: 1.0,
        decay: 0.02 + Math.random() * 0.02,
        size: 18 + Math.random() * 12,
      })
    }
  }

  updateParticles() {
    this.particles = this.particles.filter(p => p.life > 0)
    for (let p of this.particles) {
      p.x += p.vx
      p.y += p.vy
      p.vy += 0.4
      p.life -= p.decay
    }
  }

  drawParticles() {
    const ctx = this.ctx
    for (let p of this.particles) {
      ctx.globalAlpha = p.life
      ctx.font = `${p.size}px serif`
      ctx.textAlign = 'center'
      ctx.fillText(p.emoji, p.x, p.y)
    }
    ctx.globalAlpha = 1
  }

  drawWinner(name) {
    const ctx = this.ctx
    ctx.fillStyle = 'rgba(0,0,0,0.85)'
    ctx.fillRect(0, 0, this.w, this.h)

    ctx.textAlign = 'center'
    ctx.font = '72px serif'
    ctx.fillText('🏆', this.w / 2, this.h / 2 - 60)

    ctx.fillStyle = '#D4AC0D'
    ctx.font = 'bold 28px serif'
    ctx.fillText(`${name} 获胜！`, this.w / 2, this.h / 2 + 10)

    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.font = '16px sans-serif'
    ctx.fillText('点击重新开始', this.w / 2, this.h / 2 + 50)
  }

  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y)
    ctx.arcTo(x + w, y, x + w, y + r, r)
    ctx.lineTo(x + w, y + h - r)
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
    ctx.lineTo(x + r, y + h)
    ctx.arcTo(x, y + h, x, y + h - r, r)
    ctx.lineTo(x, y + r)
    ctx.arcTo(x, y, x + r, y, r)
    ctx.closePath()
  }

  hitTestRollButton(tx, ty) {
    const bw = this.w - 64
    const bh = 52
    const bx = 32
    const by = this.h - 148
    return tx >= bx && tx <= bx + bw && ty >= by && ty <= by + bh
  }

  hitTestNextButton(tx, ty) {
    const bw = 160
    const bh = 40
    const bx = (this.w - bw) / 2
    const by = this.h - 148
    return tx >= bx && tx <= bx + bw && ty >= by && ty <= by + bh
  }
}