import * as api from './api.js'
import { liveWave } from './wave.js'

const TYPES = {
  classic: [[1, 1, 300], [0, 0, 300], [1, 1, 300], [0, 0, 300], [1, 1, 1500], [0, 0, 1000]],
  waves: [[0, 1, 2000], [1, 0, 2000]],
  rise: [[0, 1, 20000], [1, 1, 8000]],
  knock: [[1, 1, 120], [0, 0, 120], [1, 1, 120], [0, 0, 120], [1, 1, 120], [0, 0, 900]],
}
const TRY_TYPES = { rise: [[0, 1, 10000], [1, 1, 4000]] }
const VIEWS = { knock: 'cycle', rise: 'pinned' }
const NAMES = Object.keys(TYPES)
const title = (name) => name[0].toUpperCase() + name.slice(1)
const minutesText = (m) => m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60}` : `${m / 60} h`
const secondsText = (s) => s < 60 || s % 60 ? `${s} s` : `${s / 60} min`
const STEPPERS = {
  offset_min: { name: 'Wake me', hint: 'before the first event', choices: [15, 30, 45, 60, 75, 90, 120], text: minutesText },
  max_run_s: { name: 'Alarm stops after', hint: "if you don't press Stop", choices: [30, 60, 90, 120, 180, 300], text: secondsText },
  try_s: { name: 'Try plays for', hint: 'each time', choices: [5, 10, 15, 20], text: secondsText },
}
const MANUAL_KEY = 'shakeawake-manual'
const DEFAULT_HOUR = 7
const HEIGHTS = { preview: 1, browsing: 0.95, armed: 0.85, idle: 0.6 }
const DAWN_S = 8 * 3600
const ANGLES = [-45, 45, 135, 225]
const UNLOCK_AT = 0.85
const STATUS_MS = 2500
const DONE_MS = 1200
const SHAKE_MS = 600
const TICK_MS = 30_000
const PICO_CHECK_MS = 5_000

const $ = (id) => document.getElementById(id)
const now = () => Date.now() / 1000
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
const setWave = liveWave($('wave-path'), reducedMotion)

let settings = null
let browse = 0
let knobAngle = ANGLES[0]
let manualTime = 0
try { manualTime = Number(localStorage.getItem(MANUAL_KEY)) || 0 } catch {}
let calendarNext = 0
let preview = null
let previewTimer = 0
let statusTimer = 0
let picoOnline = null

function shake(element, kind = 'shake') {
  element.classList.remove(kind)
  void element.offsetWidth
  element.classList.add(kind)
  setTimeout(() => element.classList.remove(kind), SHAKE_MS)
}

function showStatus(text) {
  $('status').textContent = text
  $('status').dataset.show = ''
  clearTimeout(statusTimer)
  statusTimer = setTimeout(() => delete $('status').dataset.show, STATUS_MS)
}

async function run(call, failText = 'Not sent: ') {
  try {
    const reply = (await call()) || {}
    if (typeof reply.delivered === 'boolean') setPico(reply.delivered)
    return reply
  } catch (error) {
    if (error.message === 'wrong password') showLock()
    else showStatus(failText + error.message)
    return null
  }
}

function swap(update) {
  if (document.startViewTransition && !reducedMotion) document.startViewTransition(update)
  else update()
}

const pad = (n) => String(n).padStart(2, '0')
function toInputValue(seconds) {
  const d = new Date(seconds * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function resetPicker() {
  const d = new Date()
  d.setHours(DEFAULT_HOUR, 0, 0, 0)
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
  $('custom-input').value = toInputValue(d.getTime() / 1000)
}
const pickedTime = () => {
  const value = $('custom-input').value
  return value ? Math.floor(new Date(value).getTime() / 1000) : 0
}

function dayWords(date) {
  const days = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000)
  if (days === 0) return ''
  if (days === 1) return 'tomorrow'
  if (days < 7) return date.toLocaleDateString([], { weekday: 'long' })
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function timeLeft(seconds) {
  const minutes = Math.max(1, Math.ceil((seconds - now()) / 60))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

function setManual(time) {
  manualTime = time
  try { localStorage.setItem(MANUAL_KEY, time) } catch {}
  if (!time) resetPicker()
}

function nextAlarm() {
  const times = [manualTime, calendarNext].filter((time) => time > now())
  return times.length ? Math.min(...times) : null
}

function render() {
  if (manualTime && manualTime <= now()) setManual(0)
  const next = nextAlarm()
  const shown = NAMES[browse]
  const set = settings.pattern

  $('screen').toggleAttribute('data-empty', !next)
  if (next) {
    const date = new Date(next * 1000)
    const parts = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).formatToParts(date)
    $('next-label').textContent = ('Next alarm ' + dayWords(date)).trim()
    $('next-time').textContent = parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim()
    $('next-period').textContent = parts.find((p) => p.type === 'dayPeriod')?.value || ''
    $('next-until').textContent = 'Wake up in ' + timeLeft(next)
  } else {
    $('next-label').textContent = 'No alarm set'
    $('next-time').textContent = '--:--'
    $('next-period').textContent = ''
    $('next-until').textContent = ''
  }

  const height = preview ? HEIGHTS.preview : shown !== set ? HEIGHTS.browsing : next ? HEIGHTS.armed : HEIGHTS.idle
  setWave(preview ? TRY_TYPES[preview] || TYPES[preview] : TYPES[shown], height, VIEWS[preview || shown])
  $('wave').toggleAttribute('data-live', Boolean(preview || next))
  $('app').toggleAttribute('data-playing', Boolean(preview))
  $('try-text').textContent = preview ? 'Playing' : 'Try'
  $('app').style.setProperty('--dawn', next ? Math.min(1, Math.max(0, 1 - (next - now()) / DAWN_S)) : 0)

  $('current-type').textContent = title(set)
  if (!knobDrag) $('knob').style.setProperty('--angle', knobAngle + 'deg')
  $('knob').setAttribute('aria-valuenow', browse)
  $('knob').setAttribute('aria-valuetext', title(shown))
  for (const label of $('knob-labels').children) {
    label.setAttribute('aria-current', label.dataset.type === shown)
    label.toggleAttribute('data-set', label.dataset.type === set)
  }
  $('deck').toggleAttribute('data-changed', shown !== set)
  $('knob-cap').setAttribute('aria-label', shown === set ? 'Alarm type set' : 'Set alarm type to ' + title(shown))

  $('custom').toggleAttribute('data-set', manualTime > 0)
  $('custom-text').textContent = manualTime
    ? new Date(manualTime * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'Set custom alarm'
}

function browseTo(index) {
  browse = index
  knobAngle += ((ANGLES[index] - knobAngle) % 360 + 540) % 360 - 180
  render()
}
function browseStep(step) {
  browse = (browse + step + NAMES.length) % NAMES.length
  knobAngle += 90 * step
  render()
}

function useSettings(next) {
  settings = next
  $('app').style.setProperty('--try-ms', settings.try_s * 1000 + 'ms')
}

async function putSettings(next) {
  const reply = await api.saveSettings(next)
  setPico(reply.delivered)
  useSettings(next)
  render()
}

async function chooseType() {
  const pattern = NAMES[browse]
  if (pattern !== settings.pattern) await run(() => putSettings({ ...settings, pattern }))
}

async function tryType() {
  if (picoOnline === false || $('try').classList.contains('sending')) return refuse($('try'))
  const name = NAMES[browse]
  $('try').classList.add('sending')
  const reply = await run(() => api.test(name, settings.try_s))
  $('try').classList.remove('sending')
  if (!reply) return
  if (!reply.delivered) return refuse($('try'))
  preview = name
  $('app').removeAttribute('data-playing')
  void $('app').offsetWidth
  clearTimeout(previewTimer)
  previewTimer = setTimeout(endPreview, settings.try_s * 1000)
  render()
}

function refuse(key) {
  if (picoOnline !== false) return
  shake(key, 'nudge')
  $('pico').classList.remove('flare')
  void $('pico').offsetWidth
  $('pico').classList.add('flare')
}

function endPreview() {
  clearTimeout(previewTimer)
  preview = null
  render()
}

async function stop() {
  endPreview()
  const reply = await run(api.stop)
  if (reply && !reply.delivered) refuse($('stop'))
}

async function setCustom() {
  const time = pickedTime()
  if (time <= now()) return shake($('custom-pick'))
  if (await run(() => api.setAlarm(time, settings.pattern))) {
    setManual(time)
    render()
  }
}

async function clearCustom() {
  if (await run(api.clearAlarm)) {
    setManual(0)
    render()
  }
}

async function sync() {
  const button = $('sync')
  if (button.dataset.state === 'busy') return
  button.dataset.state = 'busy'
  const alarms = await run(api.sync, 'Sync failed: ')
  button.dataset.state = alarms ? 'done' : ''
  if (!alarms) return shake(button)
  calendarNext = alarms.length ? alarms[0][0] : 0
  setTimeout(() => { button.dataset.state = '' }, DONE_MS)
  render()
}

let knobDrag = null
const typeAt = (angle) => (((Math.round((angle - ANGLES[0]) / 90)) % NAMES.length) + NAMES.length) % NAMES.length
const snap = (angle) => ANGLES[0] + 90 * Math.round((angle - ANGLES[0]) / 90)
function pointerAngle(event) {
  const box = $('knob').getBoundingClientRect()
  return Math.atan2(event.clientX - (box.left + box.width / 2), (box.top + box.height / 2) - event.clientY) * 180 / Math.PI
}
$('knob').onpointerdown = (event) => {
  knobDrag = { angle: knobAngle, last: pointerAngle(event) }
  $('knob').setPointerCapture(event.pointerId)
  $('knob').classList.add('dragging')
}
$('knob').onpointermove = (event) => {
  if (!knobDrag) return
  const angle = pointerAngle(event)
  knobDrag.angle += ((angle - knobDrag.last + 540) % 360) - 180
  knobDrag.last = angle
  $('knob').style.setProperty('--angle', knobDrag.angle + 'deg')
  if (typeAt(knobDrag.angle) !== browse) {
    browse = typeAt(knobDrag.angle)
    render()
  }
}
$('knob').onpointerup = $('knob').onpointercancel = () => {
  if (!knobDrag) return
  knobAngle = snap(knobDrag.angle)
  knobDrag = null
  $('knob').classList.remove('dragging')
  render()
}
$('knob').onkeydown = (event) => {
  if (['ArrowRight', 'ArrowUp'].includes(event.key)) { event.preventDefault(); browseStep(1) }
  if (['ArrowLeft', 'ArrowDown'].includes(event.key)) { event.preventDefault(); browseStep(-1) }
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseType() }
}

let progress = 0
let dragFrom = null
let checking = false
const travel = () => $('slide').clientWidth - $('slide-thumb').offsetWidth - 2 * parseFloat(getComputedStyle($('slide')).paddingLeft)

function setSlide(value) {
  progress = value
  $('slide').style.setProperty('--progress', value)
  $('slide').style.setProperty('--x', value * travel() + 'px')
}

function askPassword(hint = 'Enter password') {
  setSlide(0)
  $('password').value = ''
  $('password').placeholder = hint
  $('slide').toggleAttribute('data-ready', api.hasPassword())
}

$('password').oninput = () => $('slide').toggleAttribute('data-ready', $('password').value !== '' || api.hasPassword())
$('slide-thumb').onpointerdown = (event) => {
  if (checking) return
  if (!$('password').value && !api.hasPassword()) {
    $('password').focus()
    return shake($('slide'))
  }
  dragFrom = event.clientX - progress * travel()
  $('slide-thumb').setPointerCapture(event.pointerId)
  $('slide').classList.add('dragging')
}
$('slide-thumb').onpointermove = (event) => {
  if (dragFrom !== null) setSlide(Math.min(1, Math.max(0, (event.clientX - dragFrom) / travel())))
}
$('slide-thumb').onpointerup = $('slide-thumb').onpointercancel = () => {
  if (dragFrom === null) return
  dragFrom = null
  $('slide').classList.remove('dragging')
  if (progress >= UNLOCK_AT) login()
  else setSlide(0)
}
$('slide-thumb').onkeydown = (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); login() }
}

async function login() {
  if (checking) return
  const typed = $('password').value
  if (!typed && !api.hasPassword()) {
    $('password').focus()
    return shake($('slide'))
  }
  checking = true
  setSlide(1)
  $('slide').classList.add('checking')
  try {
    unlock(await api.login(typed))
  } catch (error) {
    askPassword(error.message === 'wrong password' ? 'Enter password' : 'No connection, try again')
    shake($('slide'))
    $('password').focus()
  } finally {
    checking = false
    $('slide').classList.remove('checking')
  }
}

function unlock(saved) {
  useSettings(saved)
  browse = Math.max(0, NAMES.indexOf(settings.pattern))
  knobAngle = ANGLES[browse]
  render()
  swap(() => {
    $('lock').hidden = true
    $('app').hidden = false
    $('app').classList.remove('enter')
    void $('app').offsetWidth
    $('app').classList.add('enter')
  })
  askPassword()
  sync()
  checkPico()
}

let draft = {}

function showDraft() {
  for (const tile of $('tiles').children) {
    const key = tile.dataset.setting
    const { choices, text } = STEPPERS[key]
    const at = choices.indexOf(draft[key])
    tile.querySelector('output').textContent = text(draft[key])
    tile.querySelector('[data-step="-1"]').disabled = at <= 0
    tile.querySelector('[data-step="1"]').disabled = at >= choices.length - 1
  }
}

function step(key, by) {
  const { choices } = STEPPERS[key]
  let at = choices.indexOf(draft[key])
  if (at < 0) at = choices.findIndex((c) => c >= draft[key])
  at = Math.min(choices.length - 1, Math.max(0, at + by))
  draft[key] = choices[at]
  showDraft()
}

function showSettings(open) {
  if (!open) return $('settings').close()
  draft = { ...settings }
  $('set-ics').value = settings.ics_url
  $('settings-error').textContent = ''
  showDraft()
  $('settings').showModal()
}

async function saveSettings(event) {
  event.preventDefault()
  $('settings-save').disabled = true
  try {
    await putSettings({ ...draft, ics_url: $('set-ics').value.trim() })
    showSettings(false)
    if (settings.ics_url) sync()
  } catch (error) {
    if (error.message === 'wrong password') return showLock()
    $('settings-error').textContent = error.message === 'no connection' ? 'No connection, try again' : error.message
    shake($('settings-save'), 'nudge')
  } finally {
    $('settings-save').disabled = false
  }
}

function logOut() {
  api.logOut()
  try { localStorage.removeItem(MANUAL_KEY) } catch {}
  location.reload()
}

async function checkPico() {
  try {
    setPico(await api.picoOnline())
  } catch (error) {
    if (error.message === 'wrong password') showLock()
    else setPico(null)
  }
}

function setPico(online) {
  picoOnline = online
  const state = online === null ? 'unknown' : online ? 'online' : 'offline'
  $('pico').dataset.state = state
  $('app').dataset.pico = state
  $('pico-text').textContent = online ? 'Pico online' : 'Pico offline'
}

function showLock() {
  endPreview()
  askPassword()
  swap(() => {
    $('app').hidden = true
    $('lock').hidden = false
    if ($('settings').open) $('settings').close()
  })
}

$('knob-labels').replaceChildren(...NAMES.map((name, index) => {
  const label = document.createElement('button')
  label.className = 'knob-label'
  label.dataset.type = name
  label.textContent = title(name)
  label.style.setProperty('--a', ANGLES[index] + 'deg')
  label.onclick = () => browseTo(index)
  return label
}))

$('tiles').innerHTML = Object.entries(STEPPERS).map(([key, { name, hint }]) => `
  <div class="tile" data-setting="${key}">
    <p class="tile-text"><span class="tile-name">${name}</span><span class="tile-hint">${hint}</span></p>
    <div class="stepper">
      <button type="button" class="tile-key" data-step="-1" aria-label="${name}: less">
        <svg class="icon" viewBox="0 0 24 24"><path d="M6 12h12"/></svg>
      </button>
      <output class="tile-value"></output>
      <button type="button" class="tile-key" data-step="1" aria-label="${name}: more">
        <svg class="icon" viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg>
      </button>
    </div>
  </div>`).join('')

if (manualTime > now()) $('custom-input').value = toInputValue(manualTime)
else resetPicker()
$('custom-input').onchange = setCustom
$('custom-input').onclick = () => { try { $('custom-input').showPicker() } catch {} }
$('custom-clear').onclick = clearCustom
$('open-settings').onclick = () => showSettings(true)
$('settings-close').onclick = () => showSettings(false)
$('settings-form').onsubmit = saveSettings
$('settings-form').onclick = (event) => {
  const key = event.target.closest('[data-step]')
  if (key) step(key.closest('.tile').dataset.setting, Number(key.dataset.step))
}
$('logout').onclick = logOut
$('knob-cap').onclick = chooseType
$('try').onclick = tryType
$('stop').onclick = stop
$('sync').onclick = sync
$('lock').onsubmit = (event) => { event.preventDefault(); login() }
setInterval(() => { if (!$('app').hidden) render() }, TICK_MS)
setInterval(() => { if (!$('app').hidden && !document.hidden) checkPico() }, PICO_CHECK_MS)
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('app').hidden) checkPico() })

if (api.hasPassword()) login()
else $('password').focus()

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')
