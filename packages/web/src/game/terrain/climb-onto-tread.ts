/**
 * 「當單車撞到裙邊之後,應該就要自動爬升到裙邊的平面部分」—— 使用者的原話,
 * 這支就是那件事。
 *
 * 地面查詢只回答**一個點**(車軸)的高度。地形是台階,踏面是這個世界的 `gridSize`
 * (24–32 m),所以在每一道豎邊前的最後 1.6 m,車軸還在下一階的踏面上,車頭已經
 * 插進上一階的板子裡。把車頭也問一次、騎兩者較高的那一階,換來的是車尾短暫地
 * 懸在階緣外 —— 那正是單車跳上路緣的樣子,是這筆交易比較好的那一半。
 *
 * ## 上限,以及它治不到什麼
 *
 * 爬升上限 1.5 階,因為「一道台階」跟「上一個之字彎的路面」是同一個查詢。沒有它,
 * 髮夾彎會把騎士直接傳送到上面那條路。
 *
 * 2026-07-29 上午:走廊折疊的根因修掉之後(見 `terrain-chunk.ts` 的
 * `buildMedialAxisMask`)重新量過,結論是留著,但只值 18–24 %。
 *
 * ## 2026-07-29 下午:路改成走在一格的正中央之後,它變成**主力**
 *
 * 走廊的欄數改成偶數(`terrain-chunk.ts` 的 `crossCount`),路不再壓在兩格的共用
 * 邊上,橫向那道落差整個消失。剩下的穿模因此幾乎**全部**是沿路的台階 —— 也就是
 * 這支的守備範圍。實測(`scripts/headless-check/clip-probe.ts`,真的 DEM + MVT,
 * 下坡 45 km/h;「只有長度」= 車頭/車尾 ±1.6 m 不偏移的那台一維車):
 *
 *   路線          世界      插進地表   其中只有長度   開 CLIMB   少掉
 *   台北山頂      paper       2.39 %      2.13 %       1.33 %     44 %
 *                 plastic     5.02 %      4.25 %       2.84 %     43 %
 *                 circuit     1.39 %      1.13 %       0.52 %     63 %
 *   Alpe d'Huez   paper       3.79 %      3.79 %       2.13 %     44 %
 *                 plastic     4.67 %      4.57 %       0.93 %     80 %
 *                 circuit     2.07 %      2.02 %       0.04 %     98 %
 *   Amalfi SS163  paper       4.02 %      3.92 %       3.46 %     14 %
 *                 plastic     5.93 %      5.75 %       4.81 %     19 %
 *                 circuit     3.40 %      3.35 %       2.43 %     29 %
 *
 * 對照:同樣三條路線、同樣三個世界,**改欄數之前**開 CLIMB 只少掉 0.3–25 %
 * (山路那兩條是 0.3–2 %),因為那時候壓倒性的穿模來源是橫向那道落差,而這支
 * 只問車頭 —— 它從來就不在橫向那條路徑上。所以結論不是「還留著」而是「現在才
 * 真的用得上」。
 *
 * 治不到的殘量(Amalfi 那一列最明顯)是**超過 1.5 階**的台階:那條路 300 m 內
 * 落差 25 %,一格 32 m 就是 8 m,paper 的階高 3.2 m —— 一道真的兩階半的坎。爬
 * 上去就等於把騎士傳送到上一段路,所以上限不動。
 */

/**
 * 車頭伸出去多遠。單車擺飾是 7 m 長的模型 × `BIKE_SCALE` 0.45 ≈ 3.2 m,半長 1.6。
 */
export const BIKE_NOSE_REACH = 1.6;

/**
 * 爬升上限,以階高計。1.5 階是「一道台階」與「上一個之字彎的路面」的分界。
 */
export const CLIMB_LIMIT_LAYERS = 1.5;

/**
 * 車頭那一點的世界座標。`bearingDeg` 是羅盤方位(0 = 北 = −z,90 = 東 = +x),
 * 跟 `computeSmoothedBearing` 同一套。
 */
export function noseProbePoint(
  x: number, z: number, bearingDeg: number,
): { x: number; z: number } {
  const rad = (bearingDeg * Math.PI) / 180;
  return {
    x: x + Math.sin(rad) * BIKE_NOSE_REACH,
    z: z - Math.cos(rad) * BIKE_NOSE_REACH,
  };
}

/**
 * 車軸在 `axleY`、車頭那一點的地面是 `noseY` 時,騎士該騎在多高。
 *
 * `Math.max` 的語意:**只在往上時作用**。下坡時車頭在比較低的踏面上,車輪仍然
 * 留在車軸這一階上直到車軸越界,跟沒有這支時完全一樣。
 */
export function climbOntoTread(
  axleY: number, noseY: number | null, layerHeight: number,
): number {
  if (noseY === null || !(layerHeight > 0)) return axleY;
  if (noseY <= axleY) return axleY;
  return noseY - axleY <= layerHeight * CLIMB_LIMIT_LAYERS ? noseY : axleY;
}
