import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { openDClient } from './opendClient.js'

const FONT_STACK = '"FOT-Matisse Pro", "MatissePro-EB", sans-serif'
let matisseReady = false

function registerMatisseFont() {
    if (matisseReady) return
    const candidates = [
        path.join(os.homedir(), 'Library/Fonts/FOT-Matisse Pro EB.otf'),
        '/Library/Fonts/FOT-Matisse Pro EB.otf',
        path.join(os.homedir(), 'Library/Fonts/MatissePro-EB.otf')
    ]
    const fontPath = candidates.find((file) => fs.existsSync(file))
    if (fontPath) {
        GlobalFonts.registerFromPath(fontPath, 'FOT-Matisse Pro')
        GlobalFonts.registerFromPath(fontPath, 'MatissePro-EB')
    }
    matisseReady = true
}

function formatWorth(value) {
    const amount = Math.round(Number(value) || 0)
    return Math.abs(amount).toLocaleString('en-US')
}

function formatPlAmount(value) {
    return Math.abs(Math.round(Number(value) || 0)).toLocaleString('en-US')
}

function formatPlPercent(value) {
    return `${Math.abs(Number(value) || 0).toFixed(2)}%`
}

function plColor(amount) {
    return amount > 0 ? '#3f9c24' : amount < 0 ? '#c62e1a' : '#ffffff'
}

function withPlType(data, plType) {
    const amount = plType === 'total' ? Number(data.totalPl) || 0 : Number(data.todayPl) || 0
    const basis = data.marketVal > 0 ? data.marketVal : data.totalAssets
    return {
        ...data,
        plAmount: amount,
        plPercent: basis ? (amount / basis) * 100 : 0
    }
}

export default class FutuPortfolio {
    constructor(context, $UD) {
        this.$UD = $UD
        this.context = context
        this.lastIcon = ''
        this.HORIZONTAL_COMPRESS = 0.7
        this.allowSend = true
        this.debounceTimer = 0
        this.refreshTimer = 0
        this.fetching = false
        this.lastData = null

        this.settings = {
            host: '127.0.0.1',
            port: 11111,
            trdEnv: 1,
            currency: 1,
            plType: 'today',
            refreshDuration: 60,
            accID: ''
        }

        registerMatisseFont()
        this.run()
    }

    run() {
        this.clearTimers()
        this.fetchData()
        const duration = Math.max(10, Number(this.settings.refreshDuration) || 60)
        this.refreshTimer = setInterval(() => this.fetchData(), duration * 1000)
    }

    add() {
        this.run()
    }

    togglePlType() {
        this.settings.plType = this.settings.plType === 'total' ? 'today' : 'total'
        if (typeof this.$UD.sendParamFromPlugin === 'function') {
            this.$UD.sendParamFromPlugin(this.settings, this.context)
        }
        if (this.lastData) {
            this.createIcon(null, withPlType(this.lastData, this.settings.plType))
            return
        }
        this.fetchData()
    }

    fetchData() {
        if (this.debounceTimer) clearTimeout(this.debounceTimer)

        this.debounceTimer = setTimeout(async () => {
            if (this.fetching) return
            this.fetching = true
            this.createIcon('Loading...', null)

            try {
                const data = await openDClient.getPortfolio(this.settings)
                this.lastData = data
                this.createIcon(null, withPlType(data, this.settings.plType))
            } catch (err) {
                console.log('===futu portfolio error', err)
                const message = /ECONNREFUSED|not connected|connect timeout/i.test(String(err && err.message))
                    ? 'OpenD?'
                    : 'Error'
                this.createIcon(message, null)
            } finally {
                this.fetching = false
            }
        }, 150)
    }

