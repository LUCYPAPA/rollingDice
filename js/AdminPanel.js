// js/AdminPanel.js
// 隐藏管理员界面 — 全 Canvas 绘制，无 DOM
// 入口：连续点击标题区域5次

export class AdminPanel {
  constructor(ui, network) {
    this.ui = ui          // UI 实例（复用 Canvas）
    this.network = network
    this.visible = false
    this.authenticated = false
    this.tapCount = 0
    this.tapTimer = null

    // 界面状态
    this.view = 'search'     // 'search' | 'detail' | 'logs'
    this.searchQuery = ''
    this.searchResults = []
    this.selectedPlayer = null
    this.recentLogs = []
    this.statusMsg = ''
    this.scrollY = 0
  }

  // ── 标题区点击计数（外部在 touchstart 里调用）──
  onTitleTap() {
    this.tapCount++
    clearTimeout(this.tapTimer)
    this.tapTimer = setTimeout(() => { this.tapCount = 0 }, 1500)

    if (this.tapCount >= 5) {
      this.tapCount = 0
      this._promptPassword()
    }
  }

  // ── 密码验证入口（由 Game.js 调用，密码通过 wx.showKeyboard 获取后传入）──
  _promptPassword() {
    // 保留兼容性：Game.js 现在直接调 _verifyAndOpen，此方法备用
    this._verifyAndOpen('')
  }

  // ── 实际验证逻辑 ───────────────────────────────
  async _verifyAndOpen(password) {
    if (!password) {
      wx.showToast({ title: '密码不能为空', icon: 'none' })
      return
    }
    try {
      const r = await wx.cloud.callFunction({
        name: 'playerManager',
        data: { action: 'adminLogin', password }
      })
      if (r.result.success) {
        this.authenticated = true
        this.visible = true
        this.view = 'search'
        await this._loadRecentLogs()
        wx.showToast({ title: '已进入管理模式', icon: 'success' })
      } else {
        wx.showToast({ title: '密码错误', icon: 'error' })
      }
    } catch {
      wx.showToast({ title: '验证失败，检查网络', icon: 'none' })
    }
  }

  // ── 搜索玩家 ───────────────────────────────────
  async search(query) {
    this.searchQuery = query
    if (!query.trim()) {
      this.searchResults = []
      return
    }
    try {
      const r = await wx.cloud.callFunction({
        name: 'playerManager',
        data: { action: 'searchPlayers', query: query.trim() }
      })
      this.searchResults = r.result.players || []
      this.statusMsg = this.searchResults.length === 0 ? '未找到玩家' : ''
    } catch {
      this.statusMsg = '搜索失败'
    }
  }

  // ── 选中某玩家查看详情 ─────────────────────────
  selectPlayer(player) {
    this.selectedPlayer = { ...player }
    this.view = 'detail'
  }

  // ── 修改余额 ───────────────────────────────────
  async updateBalance(openid, delta, reason) {
    try {
      const r = await wx.cloud.callFunction({
        name: 'playerManager',
        data: {
          action: 'adminUpdateBalance',
          targetOpenid: openid,
          delta,      // 正数加，负数减
          reason,
          adminOpenid: this.network.openid,
        }
      })
      if (r.result.success) {
        this.selectedPlayer.balance = r.result.newBalance
        this.statusMsg = `余额已更新：${r.result.newBalance} 点`
        wx.showToast({ title: '更新成功', icon: 'success' })
      }
    } catch {
      this.statusMsg = '更新失败'
    }
  }

  // ── 弹出余额修改框 ─────────────────────────────
  promptBalanceChange() {
    wx.showModal({
      title: `修改「${this.selectedPlayer.nickname}」余额`,
      content: `当前：${this.selectedPlayer.balance} 点`,
      editable: true,
      placeholderText: '输入变动值，如 +100 或 -50',
      success: async (res) => {
        if (!res.confirm || !res.content) return
        const raw = res.content.trim()
        const delta = parseInt(raw.replace(/\s/g, ''), 10)
        if (isNaN(delta)) {
          wx.showToast({ title: '格式错误', icon: 'error' })
          return
        }
        await this._promptReason(this.selectedPlayer.openid, delta)
      }
    })
  }

  async _promptReason(openid, delta) {
    wx.showModal({
      title: '备注原因（可选）',
      editable: true,
      placeholderText: '如：补偿对局异常、年度奖励...',
      success: async (res) => {
        const reason = res.confirm ? (res.content || '管理员操作') : '管理员操作'
        await this.updateBalance(openid, delta, reason)
      }
    })
  }

  // ── 加载最近对局记录 ───────────────────────────
  async _loadRecentLogs() {
    try {
      const r = await wx.cloud.callFunction({
        name: 'playerManager',
        data: { action: 'getRecentLogs', limit: 20 }
      })
      this.recentLogs = r.result.logs || []
    } catch {
      this.recentLogs = []
    }
  }

