const PASSWORD_KEY = 'shakeawake-password'

let password = ''
try { password = localStorage.getItem(PASSWORD_KEY) || '' } catch {}

export const hasPassword = () => password !== ''

export function logOut() {
  password = ''
  try { localStorage.removeItem(PASSWORD_KEY) } catch {}
}

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
    logOut()
    throw new Error('wrong password')
  }
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'error ' + response.status)
  return data
}

export async function login(typed) {
  if (typed) password = typed
  const settings = await api('GET', 'settings')
  try { localStorage.setItem(PASSWORD_KEY, password) } catch {}
  return settings
}

export const sync = async () => (await api('POST', 'sync')).alarms
export const setAlarm = (time, pattern) => api('PUT', 'alarm', { time, pattern })
export const clearAlarm = () => api('DELETE', 'alarm')
export const test = (pattern, seconds) => api('POST', 'test', { pattern, seconds })
export const stop = () => api('POST', 'stop')
export const picoOnline = async () => (await api('GET', 'status')).online
export const saveSettings = (settings) => api('PUT', 'settings', settings)