    drawTextWithSpacing(ctx, text, x, y, letterSpacing = 0, align = 'left') {
        ctx.save()
        ctx.scale(this.HORIZONTAL_COMPRESS, 1)
        const scaledX = x / this.HORIZONTAL_COMPRESS
        ctx.textAlign = 'left'
        if (letterSpacing === 0) {
            if (align === 'right') {
                const metrics = ctx.measureText(text)
                ctx.fillText(text, scaledX - metrics.width, y)
            } else {
                ctx.fillText(text, scaledX, y)
            }
            ctx.restore()
            return
        }
        let totalWidth = 0
        const charWidths = []
        for (let i = 0; i < text.length; i++) {
            const char = text[i]
            const width = ctx.measureText(char).width
            charWidths.push(width)
            totalWidth += width
        }
        const spacing = letterSpacing * (text.length - 1)
        const startX = align === 'right' ? scaledX - (totalWidth + spacing) : scaledX
        let currentX = startX
        for (let i = 0; i < text.length; i++) {
            const char = text[i]
            ctx.fillText(char, currentX, y)
            currentX += charWidths[i] + letterSpacing
        }
        ctx.restore()
    }

    createIcon(text, data) {
        registerMatisseFont()
        const canvas = createCanvas(196, 196)
        const ctx = canvas.getContext('2d')
        const centerX = canvas.width / 2
        const centerY = canvas.height / 2
        const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
        gradient.addColorStop(0, '#0a0a0a')
        gradient.addColorStop(1, '#1a1a1a')
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'left'
        const leftPadding = 10

        if (data) {
            const formattedWorth = formatWorth(data.totalAssets)
            const formattedChange = `${formatPlAmount(data.plAmount)}  ${formatPlPercent(data.plPercent)}`
            ctx.fillStyle = '#ffffff'
            ctx.shadowColor = '#ffffff'
            ctx.shadowBlur = 0
            ctx.font = `28px ${FONT_STACK}`
            this.drawTextWithSpacing(ctx, `株式 ${data.label}`, leftPadding, centerY - 50, 2, 'left')
            ctx.font = `24px ${FONT_STACK}`
            this.drawTextWithSpacing(
                ctx,
                this.settings.plType === 'total' ? '累計' : '今日',
                canvas.width - 10,
                centerY - 50,
                2,
                'right'
            )
            const fontSize = formattedWorth.length > 8 ? 48 : formattedWorth.length > 6 ? 52 : 56
            ctx.font = `${fontSize}px ${FONT_STACK}`
            this.drawTextWithSpacing(ctx, formattedWorth, leftPadding, centerY - 5, 3, 'left')
            ctx.shadowBlur = 0
            ctx.fillStyle = plColor(data.plAmount)
            ctx.shadowColor = plColor(data.plAmount)
            ctx.font = `28px ${FONT_STACK}`
            this.drawTextWithSpacing(ctx, formattedChange, leftPadding, centerY + 40, 2, 'left')
        } else if (text) {
            ctx.textAlign = 'center'
            ctx.fillStyle = '#ffffff'
            ctx.shadowColor = '#ffffff'
            ctx.shadowBlur = 8
            const fontSize = text.length > 8 ? 24 : text.length > 6 ? 28 : 32
            ctx.font = `${fontSize}px ${FONT_STACK}`
            ctx.fillText(text, centerX, centerY)
        }

        this.setIcon(canvas.toDataURL('image/png'))
    }

    setIcon(icon) {
        if (!this.allowSend) return
        this.lastIcon = icon || this.lastIcon
        if (this.lastIcon) this.$UD.setBaseDataIcon(this.context, this.lastIcon)
    }

    setActive(active) {
        this.allowSend = true
        this.setIcon()
        this.allowSend = active
    }

    setParams(jsn) {
        const next = { ...jsn }
        if (next.port !== undefined) next.port = Number(next.port)
        if (next.trdEnv !== undefined) next.trdEnv = Number(next.trdEnv)
        if (next.currency !== undefined) next.currency = Number(next.currency)
        if (next.refreshDuration !== undefined) next.refreshDuration = Number(next.refreshDuration)

        const prev = JSON.stringify(this.settings)
        this.settings = {
            ...this.settings,
            ...next
        }
        if (JSON.stringify(this.settings) === prev) return
        this.run()
    }

    clearTimers() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer)
            this.refreshTimer = 0
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer)
            this.debounceTimer = 0
        }
    }

    clear() {
        this.clearTimers()
    }
}
