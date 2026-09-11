import net from 'node:net'
import crypto from 'node:crypto'

const HEADER_SIZE = 44
const PROTO_FMT_JSON = 1

const PROTO = {
    InitConnect: 1001,
    KeepAlive: 1004,
    GetAccList: 2001,
    GetFunds: 2101,
    GetPositionList: 2102
}

export const CURRENCY_LABEL = {
    1: 'HKD',
    2: 'USD',
    3: 'CNH',
    4: 'JPY',
    5: 'SGD',
    6: 'AUD'
}

function sha1(buf) {
    return crypto.createHash('sha1').update(buf).digest()
}

function encodeHeader(protoId, serialNo, body) {
    const header = Buffer.alloc(HEADER_SIZE)
    header.write('FT', 0, 2, 'ascii')
    header.writeUInt32LE(protoId, 2)
    header.writeUInt8(PROTO_FMT_JSON, 6)
    header.writeUInt8(0, 7)
    header.writeUInt32LE(serialNo, 8)
    header.writeUInt32LE(body.length, 12)
    sha1(body).copy(header, 16)
    return header
}

function decodeHeader(buf) {
    return {
        protoId: buf.readUInt32LE(2),
        serialNo: buf.readUInt32LE(8),
        bodyLen: buf.readUInt32LE(12)
    }
}

function num(value) {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
}

export default class OpenDClient {
    constructor() {
        this.socket = null
        this.host = '127.0.0.1'
        this.port = 11111
        this.serial = 1
        this.pending = new Map()
        this.buffer = Buffer.alloc(0)
        this.keepAliveTimer = 0
        this.keepAliveInterval = 10
        this.connecting = null
        this.ready = false
    }

    async ensureConnected(host, port) {
        const nextHost = host || '127.0.0.1'
        const nextPort = Number(port) || 11111

        if (this.ready && this.socket && !this.socket.destroyed && this.host === nextHost && this.port === nextPort) {
            return
        }

        if (this.host !== nextHost || this.port !== nextPort) {
            this.close()
        }

        this.host = nextHost
        this.port = nextPort

        if (this.connecting) {
            await this.connecting
            return
        }

        this.connecting = this.connect()
        try {
            await this.connecting
        } finally {
            this.connecting = null
        }
    }

    connect() {
        this.closeSocketOnly()

        return new Promise((resolve, reject) => {
            const socket = net.connect({ host: this.host, port: this.port })
            this.socket = socket
            this.buffer = Buffer.alloc(0)
            this.serial = 1
            this.pending = new Map()
            this.ready = false

            const onError = (err) => {
                this.failPending(err)
                this.ready = false
                reject(err)
            }

            socket.setNoDelay(true)
            socket.setTimeout(10000)
            socket.once('timeout', () => onError(new Error('OpenD connect timeout')))
            socket.once('error', onError)
            socket.on('close', () => {
                this.ready = false
                this.failPending(new Error('OpenD disconnected'))
                this.clearKeepAlive()
            })
            socket.on('data', (chunk) => this.onData(chunk))

            socket.once('connect', async () => {
                socket.setTimeout(0)
                socket.off('error', onError)
                socket.on('error', (err) => {
                    this.ready = false
                    this.failPending(err)
                })
                try {
                    const init = await this.send(PROTO.InitConnect, {
                        c2s: {
                            clientVer: 100,
                            clientID: 'com.raykira.futuportfolio',
                            recvNotify: false,
                            packetEncAlgo: -1,
                            pushProtoFmt: 1,
                            programmingLanguage: 'JavaScript'
                        }
                    })
                    if (init.retType !== 0) {
                        throw new Error(init.retMsg || 'InitConnect failed')
                    }
                    this.keepAliveInterval = num(init.s2c?.keepAliveInterval) || 10
                    this.ready = true
                    this.startKeepAlive()
                    resolve()
                } catch (err) {
                    this.close()
                    reject(err)
                }
            })
        })
    }

    onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk])
        while (this.buffer.length >= HEADER_SIZE) {
            const header = decodeHeader(this.buffer)
            const total = HEADER_SIZE + header.bodyLen
            if (this.buffer.length < total) break
            const body = this.buffer.slice(HEADER_SIZE, total)
            this.buffer = this.buffer.slice(total)

            let parsed
            try {
                parsed = JSON.parse(body.toString('utf8'))
            } catch (err) {
                parsed = { retType: -1, retMsg: 'Invalid JSON from OpenD' }
            }

            const waiter = this.pending.get(header.serialNo)
            if (waiter) {
                this.pending.delete(header.serialNo)
                clearTimeout(waiter.timer)
                waiter.resolve(parsed)
            }
        }
    }

    send(protoId, payload, timeoutMs = 8000) {
        if (!this.socket || this.socket.destroyed) {
            return Promise.reject(new Error('OpenD is not connected'))
        }

        return new Promise((resolve, reject) => {
            const body = Buffer.from(JSON.stringify(payload), 'utf8')
            const serialNo = this.serial++
            const timer = setTimeout(() => {
                this.pending.delete(serialNo)
                reject(new Error(`OpenD request timeout (${protoId})`))
            }, timeoutMs)

            this.pending.set(serialNo, { resolve, reject, timer })
            this.socket.write(Buffer.concat([encodeHeader(protoId, serialNo, body), body]))
        })
    }

    startKeepAlive() {
        this.clearKeepAlive()
        const interval = Math.max(5, this.keepAliveInterval - 2) * 1000
        this.keepAliveTimer = setInterval(() => {
            if (!this.ready) return
            this.send(PROTO.KeepAlive, {
                c2s: { time: Math.floor(Date.now() / 1000) }
            }).catch(() => {
                this.ready = false
            })
        }, interval)
        if (typeof this.keepAliveTimer.unref === 'function') {
            this.keepAliveTimer.unref()
        }
    }

    clearKeepAlive() {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer)
            this.keepAliveTimer = 0
        }
    }

    failPending(err) {
        for (const waiter of this.pending.values()) {
            clearTimeout(waiter.timer)
            waiter.reject(err)
        }
        this.pending.clear()
    }

    closeSocketOnly() {
        this.clearKeepAlive()
        this.failPending(new Error('OpenD connection closed'))
        this.ready = false
        if (this.socket) {
            this.socket.removeAllListeners()
            this.socket.destroy()
            this.socket = null
        }
    }

    close() {
        this.closeSocketOnly()
    }

    pickAccount(accList, trdEnv, accID) {
        const list = Array.isArray(accList) ? accList : []
        if (accID) {
            const match = list.find((acc) => String(acc.accID) === String(accID))
            if (match) return match
        }

        const env = Number(trdEnv)
        const matches = list.filter((acc) => Number(acc.trdEnv) === env)
        matches.sort((a, b) => {
            const aMarkets = (a.trdMarketAuthList || []).length
            const bMarkets = (b.trdMarketAuthList || []).length
            if (bMarkets !== aMarkets) return bMarkets - aMarkets
            return Number(a.accStatus || 0) - Number(b.accStatus || 0)
        })
        return matches[0] || list[0] || null
    }

    async getPortfolio(settings) {
        const host = settings.host || '127.0.0.1'
        const port = Number(settings.port) || 11111
        const trdEnv = Number(settings.trdEnv ?? 1)
        const currency = Number(settings.currency ?? 1)

        await this.ensureConnected(host, port)

        const accRes = await this.send(PROTO.GetAccList, {
            c2s: {
                userID: 0,
                trdCategory: 1,
                needGeneralSecAccount: true
            }
        })
        if (accRes.retType !== 0) {
            throw new Error(accRes.retMsg || 'GetAccList failed')
        }

        const account = this.pickAccount(accRes.s2c?.accList, trdEnv, settings.accID)
        if (!account) {
            throw new Error('No matching Futu account')
        }

        const header = {
            trdEnv: Number(account.trdEnv),
            accID: String(account.accID),
            trdMarket: (account.trdMarketAuthList && account.trdMarketAuthList[0]) || 1
        }

        const fundsRes = await this.send(PROTO.GetFunds, {
            c2s: {
                header,
                refreshCache: true,
                currency
            }
        })
        if (fundsRes.retType !== 0) {
            throw new Error(fundsRes.retMsg || 'GetFunds failed')
        }

        let positions = []
        try {
            const posRes = await this.send(PROTO.GetPositionList, {
                c2s: {
                    header,
                    refreshCache: true
                }
            })
            if (posRes.retType === 0) {
                positions = posRes.s2c?.positionList || []
            }
        } catch (err) {
            console.log('===GetPositionList error', err)
        }

        const funds = fundsRes.s2c?.funds || {}
        const totalAssets = num(funds.totalAssets)
        const marketVal = num(funds.marketVal)
        const plByCurrency = {}
        for (const pos of positions) {
            const ccy = Number(pos.currency) || 0
            if (!plByCurrency[ccy]) {
                plByCurrency[ccy] = { today: 0, total: 0, val: 0 }
            }
            plByCurrency[ccy].today += num(pos.tdPlVal)
            plByCurrency[ccy].total += num(pos.plVal)
            plByCurrency[ccy].val += num(pos.val)
        }

        const fxToDisplay = { [currency]: 1 }
        const otherCurrencies = Object.keys(plByCurrency)
            .map(Number)
            .filter((ccy) => ccy && ccy !== currency)
        for (const ccy of otherCurrencies) {
            try {
                const fxRes = await this.send(PROTO.GetFunds, {
                    c2s: { header, refreshCache: false, currency: ccy }
                })
                const otherAssets = num(fxRes.s2c?.funds?.totalAssets)
                fxToDisplay[ccy] = otherAssets > 0 ? totalAssets / otherAssets : 1
            } catch (err) {
                console.log('===fx rate error', ccy, err)
                fxToDisplay[ccy] = 1
            }
        }

        let todayPl = 0
        let totalPl = 0
        for (const [ccy, bucket] of Object.entries(plByCurrency)) {
            const rate = fxToDisplay[Number(ccy)] ?? 1
            todayPl += bucket.today * rate
            totalPl += bucket.total * rate
        }

        return {
            label: CURRENCY_LABEL[currency] || 'FUTU',
            totalAssets,
            marketVal,
            todayPl,
            totalPl,
            currency,
            accID: String(account.accID),
            cardNum: account.uniCardNum || account.cardNum || ''
        }
    }
}

export const openDClient = new OpenDClient()
