const app = getApp()

Page({
  data: {
    nickname: '',
    avatarUrl: '',      // 显示用（可以是临时路径）
    _uploadedUrl: '',   // 云存储永久 URL
    _uploading: false,
  },

  onLoad() {
    try {
      const cached = wx.getStorageSync('userProfile')
      if (cached && cached.nickname) {
        this.setData({
          nickname: cached.nickname,
          avatarUrl: cached.avatarUrl || '',
          _uploadedUrl: cached.avatarUrl || '',
        })
      }
    } catch(e) {}
  },

  onChooseAvatar(e) {
    const tmpPath = e.detail.avatarUrl
    // 先显示临时图让用户看到，同时后台上传
    this.setData({ avatarUrl: tmpPath, _uploading: true })
    this._uploadAvatar(tmpPath)
  },

  _uploadAvatar(tmpPath) {
    // 上传到云存储，文件名用时间戳避免冲突
    const ext = tmpPath.split('.').pop() || 'jpg'
    const cloudPath = `avatars/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
    wx.cloud.uploadFile({
      cloudPath,
      filePath: tmpPath,
      success: (res) => {
        this.setData({ _uploadedUrl: res.fileID, _uploading: false })
      },
      fail: () => {
        // 上传失败，降级用临时路径（本机可用，其他设备看不到）
        this.setData({ _uploadedUrl: tmpPath, _uploading: false })
      }
    })
  },

  onInput(e) {
    this.setData({ nickname: e.detail.value })
  },

  onBlur(e) {
    this.setData({ nickname: e.detail.value })
  },

  onConfirm() {
    const nick = this.data.nickname.trim()
    if (!nick) {
      wx.showToast({ title: '请输入昵称', icon: 'none' })
      return
    }
    if (this.data._uploading) {
      wx.showToast({ title: '头像上传中，请稍候', icon: 'none' })
      return
    }
    this._done(nick, this.data._uploadedUrl || this.data.avatarUrl)
  },

  onSkip() {
    this._done('', '')
  },

  _done(nickname, avatarUrl) {
    app.resolveProfile({ nickname, avatarUrl })
    wx.navigateBack()
  },
})