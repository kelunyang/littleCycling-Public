/**
 * LLM prompt template for training plan generation.
 *
 * The prompt is split into two parts:
 * 1. User-editable section (rider info + training principles) — can be customised in the UI
 * 2. System suffix (JSON format rules + output schema) — hardcoded, never shown to user
 */

// ── HR zone boundaries (standard 5-zone model) ──

function hrZoneBoundaries(hrMax: number) {
  return {
    z1: Math.round(hrMax * 0.6),
    z2: Math.round(hrMax * 0.7),
    z3: Math.round(hrMax * 0.8),
    z4: Math.round(hrMax * 0.88),
    z5: Math.round(hrMax * 0.95),
  };
}

// ── User-editable default template ──

export function buildDefaultUserPrompt(params: {
  hrMax: number;
  weeks: number;
  sessionsPerWeek: number;
  minutesPerSession: number;
  goal: string;
  notes?: string;
}): string {
  const { z1, z2, z3, z4 } = hrZoneBoundaries(params.hrMax);

  let prompt = `你是一位專業自行車訓練規劃師，精通心率區間訓練與週期化訓練理論。
請根據以下騎手資訊，規劃一份為期${params.weeks}週的室內訓練台課表。

【騎手資訊】
- 訓練空白期：約2年（期間幾乎沒有騎乘）
- 主要目標：${params.goal}
- 每次可用時間：${params.minutesPerSession}分鐘
- 訓練台類型：傳統阻力訓練台（固定阻力檔位，無坡度模擬、無智能阻力控制）
- 最大心率：${params.hrMax}bpm
- 心率區間定義（以最大心率${params.hrMax}計算）：
  - Zone 1：< ${z1}bpm
  - Zone 2：${z1}–${z2}bpm（有氧燃脂，應能輕鬆說話）
  - Zone 3：${z2}–${z3}bpm（有氧閾值）
  - Zone 4：${z3}–${z4}bpm（無氧閾值）
  - Zone 5：> ${z4}bpm（最大強度）
- 訓練頻率：每週${params.sessionsPerWeek}次，其餘為休息日

【訓練規劃原則】
- 第1-2週禁止安排任何間歇訓練，只能使用 warmup、steady、cooldown
- 第3週起才能引入間歇，強度循序漸進
- 間歇訓練的 work 段心率目標應達到 Zone 4
- 恢復段心率應回落至 Zone 2
- 每週總訓練量（分鐘）應逐週遞增，第4週可略降作為恢復週`;

  if (params.notes) {
    prompt += `\n\n【特別注意事項】\n${params.notes}`;
  }

  return prompt;
}

// ── Hardcoded system suffix (JSON rules + schema) ──

export function getSystemSuffix(): string {
  return `

【JSON 格式規則】（非常重要，違反會導致系統錯誤）
1. 每個 segment 只能代表單一連續動作，禁止將多組循環結構描述在 notes 中
2. 間歇訓練必須將 work 和 rest 交替拆成獨立 segment，type 分別為 "interval_work" 和 "interval_rest"
3. 休息日必須輸出 type 為 "rest" 的 session，segments 為空陣列
4. 所有數值必須為整數
5. 只輸出 JSON，不得有任何前言、後記或 markdown 標記
6. day 欄位使用 1-based 的連續編號（第1天=1, 第2天=2, ...），不使用星期幾名稱

【輸出 Schema】
{
  "name": "課表名稱",
  "description": "課表簡述",
  "weeks": [
    {
      "week": 1,
      "focus": "本週訓練重點",
      "sessions": [
        {
          "day": 1,
          "type": "training",
          "durationMin": 35,
          "segments": [
            {
              "type": "warmup | steady | interval_work | interval_rest | cooldown",
              "durationMin": 8,
              "hrMin": 100,
              "hrMax": 130,
              "cadenceRpm": 85,
              "notes": "簡短說明"
            }
          ]
        },
        {
          "day": 2,
          "type": "rest",
          "durationMin": 0,
          "segments": []
        }
      ]
    }
  ]
}`;
}

/**
 * Combine user prompt + system suffix into the full prompt sent to LLM.
 */
export function buildFullPrompt(userPrompt: string): string {
  return userPrompt + getSystemSuffix();
}
