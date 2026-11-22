// The only code that talks to the network: the server's /api (api/index.py), which
// passes commands on to the Pico. The site holds no secrets. The shared password is typed once;
// this device remembers it and sends it with every call, and the server checks it.
const PASSWORD_KEY = 'shakeawake-password'   // where this device remembers the password

// localStorage can be blocked (e.g. private browsing); then the password lasts until reload.
let password = ''
try { password = localStorage.getItem(PASSWORD_KEY) || '' } catch {}
// Older versions remembered the broker password on this device. It isn't used any more.
try { localStorage.removeItem('shakeawake-mqtt-password') } catch {}

export const hasPassword = () => password !== ''

function forgetPassword() {
  password = ''
  try { localStorage.removeItem(PASSWORD_KEY) } catch {}
}

// Calls the server. Returns its reply, or throws an Error whose message suits the page:
// "wrong password" (and forgets it), "no connection", or the server's own reason.
async function api(method, path, body) {
  let response
  try {
    response = await fetch('/api/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + password, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new Error('no connection')
  }
  const data = await response.json().catch(() => ({}))
  if (response.status === 401) {
    forgetPassword()
    throw new Error('wrong password')
  }
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'error ' + response.status)
  return data
}

// Checks a typed password (or the remembered one, if blank) and remembers it if it works.
export async function login(typed) {
  if (typed) password = typed
  await api('GET', 'health')
  try { localStorage.setItem(PASSWORD_KEY, password) } catch {}
}

// Reads the calendar and sends its alarms to the Pico. Returns [[UTC seconds, type], ...].
export const sync = async () => (await api('POST', 'sync')).alarms
export const setAlarm = (time, pattern) => api('PUT', 'alarm', { time, pattern })
export const clearAlarm = () => api('DELETE', 'alarm')
export const setType = (pattern) => api('PUT', 'type', { pattern })   // the type every alarm plays
export const test = (pattern, seconds) => api('POST', 'test', { pattern, seconds })
export const stop = () => api('POST', 'stop')
export const picoOnline = async () => (await api('GET', 'status')).online   // is it connected to the broker?
export const getSettings = () => api('GET', 'settings')
export const saveSettings = (settings) => api('PUT', 'settings', settings)
export const logOut = forgetPassword   // this device forgets the password
