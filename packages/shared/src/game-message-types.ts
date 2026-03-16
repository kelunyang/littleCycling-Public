/**
 * Game message type definitions and base templates.
 * Each event type has a base template with {placeholder} variables.
 * Variants (generated via LLM) are stored in SQLite and override the base template at runtime.
 */

export interface GameMessageType {
  id: string;
  baseTemplate: string;
  icon: string;
  color: string;
  priority: number;
  durationMs: number;
  placeholders: string[];
}

export const GAME_MESSAGE_TYPES: Record<string, GameMessageType> = {
  'zone-change':        { id: 'zone-change',        baseTemplate: '進入 Zone {zone}',              icon: 'heart-pulse',              color: 'var(--hud-cyan)',    priority: 2, durationMs: 3000, placeholders: ['zone'] },
  'zone5-warning':      { id: 'zone5-warning',      baseTemplate: 'Zone 5 — 小心!',                icon: 'triangle-exclamation',     color: 'var(--hud-magenta)', priority: 4, durationMs: 4000, placeholders: [] },
  'coin-collect':       { id: 'coin-collect',       baseTemplate: '金幣 +{amount}',                icon: 'coins',                    color: 'var(--hud-yellow)',  priority: 1, durationMs: 2000, placeholders: ['amount'] },
  'combo-up':           { id: 'combo-up',           baseTemplate: 'Combo ×{level}',                icon: 'fire',                     color: 'var(--hud-yellow)',  priority: 3, durationMs: 2500, placeholders: ['level'] },
  'segment-change':     { id: 'segment-change',     baseTemplate: '進入區間: {name}',               icon: 'flag-checkered',           color: 'var(--hud-cyan)',    priority: 3, durationMs: 3500, placeholders: ['name'] },
  'lap-complete':       { id: 'lap-complete',       baseTemplate: '完成一圈!',                      icon: 'trophy',                   color: 'var(--hud-yellow)',  priority: 4, durationMs: 4000, placeholders: [] },
  'weather-change':     { id: 'weather-change',     baseTemplate: '{description}',                 icon: 'cloud',                    color: 'var(--hud-cyan)',    priority: 2, durationMs: 3000, placeholders: ['description'] },
  'distance-milestone': { id: 'distance-milestone', baseTemplate: '已騎 {km} km!',                 icon: 'road',                     color: 'var(--hud-cyan)',    priority: 2, durationMs: 3000, placeholders: ['km'] },
  'speed-record':       { id: 'speed-record',       baseTemplate: '最高速 {speed} km/h!',          icon: 'gauge-high',               color: 'var(--hud-cyan)',    priority: 3, durationMs: 3000, placeholders: ['speed'] },
  'power-record':       { id: 'power-record',       baseTemplate: '最高功率 {power} W!',           icon: 'bolt',                     color: 'var(--hud-cyan)',    priority: 3, durationMs: 3000, placeholders: ['power'] },
  'on-target':          { id: 'on-target',          baseTemplate: '穩定輸出中!',                    icon: 'thumbs-up',                color: 'var(--hud-cyan)',    priority: 2, durationMs: 3000, placeholders: [] },
  'zone1-idle':         { id: 'zone1-idle',         baseTemplate: '該加速囉!',                      icon: 'person-running',           color: 'var(--hud-cyan)',    priority: 2, durationMs: 3000, placeholders: [] },
  'high-hr-warning':    { id: 'high-hr-warning',    baseTemplate: '心率偏高，注意恢復',              icon: 'heart-circle-exclamation', color: 'var(--hud-magenta)', priority: 3, durationMs: 4000, placeholders: [] },
  'game-start':         { id: 'game-start',         baseTemplate: '出發!',                          icon: 'flag',                     color: 'var(--hud-cyan)',    priority: 5, durationMs: 3000, placeholders: [] },
  'game-end':           { id: 'game-end',           baseTemplate: '辛苦了!',                        icon: 'medal',                    color: 'var(--hud-yellow)',  priority: 5, durationMs: 3000, placeholders: [] },
  'terrain-ready':      { id: 'terrain-ready',      baseTemplate: '地形就緒',                       icon: 'mountain',                 color: 'var(--hud-cyan)',    priority: 2, durationMs: 2500, placeholders: [] },
  'mvt-failed':         { id: 'mvt-failed',         baseTemplate: '地圖資料取得失敗，使用預設地形',    icon: 'triangle-exclamation',     color: 'var(--hud-yellow)',  priority: 3, durationMs: 4000, placeholders: [] },

  // ── Random event messages (3 per event × 10 events = 30) ──

  // Headwind
  'event-headwind-start':   { id: 'event-headwind-start',   baseTemplate: '逆風來襲！維持 {watts}W 撐過 {seconds} 秒！',       icon: 'wind',                 color: 'var(--hud-cyan)',    priority: 5, durationMs: 4000, placeholders: ['watts', 'seconds'] },
  'event-headwind-success': { id: 'event-headwind-success', baseTemplate: '成功突破逆風！+{coins} 金幣',                       icon: 'trophy',               color: 'var(--hud-yellow)',  priority: 4, durationMs: 3000, placeholders: ['coins'] },
  'event-headwind-fail':    { id: 'event-headwind-fail',    baseTemplate: '被風吹倒了…下次加油！',                              icon: 'face-sad-tear',        color: 'var(--hud-magenta)', priority: 3, durationMs: 3000, placeholders: [] },

  // Flat tire
  'event-flat-tire-start':   { id: 'event-flat-tire-start',   baseTemplate: '爆胎了！保持 {cadence} rpm 踩踏 {seconds} 秒修好它！', icon: 'circle-xmark',      color: 'var(--hud-cyan)',    priority: 5, durationMs: 4000, placeholders: ['cadence', 'seconds'] },
  'event-flat-tire-success': { id: 'event-flat-tire-success', baseTemplate: '輪胎修好了！+{coins} 金幣',                           icon: 'trophy',            color: 'var(--hud-yellow)',  priority: 4, durationMs: 3000, placeholders: ['coins'] },
  'event-flat-tire-fail':    { id: 'event-flat-tire-fail',    baseTemplate: '修胎失敗…只好慢慢騎',                                  icon: 'face-sad-tear',     color: 'var(--hud-magenta)', priority: 3, durationMs: 3000, placeholders: [] },

  // Heavy rain
  'event-heavy-rain-start':   { id: 'event-heavy-rain-start',   baseTemplate: '傾盆大雨！穩住 {watts}W 騎完 {seconds} 秒！',    icon: 'cloud-showers-heavy', color: 'var(--hud-cyan)',    priority: 5, durationMs: 4000, placeholders: ['watts', 'seconds'] },
  'event-heavy-rain-success': { id: 'event-heavy-rain-success', baseTemplate: '雨過天晴！+{coins} 金幣',                        icon: 'trophy',              color: 'var(--hud-yellow)',  priority: 4, durationMs: 3000, placeholders: ['coins'] },
  'event-heavy-rain-fail':    { id: 'event-heavy-rain-fail',    baseTemplate: '被大雨淋濕了…體力下降',                            icon: 'face-sad-tear',       color: 'var(--hud-magenta)', priority: 3, durationMs: 3000, placeholders: [] },

  // Treasure chest
  'event-treasure-chest-start':   { id: 'event-treasure-chest-start',   baseTemplate: '發現寶箱！衝刺 {watts}W 搶奪 {seconds} 秒！', icon: 'gem',          color: 'var(--hud-yellow)',  priority: 5, durationMs: 4000, placeholders: ['watts', 'seconds'] },
  'event-treasure-chest-success': { id: 'event-treasure-chest-success', baseTemplate: '寶箱到手！+{coins} 金幣',                     icon: 'trophy',       color: 'var(--hud-yellow)',  priority: 4, durationMs: 3000, placeholders: ['coins'] },
  'event-treasure-chest-fail':    { id: 'event-treasure-chest-fail',    baseTemplate: '寶箱消失了…手腳太慢',                          icon: 'face-sad-tear', color: 'var(--hud-magenta)', priority: 3, durationMs: 3000, placeholders: [] },

  // Police chase
  'event-police-chase-start':   { id: 'event-police-chase-start',   baseTemplate: '警車來了！加速到 {watts}W 逃跑 {seconds} 秒！', icon: 'car-side',      color: 'var(--hud-magenta)', priority: 5, durationMs: 4000, placeholders: ['watts', 'seconds'] },
  'event-police-chase-success': { id: 'event-police-chase-success', baseTemplate: '成功甩掉警車！+{coins} 金幣',                   icon: 'trophy',        color: 'var(--hud-yellow)',  priority: 4, durationMs: 3000, placeholders: ['coins'] },
  'event-police-chase-fail':    { id: 'event-police-chase-fail',    baseTemplate: '被警車攔下了…開罰單',                            icon: 'face-sad-tear', color: 'var(--hud-magenta)', priority: 3, durationMs: 3000, placeholders: [] },

  // Uphill surprise
  'event-uphill-surprise-start':   { id: 'event-uphill-surprise-start',   baseTemplate: '前方突然上坡！維持 {watts}W 爬坡 {seconds} 秒！', icon: 'mountain',      color: 'var(--hud-cyan)',    priority: 5, durationMs: 4000, placeholders: ['watts', 'seconds'] },
  'event-uphill-surprise-success': { id: 'event-uphill-surprise-success', baseTemplate: '成功攻頂！+{coins} 金幣',                         icon: 'trophy',        color: 'var(--hud-yellow)',  priority: 4, durationMs: 3000, placeholders: ['coins'] },
  'event-uphill-surprise-fail':    { id: 'event-uphill-surprise-fail',    baseTemplate: '爬坡失敗…下次再挑戰',                              icon: 'face-sad-tear', color: 'var(--hud-magenta)', priority: 3, durationMs: 3000, placeholders: [] },

  // Tailwind
  'event-tailwind-start':   { id: 'event-tailwind-start',   baseTemplate: '順風來了！保持 {cadence} rpm 輕鬆騎 {seconds} 秒', icon: 'feather',       color: 'var(--hud-cyan)',    priority: 5, durationMs: 4000, placeholders: ['cadence', 'seconds'] },
  'event-tailwind-success': { id: 'event-tailwind-success', baseTemplate: '順風加持成功！+{coins} 金幣',                       icon: 'trophy',        color: 'var(--hud-yellow)',  priority: 4, durationMs: 3000, placeholders: ['coins'] },
  'event-tailwind-fail':    { id: 'event-tailwind-fail',    baseTemplate: '沒跟上順風的節奏…',                                 icon: 'face-sad-tear', color: 'var(--hud-magenta)', priority: 3, durationMs: 3000, placeholders: [] },

  // Night tunnel
  'event-night-tunnel-start':   { id: 'event-night-tunnel-start',   baseTemplate: '進入隧道！穩住 {watts}W 撐過 {seconds} 秒！', icon: 'moon',          color: 'var(--hud-cyan)',    priority: 5, durationMs: 4000, placeholders: ['watts', 'seconds'] },
  'event-night-tunnel-success': { id: 'event-night-tunnel-success', baseTemplate: '安全穿過隧道！+{coins} 金幣',                  icon: 'trophy',        color: 'var(--hud-yellow)',  priority: 4, durationMs: 3000, placeholders: ['coins'] },
  'event-night-tunnel-fail':    { id: 'event-night-tunnel-fail',    baseTemplate: '在隧道裡迷路了…',                               icon: 'face-sad-tear', color: 'var(--hud-magenta)', priority: 3, durationMs: 3000, placeholders: [] },

  // Construction
  'event-construction-start':   { id: 'event-construction-start',   baseTemplate: '前方施工！穩住 {watts}W 通過工地 {seconds} 秒！', icon: 'triangle-exclamation', color: 'var(--hud-yellow)',  priority: 5, durationMs: 4000, placeholders: ['watts', 'seconds'] },
  'event-construction-success': { id: 'event-construction-success', baseTemplate: '安全通過施工區！+{coins} 金幣',                   icon: 'trophy',               color: 'var(--hud-yellow)',  priority: 4, durationMs: 3000, placeholders: ['coins'] },
  'event-construction-fail':    { id: 'event-construction-fail',    baseTemplate: '在工地摔車了…下次小心',                            icon: 'face-sad-tear',        color: 'var(--hud-magenta)', priority: 3, durationMs: 3000, placeholders: [] },

  // Rest stop
  'event-rest-stop-start':   { id: 'event-rest-stop-start',   baseTemplate: '補給站到了！放鬆騎 {seconds} 秒恢復體力',  icon: 'mug-hot',       color: 'var(--hud-cyan)',    priority: 5, durationMs: 4000, placeholders: ['seconds'] },
  'event-rest-stop-success': { id: 'event-rest-stop-success', baseTemplate: '補給完成！+{coins} 金幣',                  icon: 'trophy',        color: 'var(--hud-yellow)',  priority: 4, durationMs: 3000, placeholders: ['coins'] },
  'event-rest-stop-fail':    { id: 'event-rest-stop-fail',    baseTemplate: '太拼了…沒好好休息',                          icon: 'face-sad-tear', color: 'var(--hud-magenta)', priority: 3, durationMs: 3000, placeholders: [] },
};

/** Replace {key} placeholders with actual values */
export function fillTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? key));
}
