const app = getApp()
const Game = require('../../js/game.js')

Page({
  _game: null,

  data: {
    canvasOffsetX: 0,
    canvasW: 0,
    canvasH: 0,
  },

  onLoad(options) {
    this._windowInfo = wx.getWindowInfo()
    this._deviceInfo = wx.getDeviceInfo()
    this._joinCode = options.roomCode || ''
  },

  onReady() {
    const windowInfo = this._windowInfo
    const deviceInfo = this._deviceInfo
    const dpr = deviceInfo.pixelRatio || windowInfo.pixelRatio || 2

    const screenW = windowInfo.windowWidth
    const screenH = windowInfo.windowHeight

    const GAME_RATIO = 375 / 812
    let gameW, gameH, offsetX

    if (screenW / screenH > GAME_RATIO) {
      gameH   = screenH
      gameW   = Math.floor(gameH * GAME_RATIO)
      offsetX = Math.floor((screenW - gameW) / 2)
    } else {
      gameW   = screenW
      gameH   = screenH
      offsetX = 0
    }

    this.setData({ canvasOffsetX: offsetX, canvasW: gameW, canvasH: gameH })

    const query = wx.createSelectorQuery()
    query.select('#gameCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        const canvas = res[0].node
        canvas.width  = gameW * dpr
        canvas.height = gameH * dpr

        this._game = new Game(canvas, gameW, gameH, dpr)
        this._game.collectNickname = () => this._openProfilePage()
        this._game.start()

        if (this._joinCode) {
          setTimeout(() => this._game.autoJoinRoom(this._joinCode), 500)
        }
      })
  },

  _openProfilePage() {
    let cached = null
    try { cached = wx.getStorageSync('userProfile') } catch (e) {}
    if (cached && cached.nickname) {
      return Promise.resolve({ nickname: cached.nickname, avatarUrl: cached.avatarUrl || '' })
    }
    return new Promise((resolve) => {
      app.setProfileCallback(resolve)
      wx.navigateTo({
        url: '/pages/profile/profile',
        fail: (err) => {
          console.error('navigate profile fail', err)
          app.setProfileCallback(null)
          resolve({ nickname: '', avatarUrl: '' })
        }
      })
    })
  },

  onTouchStart(e) {
    if (!this._game) return
    const touch = e.touches[0]
    const offsetX = this.data.canvasOffsetX || 0
    this._game.onTouchStart({ clientX: touch.clientX - offsetX, clientY: touch.clientY })
  },

  onTouchEnd() {
    if (this._game) this._game.onTouchEnd()
  },

  onHide() {
    if (this._game) this._game.onHide()
  },

  onShow() {
    if (this._game) this._game.onShow()
  },

  onUnload() {
    if (this._game) this._game.destroy()
  },

  openAssistant() {
    wx.navigateTo({ url: '/pages/assistant/index' })
  },

  onShareAppMessage() {
    const code = this._game && this._game.activityCode
    if (code) {
      return {
        title: `快来和我一起白相！房间号：${code}`,
        path: `/pages/game/game?roomCode=${code}`,
      }
    }
    return { title: '好婆叫侬掷骰子了', path: '/pages/game/game' }
  },
})