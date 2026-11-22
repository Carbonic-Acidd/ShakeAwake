// The page: type the password and slide to unlock (the server checks it; this device then
// remembers it and unlocks by itself next time), then one screen:
// the screen panel (next alarm, current alarm type), the knob (turn to choose a type, press its
// cap to set it), the custom alarm chip, Try and Stop.
// The server can't see the Pico or tell us anything back, so this device remembers the alarm
// type and custom alarm it set, and Sync (which resends the calendar) is how the page learns the
// calendar's alarms.
import * as api from './api.js'
import { liveWave } from './wave.js'

// Alarm types and how the trace draws them: name -> steps (start strength, end strength, ms),
// the same as pico/shaker.py except Rise's long hold is drawn short, so its climb from silence
// fills most of the screen. Keep the names and the other steps in sync with shaker.py.
const TYPES = {
  classic: [[1, 1, 300], [0, 0, 300], [1, 1, 300], [0, 0, 300], [1, 1, 1500], [0, 0, 1000]],
  waves: [[0, 1, 2000], [1, 0, 2000]],
  rise: [[0, 1, 20000], [1, 1, 8000]],      // shaker.py: 0 -> full over 20 s, then holds 70 s
  knock: [[1, 1, 120], [0, 0, 120], [1, 1, 120], [0, 0, 120], [1, 1, 120], [0, 0, 900]],
}
const TRY_TYPES = { rise: [[0, 1, 10000], [1, 1, 4000]] }   // Try plays Rise's faster climb (10 s)
const VIEWS = { knock: 'cycle', rise: 'pinned' }   // how the trace draws each type (wave.js); others scroll
const NAMES = Object.keys(TYPES)
const title = (name) => name[0].toUpperCase() + name.slice(1)   // "classic" -> "Classic"
const DEFAULT_TYPE = 'classic'
// Settings. Saved on this device and on the server (for the daily calendar check and the Pico),
// which keeps them for every device.
const SETTINGS_KEY = 'shakeawake-settings'
const DEFAULT_SETTINGS = { icsUrl: '', leadMin: 60, maxRunS: 90, trySeconds: 10 }
const DEFAULT_HOUR = 7       // the custom alarm picker opens at the next 7:00
const HEIGHTS = { preview: 1, browsing: 0.95, armed: 0.85, idle: 0.6 }   // the trace's height in each state
const DAWN_S = 8 * 3600      // the screen starts to glow this long before an alarm
const ANGLES = [-45, 45, 135, 225]   // knob positions (degrees clockwise from the top), one per type
const UNLOCK_AT = 0.85       // how far the slider must go to unlock
const TYPE_KEY = 'shakeawake-type'       // where this device remembers the alarm type it set
const MANUAL_KEY = 'shakeawake-manual'   // ... and its custom alarm
const STATUS_MS = 2500       // how long a failure message shows
const DONE_MS = 1200         // how long Sync shows its checkmark
const SHAKE_MS = 600         // matches the shake animation in style.css
const TICK_MS = 30_000       // how often the countdown refreshes
const PICO_CHECK_MS = 5_000  // how often to ask whether the Pico is online

const $ = (id) => document.getElementById(id)
const now = () => Date.now() / 1000
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
const setWave = liveWave($('wave-path'), reducedMotion)
const store = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch {} }
const recall = (key) => { try { return JSON.parse(localStorage.getItem(key)) } catch { return null } }

let alarmType = TYPES[recall(TYPE_KEY)] ? recall(TYPE_KEY) : DEFAULT_TYPE
let browse = NAMES.indexOf(alarmType)   // the type the knob points at
let knobAngle = ANGLES[browse]          // where the knob rests; grows past 360 as it's turned round
const settings = { ...DEFAULT_SETTINGS, ...recall(SETTINGS_KEY) }
const manual = { time: 0, on: false }   // the custom alarm; `on` goes false once it has passed
Object.assign(manual, recall(MANUAL_KEY))
let calendarNext = null   // [UTC seconds, type] from the last sync
let preview = null        // type name while "Try" plays
let previewTimer = 0
let statusTimer = 0

