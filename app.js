App({
  onLaunch() {
    if (wx.cloud) {
      wx.cloud.init({
        env: 'cloud1-0gw8283g4b8815c5',
        traceUser: true,
      })
    }
  }
})