  // ── 退出管理界面 ───────────────────────────────
  close() {
    this.visible = false
    this.authenticated = false
    this.selectedPlayer = null
    this.searchResults = []
  }

  // ─────────────────────────────────────────────
  // Canvas 绘制
  // ─────────────────────────────────────────────
  draw() {
    if (!this.visible) return
    const { ctx, w, h } = this.ui

    // 全屏遮罩
    ctx.fillStyle = 'rgba(10, 4, 2, 0.97)'
    ctx.fillRect(0, 0, w, h)

    // 顶部标题栏
    ctx.fillStyle = '#C0392B'
    ctx.fillRect(0, 0, w, 50)
    ctx.fillStyle = '#FFFFFF'
    ctx.font = 'bold 16px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('⚙ 管理员后台', w / 2, 32)

    // 关闭按钮
    ctx.fillStyle = 'rgba(255,255,255,0.15)'
    this.ui._roundRect(w - 44, 12, 28, 28, 6)
    ctx.fill()
    ctx.fillStyle = '#FFFFFF'
    ctx.font = '14px sans-serif'
    ctx.fillText('✕', w - 30, 31)

    // Tab 切换
    this._drawTabs()

    if (this.view === 'search') this._drawSearchView()
    else if (this.view === 'detail') this._drawDetailView()
    else if (this.view === 'logs') this._drawLogsView()

    // 状态提示
    if (this.statusMsg) {
      ctx.fillStyle = 'rgba(212,172,13,0.8)'
      ctx.font = '13px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(this.statusMsg, w / 2, h - 20)
    }
  }