// ---------- Small helpers ----------
// `kind` is 'shake', or 'nudge' for a smaller one (style.css).
function shake(element, kind = 'shake') {
  element.classList.remove(kind)
  void element.offsetWidth   // restart the animation
  element.classList.add(kind)
  setTimeout(() => element.classList.remove(kind), SHAKE_MS)
}

function showStatus(text) {
  $('status').textContent = text
  $('status').dataset.show = ''
  clearTimeout(statusTimer)
  statusTimer = setTimeout(() => delete $('status').dataset.show, STATUS_MS)
}

// Runs an API call and returns its reply (null on failure, after showing why, or locking if the
// password stopped working). A command's reply says whether the Pico was listening, which is
// the freshest news of whether it's online.
async function run(call) {
  try {
    const reply = (await call()) || {}
    if (typeof reply.delivered === 'boolean') setPico(reply.delivered)
    return reply
  } catch (error) {
    if (error.message === 'wrong password') showLock()
    else showStatus('Not sent: ' + error.message)
    return null
  }
}

// View Transitions move the logo and open the slider into the screen.
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

// "tomorrow", "Tuesday", or "Nov 28" for later; "" for today.
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

// ---------- Drawing the screen ----------
function nextAlarm() {
  const times = []
  if (manual.on) times.push(manual.time)
  if (calendarNext && calendarNext[0] > now()) times.push(calendarNext[0])
  return times.length ? Math.min(...times) : null
}

