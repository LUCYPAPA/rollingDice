const Game = require('../../js/game.js')

Page({
  _game: null,

  onLoad() {
    // 仅记录系统信息，等 onReady 再初始化 canvas
    this._windowInfo = wx.getWindowInfo()
    this._deviceInfo = wx.getDeviceInfo()
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
        this._game.start()
      })
  },

  onTouchStart(e) {
    if (this._game) {
      this._game.onTouchStart(e.touches[0])
    }
  },

  onTouchEnd() {
    if (this._game) {
      this._game.onTouchEnd()
    }
  },

  onHide() {
    if (this._game) this._game.onHide()
  },

  onShow() {
    if (this._game) this._game.onShow()
  },

  onUnload() {
    if (this._game) this._game.destroy()
  }
})