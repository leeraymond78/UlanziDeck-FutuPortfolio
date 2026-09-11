import { UlanzideckApi } from './actions/ulanzideck-api/index.js'
import FutuPortfolio from './actions/futuportfolio.js'
import { openDClient } from './actions/opendClient.js'

const ACTION_CACHES = {}
const $UD = new UlanzideckApi()

$UD.connect('com.raykira.ulanzideck.futuportfolio')
$UD.onConnected(() => {})

$UD.onAdd((jsn) => {
    const context = jsn.context
    const instance = ACTION_CACHES[context]
    if (!instance) {
        ACTION_CACHES[context] = new FutuPortfolio(context, $UD)
        onSetSettings(jsn)
    } else {
        instance.add()
    }
})

$UD.onSetActive((jsn) => {
    const instance = ACTION_CACHES[jsn.context]
    if (instance) instance.setActive(jsn.active)
})

$UD.onRun((jsn) => {
    const instance = ACTION_CACHES[jsn.context]
    if (!instance) $UD.emit('add', jsn)
    else instance.run()
})

$UD.onClear((jsn) => {
    if (!jsn.param) return
    for (let i = 0; i < jsn.param.length; i++) {
        const context = jsn.param[i].context
        if (ACTION_CACHES[context]) {
            ACTION_CACHES[context].clear()
            delete ACTION_CACHES[context]
        }
    }
    if (Object.keys(ACTION_CACHES).length === 0) {
        openDClient.close()
    }
})

$UD.onParamFromApp((jsn) => onSetSettings(jsn))
$UD.onParamFromPlugin((jsn) => onSetSettings(jsn))

function onSetSettings(jsn) {
    const settings = jsn.param || {}
    const instance = ACTION_CACHES[jsn.context]
    if (!settings || !instance || JSON.stringify(settings) === '{}') return
    if (typeof instance.setParams === 'function') instance.setParams(settings)
}