function render() {
  if (manual.on && manual.time <= now()) {   // it has passed: back to "Set custom alarm"
    manual.on = false
    store(MANUAL_KEY, manual)
    resetPicker()
  }
  const next = nextAlarm()
  const shown = NAMES[browse]

  // The next alarm: "Next alarm (day)", the time, "Wake up in ..."
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

  // The trace plays "Try" at full height and the type on the knob a little lower; the screen
  // glows brighter (dawn) as the alarm gets closer
  const height = preview ? HEIGHTS.preview : shown !== alarmType ? HEIGHTS.browsing : next ? HEIGHTS.armed : HEIGHTS.idle
  const drawn = preview || shown
  setWave(preview ? TRY_TYPES[preview] || TYPES[preview] : TYPES[shown], height, VIEWS[drawn])
  $('wave').toggleAttribute('data-live', Boolean(preview || next))
  $('app').toggleAttribute('data-playing', Boolean(preview))
  $('try-text').textContent = preview ? 'Playing' : 'Try'
  $('app').style.setProperty('--dawn', next ? Math.min(1, Math.max(0, 1 - (next - now()) / DAWN_S)) : 0)

  // The knob and the alarm type that's set
  $('current-type').textContent = title(alarmType)
  if (!knobDrag) $('knob').style.setProperty('--angle', knobAngle + 'deg')
  $('knob').setAttribute('aria-valuenow', browse)
  $('knob').setAttribute('aria-valuetext', title(shown))
  for (const label of $('knob-labels').children) {
    label.setAttribute('aria-current', label.dataset.type === shown)
    label.toggleAttribute('data-set', label.dataset.type === alarmType)
  }
  $('deck').toggleAttribute('data-changed', shown !== alarmType)
  $('knob-cap').setAttribute('aria-label', shown === alarmType ? 'Alarm type set' : 'Set alarm type to ' + title(shown))

  $('custom').toggleAttribute('data-set', manual.on)
  $('custom-text').textContent = manual.on
    ? new Date(manual.time * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'Set custom alarm'
}

// ---------- Actions ----------
// Points the knob at another alarm type, turning it the short way round.
function browseTo(index) {
  browse = index
  knobAngle += ((ANGLES[index] - knobAngle) % 360 + 540) % 360 - 180
  render()
}
// Turns the knob one type clockwise (1) or back (-1), wrapping round.
function browseStep(step) {
  browse = (browse + step + NAMES.length) % NAMES.length
  knobAngle += 90 * step
  render()
}

// Makes the type the knob points at the one every alarm plays (calendar and custom).
async function chooseType() {
  const name = NAMES[browse]
  if (name === alarmType) return
  const before = alarmType
  alarmType = name
  store(TYPE_KEY, name)
  render()
  if (!(await run(() => api.setType(name)))) {
    alarmType = before
    store(TYPE_KEY, before)
    render()
  }
}

// Plays the type the knob points at on the shaker for a few seconds.
// It only shows as playing once the server says the Pico got it, so an offline Pico never
// looks like it was about to play.
async function tryType() {
  if (picoOnline === false || $('try').classList.contains('sending')) return refuse($('try'))
  const name = NAMES[browse]
  $('try').classList.add('sending')
  const reply = await run(() => api.test(name, settings.trySeconds))
  $('try').classList.remove('sending')
  if (!reply) return
  if (!reply.delivered) return refuse($('try'))   // nobody heard it (run() has turned the indicator red)
  preview = name
  $('app').removeAttribute('data-playing')   // restart the Try countdown bar
  void $('app').offsetWidth
  clearTimeout(previewTimer)
  previewTimer = setTimeout(endPreview, settings.trySeconds * 1000)
  render()
}

// The Pico can't hear: the key that was pressed gives a small shake and the red indicator
// flares (it doesn't move).
function refuse(key) {
  if (picoOnline !== false) return   // still sending, not refused
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

// Always sent, even when the Pico looks offline: the indicator can lag by a few seconds, and if
// the shaker is running, Stop must get through.
async function stop() {
  endPreview()
  const reply = await run(api.stop)
  if (reply && !reply.delivered) refuse($('stop'))
}

// Sends the picked time as the custom alarm (replacing the last one).
async function setCustom() {
  const time = pickedTime()
  if (time <= now()) return shake($('custom-pick'))
  const before = { ...manual }
  Object.assign(manual, { time, on: true })
  store(MANUAL_KEY, manual)
  render()
  if (!(await run(() => api.setAlarm(time, alarmType)))) {
    Object.assign(manual, before)
    store(MANUAL_KEY, manual)
    render()
  }
}

async function clearCustom() {
  manual.on = false
  store(MANUAL_KEY, manual)
  resetPicker()
  render()
  if (!(await run(api.clearAlarm))) {
    manual.on = true
    store(MANUAL_KEY, manual)
    render()
  }
}

async function sync() {
  const button = $('sync')
  if (button.dataset.state === 'busy') return
  button.dataset.state = 'busy'
  try {
    calendarNext = (await api.sync())[0] || null
    button.dataset.state = 'done'
    setTimeout(() => { button.dataset.state = '' }, DONE_MS)
    render()
  } catch (error) {
    button.dataset.state = ''
    shake(button)
    if (error.message === 'wrong password') showLock()
    else showStatus('Sync failed: ' + error.message)
  }
}

// ---------- Turning the knob (all the way round, as many turns as you like) ----------
let knobDrag = null   // { angle, last } while it's being turned
const typeAt = (angle) => (((Math.round((angle - ANGLES[0]) / 90)) % NAMES.length) + NAMES.length) % NAMES.length
const snap = (angle) => ANGLES[0] + 90 * Math.round((angle - ANGLES[0]) / 90)
function pointerAngle(event) {   // degrees clockwise from the top of the knob
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
  knobDrag.angle += ((angle - knobDrag.last + 540) % 360) - 180   // the short way round
  knobDrag.last = angle
  $('knob').style.setProperty('--angle', knobDrag.angle + 'deg')
  if (typeAt(knobDrag.angle) !== browse) {
    browse = typeAt(knobDrag.angle)
    render()
  }
}
$('knob').onpointerup = $('knob').onpointercancel = () => {
  if (!knobDrag) return
  knobAngle = snap(knobDrag.angle)   // settles on the type it points at
  knobDrag = null
  $('knob').classList.remove('dragging')
  render()
}
$('knob').onkeydown = (event) => {
  if (['ArrowRight', 'ArrowUp'].includes(event.key)) { event.preventDefault(); browseStep(1) }
  if (['ArrowLeft', 'ArrowDown'].includes(event.key)) { event.preventDefault(); browseStep(-1) }
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseType() }
}

// ---------- Password + slide to unlock (one control) ----------
let progress = 0
let dragFrom = null
let checking = false
const travel = () => $('slide').clientWidth - $('slide-thumb').offsetWidth - 2 * parseFloat(getComputedStyle($('slide')).paddingLeft)

function setSlide(value) {
  progress = value
  $('slide').style.setProperty('--progress', value)
  $('slide').style.setProperty('--x', value * travel() + 'px')
}

// Asks for the password: empties the track and shows `hint` in it. With a remembered password
// the handle stays lit, so sliding alone tries again.
function askPassword(hint = 'Enter password') {
  setSlide(0)
  $('password').value = ''
  $('password').placeholder = hint
  $('slide').toggleAttribute('data-ready', api.hasPassword())
}

$('password').oninput = () => $('slide').toggleAttribute('data-ready', $('password').value !== '' || api.hasPassword())
$('slide-thumb').onpointerdown = (event) => {
  if (checking) return
  if (!$('password').value && !api.hasPassword()) {   // nothing typed yet: point at the field instead
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
$('slide-thumb').onkeydown = (event) => {   // keyboard: Enter or Space unlocks
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); login() }
}

// Checks the typed password (or the remembered one) with the server.
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
    await api.login(typed)
    unlock()
  } catch (error) {
    askPassword(error.message === 'wrong password' ? 'Enter password' : 'No connection, try again')
    shake($('slide'))
    $('password').focus()
  } finally {
    checking = false
    $('slide').classList.remove('checking')
  }
}

