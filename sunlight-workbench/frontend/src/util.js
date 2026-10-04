/* 坐标映射：模型 ENU(x=东, y=北, z=上) → three.js(x, y=上, z)。
   (x,y,z)_model → (x, z, -y)_three 是行列式为 +1 的旋转，手性不变。 */
export const toThree = ([x, y, z]) => [x, z, -y]

export const STATUS_COLOR = {
  sunlit: '#f6c453',
  shaded: '#4a6fa5',
  night: '#666',
}

export function fmtMin(m) {
  const h = Math.floor(m / 60)
  const r = m % 60
  return h ? `${h}h${r ? `${r}m` : ''}` : `${r}m`
}

/* 带符号分钟差（B−A）；null/undefined = 缺项，绝不当 0 */
export function fmtSignedMin(m) {
  if (m === null || m === undefined) return '—'
  const sign = m > 0 ? '+' : m < 0 ? '−' : ''
  return sign + fmtMin(Math.abs(m))
}

export function fmtTime(iso) {
  return iso.slice(11, 16)
}
