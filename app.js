const { CLOUD_ENV, loadRemoteConfig } = require('./js/config.js')

App({
  onLaunch() {
    if (wx.cloud) {
      wx.cloud.init({ env: CLOUD_ENV, traceUser: true })
      // 云初始化后异步拉取远程配置，失败时静默降级到本地默认值
      loadRemoteConfig()
    }
  },

  // profile 页完成后，通过这里回调 game 页
  _profileCallback: null,

  setProfileCallback(fn) {
    this._profileCallback = fn
  },

  resolveProfile(data) {
    if (this._profileCallback) {
      this._profileCallback(data)
      this._profileCallback = null
    }
  },
})