function unlock() {
  render()
  swap(() => {
    $('lock').hidden = true
    $('app').hidden = false
    $('app').classList.remove('enter')
    void $('app').offsetWidth
    $('app').classList.add('enter')
  })
  askPassword()   // the password lives inside api.js (and this device's storage) from here on
  sync()
  checkPico()
  fetchSettings()
}

// ---------- Settings ----------
const minutesText = (m) => m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60}` : `${m / 60} h`
const secondsText = (s) => s < 60 || s % 60 ? `${s} s` : `${s / 60} min`

// Each tile steps through its choices with - and +.
const STEPPERS = {
  leadMin: { choices: [15, 30, 45, 60, 75, 90, 120], text: minutesText },        // before the first event
  maxRunS: { choices: [30, 60, 90, 120, 180, 300], text: secondsText },          // an alarm stops itself
  trySeconds: { choices: [5, 10, 15, 20], text: secondsText },                   // Try plays
}
let draft = {}   // the values on screen until Save

// Uses what's saved on this device, and keeps the Try bar's length in step.
function applySettings() {
  $('app').style.setProperty('--try-ms', settings.trySeconds * 1000 + 'ms')
}

// The server's copy wins (another device may have changed it), including the alarm type if it
// has one.
async function fetchSettings() {
  try {
    const saved = await api.getSettings()
    Object.assign(settings, { icsUrl: saved.ics_url, leadMin: saved.offset_min,
                              maxRunS: saved.max_run_s, trySeconds: saved.try_s })
    store(SETTINGS_KEY, settings)
    applySettings()
    if (TYPES[saved.pattern] && saved.pattern !== alarmType) {
      if (NAMES[browse] === alarmType) browseTo(NAMES.indexOf(saved.pattern))
      alarmType = saved.pattern
      store(TYPE_KEY, alarmType)
    }
    render()
  } catch {}   // offline: keep this device's copy
}

function showDraft() {
  for (const [key, { choices, text }] of Object.entries(STEPPERS)) {
    const at = choices.indexOf(draft[key])
    $('val-' + key).textContent = text(draft[key])
    $('tile-' + key).querySelector('[data-step="-1"]').disabled = at <= 0
    $('tile-' + key).querySelector('[data-step="1"]').disabled = at >= choices.length - 1
  }
}

function step(key, by) {
  const { choices } = STEPPERS[key]
  let at = choices.indexOf(draft[key])
  if (at < 0) at = choices.findIndex((c) => c >= draft[key])   // a saved value that isn't a choice
  at = Math.min(choices.length - 1, Math.max(0, at + by))
  draft[key] = choices[at]
  showDraft()
}

// Settings open in a small window over the app (Escape or the close button shuts it).
function showSettings(open) {
  if (!open) return $('settings').close()
  draft = { ...settings }
  $('set-ics').value = settings.icsUrl
  $('settings-error').textContent = ''
  showDraft()
  $('settings').showModal()
}

// Save: the server first (it checks the link), then this device, then a fresh calendar sync.
async function saveSettings(event) {
  event.preventDefault()
  const next = { ...draft, icsUrl: $('set-ics').value.trim() }
  $('settings-save').disabled = true
  try {
    const reply = await api.saveSettings({ ics_url: next.icsUrl, offset_min: next.leadMin,
                                           max_run_s: next.maxRunS, try_s: next.trySeconds, pattern: alarmType })
    if (typeof reply.delivered === 'boolean') setPico(reply.delivered)
  } catch (error) {
    if (error.message === 'wrong password') { showSettings(false); return showLock() }
    $('settings-error').textContent = error.message === 'no connection' ? 'No connection, try again' : error.message
    shake($('settings-save'), 'nudge')
    return
  } finally {
    $('settings-save').disabled = false
  }
  Object.assign(settings, next)
  store(SETTINGS_KEY, settings)
  applySettings()
  showSettings(false)
  render()
  if (settings.icsUrl) sync()
}

// Forgets the password and everything else this device saved, back to the lock screen.
function logOut() {
  api.logOut()
  for (const key of [SETTINGS_KEY, TYPE_KEY, MANUAL_KEY]) {
    try { localStorage.removeItem(key) } catch {}
  }
  location.reload()
}

// ---------- Is the Pico online? (connected to the broker right now) ----------
async function checkPico() {
  try {
    setPico(await api.picoOnline())
  } catch (error) {
    if (error.message === 'wrong password') showLock()
    else setPico(null)   // couldn't ask: hide the indicator rather than guess
  }
}
let picoOnline = null   // true, false, or null (not known yet)
function setPico(online) {
  picoOnline = online
  const state = online === null ? 'unknown' : online ? 'online' : 'offline'
  $('pico').dataset.state = state
  $('app').dataset.pico = state   // the screen and Try look different while it's offline
  $('pico-text').textContent = online ? 'Pico online' : 'Pico offline'
}

// Back to the lock screen (the password stopped working).
function showLock() {
  endPreview()
  askPassword()
  swap(() => {
    $('app').hidden = true
    $('lock').hidden = false
    if ($('settings').open) $('settings').close()
  })
}

// ---------- Start ----------
$('knob-labels').replaceChildren(...NAMES.map((name, index) => {
  const label = document.createElement('button')
  label.className = 'knob-label'
  label.dataset.type = name
  label.textContent = title(name)
  label.style.setProperty('--a', ANGLES[index] + 'deg')
  label.onclick = () => browseTo(index)
  return label
}))

if (manual.on && manual.time > now()) $('custom-input').value = toInputValue(manual.time)
else resetPicker()
$('custom-input').onchange = setCustom
$('custom-input').onclick = () => { try { $('custom-input').showPicker() } catch {} }   // desktop: open the calendar
$('custom-clear').onclick = clearCustom
$('open-settings').onclick = () => showSettings(true)
$('settings-close').onclick = () => showSettings(false)
$('settings-form').onsubmit = saveSettings
$('settings-form').onclick = (event) => {
  const key = event.target.closest('[data-step]')
  if (key) step(key.closest('.tile').dataset.setting, Number(key.dataset.step))
}
$('logout').onclick = logOut
applySettings()
$('knob-cap').onclick = chooseType
$('try').onclick = tryType
$('stop').onclick = stop
$('sync').onclick = sync
$('lock').onsubmit = (event) => { event.preventDefault(); login() }
setInterval(() => { if (!$('app').hidden) render() }, TICK_MS)
setInterval(() => { if (!$('app').hidden && !document.hidden) checkPico() }, PICO_CHECK_MS)
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('app').hidden) checkPico() })

// A remembered password unlocks by itself; otherwise wait for one to be typed.
if (api.hasPassword()) login()
else $('password').focus()

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')
