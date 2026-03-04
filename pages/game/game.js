const Game = require('../../js/game.js')

Page({
  _game: null,
  _nicknameResolve: null,  // 等待昵称输入的 Promise resolve

  data: {
    showNicknamePanel: false,
    tempNickname: '',
    tempAvatarUrl: '',
  },

  onLoad() {
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
        // 把昵称收集函数注入给 Game，供 Network.login 调用
        this._game.collectNickname = () => this._showNicknamePanel()
        this._game.start()
      })
  },

  // 显示昵称面板，返回 Promise，resolve 时带 { nickname, avatarUrl }
  _showNicknamePanel() {
    return new Promise(resolve => {
      this._nicknameResolve = resolve
      this.setData({ showNicknamePanel: true, tempNickname: '', tempAvatarUrl: '' })
    })
  },

  onChooseAvatar(e) {
    this.setData({ tempAvatarUrl: e.detail.avatarUrl })
  },

  onNicknameInput(e) {
    this.setData({ tempNickname: e.detail.value })
  },

  onNicknameBlur(e) {
    this.setData({ tempNickname: e.detail.value })
  },

  onNicknameConfirm() {
    const nick = this.data.tempNickname.trim()
    if (!nick) {
      wx.showToast({ title: '请输入昵称', icon: 'none' })
      return
    }
    this.setData({ showNicknamePanel: false })
    if (this._nicknameResolve) {
      this._nicknameResolve({ nickname: nick, avatarUrl: this.data.tempAvatarUrl })
      this._nicknameResolve = null
    }
  },

  onNicknameCancel() {
    this.setData({ showNicknamePanel: false })
    if (this._nicknameResolve) {
      // 取消时传空，login 会用 openid 后6位兜底
      this._nicknameResolve({ nickname: '', avatarUrl: '' })
      this._nicknameResolve = null
    }
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
  }
})