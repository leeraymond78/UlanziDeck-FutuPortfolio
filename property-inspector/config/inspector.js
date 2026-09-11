let ACTION_SETTING = {}
let form = ''
$UD.connect('com.raykira.ulanzideck.futuportfolio.config')

$UD.onConnected(conn => {
  form = document.querySelector('#property-inspector')

  const el = document.querySelector('.udpi-wrapper')
  el.classList.remove('hidden')

  form.addEventListener(
    'input',
    Utils.debounce(() => {
      const value = Utils.getFormValue(form)
      ACTION_SETTING = value
      $UD.sendParamFromPlugin(ACTION_SETTING)
    })
  )
})

$UD.onAdd(jsonObj => {
  if (jsonObj && jsonObj.param) {
    settingSaveParam(jsonObj.param)
  }
})

$UD.onParamFromApp(jsonObj => {
  if (jsonObj && jsonObj.param) {
    settingSaveParam(jsonObj.param)
  }
})

function settingSaveParam(params) {
  ACTION_SETTING = params
  Utils.setFormValue(ACTION_SETTING, form)
}
