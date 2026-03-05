const app = getApp()
const Game = require('../../js/game.js')

Page({
  _game: null,

  data: {},

  onLoad(options) {
    this._windowInfo = wx.getWindowInfo()
    this._deviceInfo = wx.getDeviceInfo()
    this._joinCode = options.roomCode || ''
  },

  onReady() {
    const windowInfo = this._windowInfo
    const deviceInfo = this._deviceInfo
    const dpr = deviceInfo.pixelRatio || windowInfo.pixelRatio || 2

    const query = wx.createSelectorQuery()
    query.select('#gameCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        const canvas = res[0].node
        const w = res[0].width  > 0 ? res[0].width  : windowInfo.windowWidth
        const h = res[0].height > 0 ? res[0].height : windowInfo.windowHeight

        canvas.width  = w * dpr
        canvas.height = h * dpr

        this._game = new Game(canvas, w, h, dpr)
        this._game.collectNickname = () => this._openProfilePage()
        this._game.start()

        if (this._joinCode) {
          setTimeout(() => this._game.autoJoinRoom(this._joinCode), 500)
        }
      })
  },

  _openProfilePage() {
    // 有缓存直接用，无缓存才跳 profile 页
    let cached = null
    try { cached = wx.getStorageSync('userProfile') } catch(e) {}
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
    if (this._game) this._game.onTouchStart(e.touches[0])
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

  onShareAppMessage() {
    const code = this._game && this._game.activityCode
    if (code) {
      return {
        title: `快来和我一起白相！房间号：${code}`,
        path: `/pages/game/game?roomCode=${code}`,
      }
    }
    return { title: '好婆叫侬来白相', path: '/pages/game/game' }
  },
})