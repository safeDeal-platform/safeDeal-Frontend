export const ORGANIZATION = 'safeDeal-platform'
export const FRONTEND = 'safeDeal-Frontend'

export function validRepository(name) {
  return typeof name === 'string' && /^[a-z\d_.-]{1,100}$/i.test(name) && name !== '.' && name !== '..'
}

export function allowedTarget(base, defaultBranch, frontend) {
  return base === 'dev' || (!frontend && typeof defaultBranch === 'string' && base === defaultBranch)
}
