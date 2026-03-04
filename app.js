App({
  onLaunch() {
    if (wx.cloud) {
      wx.cloud.init({
        env: 'cloud1-0gqcenjqfe77a332',
        traceUser: true,
      })
    }
  }
})