  _drawTabs() {
    const { ctx, w } = this.ui
    const tabs = [{ id: 'search', label: '玩家管理' }, { id: 'logs', label: '对局记录' }]
    const tw = w / tabs.length
    tabs.forEach((t, i) => {
      const isActive = this.view === t.id || (this.view === 'detail' && t.id === 'search')
      ctx.fillStyle = isActive ? 'rgba(192,57,43,0.3)' : 'transparent'
      ctx.fillRect(i * tw, 50, tw, 36)
      ctx.fillStyle = isActive ? '#D4AC0D' : 'rgba(255,255,255,0.4)'
      ctx.font = `${isActive ? 'bold' : ''} 14px sans-serif`
      ctx.textAlign = 'center'
      ctx.fillText(t.label, i * tw + tw / 2, 74)
    })
    // 分隔线
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, 86)
    ctx.lineTo(w, 86)
    ctx.stroke()
  }

  _drawSearchView() {
    const { ctx, w } = this.ui
    let y = 100

    // 搜索框（显示当前query）
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    this.ui._roundRect(16, y, w - 32, 40, 10)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'
    ctx.lineWidth = 1
    this.ui._roundRect(16, y, w - 32, 40, 10)
    ctx.stroke()
    ctx.fillStyle = this.searchQuery ? '#FFFFFF' : 'rgba(255,255,255,0.25)'
    ctx.font = '14px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(
      this.searchQuery || '🔍  输入昵称或 openid 搜索...',
      28, y + 25
    )

    y += 52

    // 结果列表
    this.searchResults.forEach((p, i) => {
      const rowY = y + i * 64
      ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.04)' : 'transparent'
      ctx.fillRect(0, rowY, w, 64)

      // 头像占位
      ctx.fillStyle = '#8B6914'
      ctx.beginPath()
      ctx.arc(36, rowY + 32, 18, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#FFFFFF'
      ctx.font = '12px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(p.nickname.slice(0, 1), 36, rowY + 36)

      // 昵称
      ctx.fillStyle = '#FFFFFF'
      ctx.font = 'bold 14px sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(p.nickname, 64, rowY + 22)

      // openid（截断显示）
      ctx.fillStyle = 'rgba(255,255,255,0.3)'
      ctx.font = '10px monospace'
      ctx.fillText(p.openid.slice(0, 20) + '...', 64, rowY + 40)

      // 余额
      ctx.fillStyle = '#D4AC0D'
      ctx.font = 'bold 16px serif'
      ctx.textAlign = 'right'
      ctx.fillText(`${p.balance}点`, w - 16, rowY + 36)
    })
  }

  _drawDetailView() {
    const { ctx, w } = this.ui
    const p = this.selectedPlayer
    if (!p) return

    let y = 100

    // 返回按钮
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    this.ui._roundRect(12, y, 60, 30, 8)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.font = '13px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('← 返回', 42, y + 20)

    y += 50

    // 头像
    ctx.fillStyle = '#8B6914'
    ctx.beginPath()
    ctx.arc(w / 2, y + 28, 36, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#FFFFFF'
    ctx.font = '20px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(p.nickname.slice(0, 1), w / 2, y + 35)

    y += 80

    // 昵称
    ctx.fillStyle = '#FFFFFF'
    ctx.font = 'bold 20px serif'
    ctx.textAlign = 'center'
    ctx.fillText(p.nickname, w / 2, y)

    // openid
    y += 24
    ctx.fillStyle = 'rgba(255,255,255,0.3)'
    ctx.font = '10px monospace'
    ctx.fillText(p.openid, w / 2, y)

    // 余额大字
    y += 40
    ctx.fillStyle = 'rgba(212,172,13,0.2)'
    this.ui._roundRect(w / 2 - 80, y - 24, 160, 50, 12)
    ctx.fill()
    ctx.fillStyle = '#D4AC0D'
    ctx.font = 'bold 32px serif'
    ctx.textAlign = 'center'
    ctx.fillText(`${p.balance} 点`, w / 2, y + 16)

    // 统计
    y += 60
    ctx.fillStyle = 'rgba(255,255,255,0.3)'
    ctx.font = '13px sans-serif'
    ctx.fillText(`累计对局 ${p.gamesPlayed || 0} 局`, w / 2, y)

    // 修改余额按钮
    y += 36
    const bx = w / 2 - 90
    ctx.fillStyle = '#C0392B'
    this.ui._roundRect(bx, y, 180, 44, 12)
    ctx.fill()
    ctx.fillStyle = '#FFFFFF'
    ctx.font = 'bold 16px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('修改余额', w / 2, y + 28)
  }

  _drawLogsView() {
    const { ctx, w } = this.ui
    let y = 100

    if (this.recentLogs.length === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)'
      ctx.font = '14px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('暂无对局记录', w / 2, 200)
      return
    }

    this.recentLogs.forEach((log, i) => {
      const rowY = y + i * 72
      ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.04)' : 'transparent'
      ctx.fillRect(0, rowY, w, 72)

      ctx.fillStyle = '#D4AC0D'
      ctx.font = 'bold 15px serif'
      ctx.textAlign = 'left'
      ctx.fillText(`🎲 ${log.activityCode}`, 16, rowY + 22)

      ctx.fillStyle = 'rgba(255,255,255,0.5)'
      ctx.font = '12px sans-serif'
      ctx.fillText(`${log.players?.length || 0}人参与  ·  ${log.events?.length || 0}轮`, 16, rowY + 42)

      ctx.fillStyle = 'rgba(255,255,255,0.25)'
      ctx.font = '11px sans-serif'
      const date = log.createdAt ? new Date(log.createdAt).toLocaleDateString('zh-CN') : ''
      ctx.fillText(date, 16, rowY + 60)

      // 胜者
      if (log.winner) {
        ctx.fillStyle = '#D4AC0D'
        ctx.font = '12px sans-serif'
        ctx.textAlign = 'right'
        ctx.fillText(`🏆 ${log.winner.slice(0, 6)}...`, w - 16, rowY + 32)
      }
    })
  }

  // ─────────────────────────────────────────────
  // 触摸路由（外部 touchstart 调用）
  // ─────────────────────────────────────────────
  onTouch(tx, ty) {
    if (!this.visible) return false

    // 关闭按钮
    if (tx > this.ui.w - 50 && ty < 50) {
      this.close()
      return true
    }

    // Tab 切换
    if (ty >= 50 && ty <= 86) {
      const tabW = this.ui.w / 2
      const tabIdx = Math.floor(tx / tabW)
      if (tabIdx === 0) this.view = 'search'
      else this.view = 'logs'
      return true
    }

    // 搜索框点击 → 弹出输入
    if (this.view === 'search' && ty >= 100 && ty <= 140) {
      wx.showModal({
        title: '搜索玩家',
        editable: true,
        placeholderText: '昵称 或 openid',
        success: (res) => {
          if (res.confirm) this.search(res.content)
        }
      })
      return true
    }

    // 搜索结果点击
    if (this.view === 'search') {
      const listY = 152
      const idx = Math.floor((ty - listY) / 64)
      if (idx >= 0 && idx < this.searchResults.length) {
        this.selectPlayer(this.searchResults[idx])
        return true
      }
    }

    // 详情页
    if (this.view === 'detail') {
      // 返回按钮
      if (tx < 80 && ty >= 100 && ty <= 130) {
        this.view = 'search'
        return true
      }
      // 修改余额按钮（大致位置）
      if (ty > this.ui.h * 0.7) {
        this.promptBalanceChange()
        return true
      }
    }

    return true  // 吞掉所有触摸，防止穿透到游戏层
  }
}