App({
  onLaunch() {
    if (wx.cloud) {
      wx.cloud.init({
        env: 'cloud1-0gqcenjqfe77a332',
        traceUser: true,
      })
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