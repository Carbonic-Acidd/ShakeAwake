const A_SUNDAY = new Date(2023, 0, 1)
const SWIPE_PX = 14
const MINUTE_STEP = 5
const HOLD_DELAY_MS = 400
const REPEAT_MS = 80

const $ = (id) => document.getElementById(id)
const range = (n) => [...Array(n).keys()]
const wrap = (value, size) => ((value % size) + size) % size
const at = (day, minutes) => { const d = new Date(day); d.setHours(0, minutes, 0, 0); return d }
const addDays = (day, n) => { const d = new Date(day); d.setDate(d.getDate() + n); return d }
const today = () => at(new Date(), 0)
const sameDay = (a, b) => a.toDateString() === b.toDateString()
const timeText = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const FIELDS = { hour: $('picker-hour'), minute: $('picker-minute') }

let picked = new Date()
let shownMonth = new Date()
let onSet = null
let holdTimer = 0

function dayText(d) {
  if (sameDay(d, new Date())) return 'Today'
  if (sameDay(d, addDays(new Date(), 1))) return 'Tomorrow'
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

function parts() {
  const hours = picked.getHours()
  return { hour: hours % 12 || 12, minute: picked.getMinutes(), pm: hours >= 12 }
}

function stepped(key, value, by) {
  if (key === 'hour') return value + by
  const base = by > 0 ? Math.floor(value / MINUTE_STEP) : Math.ceil(value / MINUTE_STEP)
  return (base + by) * MINUTE_STEP
}

function setTime(change) {
  const { hour, minute, pm } = { ...parts(), ...change }
  pick(at(picked, (wrap(hour, 12) + (pm ? 12 : 0)) * 60 + wrap(minute, 60)))
}

function showMonth() {
  const first = today()
  const year = shownMonth.getFullYear()
  const index = shownMonth.getMonth()
  const days = new Date(year, index + 1, 0).getDate()
  $('picker-month').textContent = shownMonth.toLocaleDateString([], { month: 'long', year: 'numeric' })
  $('picker-prev').disabled = shownMonth <= new Date(first.getFullYear(), first.getMonth(), 1)
  $('picker-grid').innerHTML = [
    ...range(7).map((i) => `<small>${addDays(A_SUNDAY, i).toLocaleDateString([], { weekday: 'narrow' })}</small>`),
    ...range(shownMonth.getDay()).map(() => '<span></span>'),
    ...range(days).map((i) => {
      const d = new Date(year, index, i + 1)
      return `<button type="button" class="pk-date" data-date="${i + 1}" aria-pressed="${sameDay(d, picked)}"
        ${sameDay(d, first) ? 'data-today' : ''} ${d < first ? 'disabled' : ''}>${i + 1}</button>`
    }),
  ].join('')
}

function showTime() {
  const { hour, minute, pm } = parts()
  if (document.activeElement !== FIELDS.hour) FIELDS.hour.value = hour
  if (document.activeElement !== FIELDS.minute) FIELDS.minute.value = String(minute).padStart(2, '0')
  for (const button of $('picker-ampm').children) button.setAttribute('aria-pressed', button.dataset.pm === String(Number(pm)))
}

function pick(date) {
  picked = date
  $('picker-set').textContent = `Set ${dayText(picked)} ${timeText(picked)}`
  showMonth()
  showTime()
}

export function openPicker(start, set) {
  onSet = set
  shownMonth = new Date(start * 1000)
  shownMonth.setDate(1)
  pick(new Date(start * 1000))
  $('picker').showModal()
}

for (const [key, field] of Object.entries(FIELDS)) {
  let swipe = null
  field.onfocus = () => field.select()
  field.onblur = showTime
  field.oninput = () => {
    field.value = field.value.replace(/\D/g, '')
    const value = Number(field.value)
    if (key === 'hour' && value >= 1 && value <= 12) {
      setTime({ hour: value })
      if (field.value.length === 2 || value > 1) FIELDS.minute.focus()
    }
    if (key === 'minute' && field.value !== '' && value <= 59) setTime({ minute: value })
  }
  field.onkeydown = (event) => {
    const by = { ArrowUp: 1, ArrowDown: -1 }[event.key]
    if (by) { event.preventDefault(); setTime({ [key]: stepped(key, parts()[key], by) }) }
    if (event.key === 'Enter') field.blur()
  }
  field.onwheel = (event) => {
    event.preventDefault()
    setTime({ [key]: stepped(key, parts()[key], event.deltaY < 0 ? 1 : -1) })
  }
  field.onpointerdown = (event) => { swipe = { y: event.clientY, from: parts()[key], moved: false } }
  field.onpointermove = (event) => {
    if (!swipe) return
    const steps = Math.round((swipe.y - event.clientY) / SWIPE_PX)
    if (!steps && !swipe.moved) return
    if (!swipe.moved) field.setPointerCapture(event.pointerId)
    swipe.moved = true
    setTime({ [key]: stepped(key, swipe.from, steps) })
  }
  field.onpointerup = field.onpointercancel = () => {
    if (swipe?.moved) field.blur()
    swipe = null
  }
}
function step(button) {
  const { field, by } = button.dataset
  setTime({ [field]: stepped(field, parts()[field], Number(by)) })
}
function stopHold() {
  clearTimeout(holdTimer)
  clearInterval(holdTimer)
}
$('picker-time').onpointerdown = (event) => {
  const button = event.target.closest('[data-field]')
  if (!button) return
  step(button)
  holdTimer = setTimeout(() => { holdTimer = setInterval(() => step(button), REPEAT_MS) }, HOLD_DELAY_MS)
}
$('picker-time').onclick = (event) => {
  const button = event.target.closest('[data-field]')
  if (button && event.detail === 0) step(button)
}
addEventListener('pointerup', stopHold)
addEventListener('pointercancel', stopHold)
$('picker-ampm').onclick = (event) => {
  const button = event.target.closest('[data-pm]')
  if (button) setTime({ pm: button.dataset.pm === '1' })
}
$('picker-grid').onclick = (event) => {
  const button = event.target.closest('[data-date]')
  if (button) pick(at(new Date(shownMonth.getFullYear(), shownMonth.getMonth(), Number(button.dataset.date)), picked.getHours() * 60 + picked.getMinutes()))
}
$('picker-prev').onclick = () => { shownMonth.setMonth(shownMonth.getMonth() - 1); showMonth() }
$('picker-next').onclick = () => { shownMonth.setMonth(shownMonth.getMonth() + 1); showMonth() }
$('picker').onclick = (event) => {
  const box = $('picker').getBoundingClientRect()
  const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom
  if (event.target === $('picker') && outside) $('picker').close()
}
$('picker-set').onclick = async () => {
  if (await onSet(Math.floor(picked.getTime() / 1000))) $('picker').close()
}
