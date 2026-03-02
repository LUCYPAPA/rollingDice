import Game from './js/game.js'

const canvas = wx.createCanvas()
const game = new Game(canvas)
game.start()