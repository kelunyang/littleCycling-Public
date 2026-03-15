/**
 * d3.js chart rendering for ride detail view.
 * Encapsulates all d3 DOM manipulation — Vue components just pass SVG refs + data.
 */

import * as d3 from 'd3';
import type { RideSample } from '@littlecycling/shared';
import { getHrZone, HR_ZONES } from '@littlecycling/shared';

// ── Cyberpunk palette ──

const COLORS = {
  hr: '#ff2d78',       // magenta
  power: '#ffe100',    // yellow
  speed: '#00e5ff',    // cyan
  cadence: '#00e676',  // green
  grid: 'rgba(255,255,255,0.06)',
  axis: 'rgba(255,255,255,0.35)',
  text: 'rgba(255,255,255,0.6)',
  bg: '#0d1117',
};

const ZONE_COLORS = [
  '#607d8b', // zone 1 — grey
  '#00e676', // zone 2 — green
  '#ffab00', // zone 3 — amber
  '#ff6d00', // zone 4 — orange
  '#ff1744', // zone 5 — red
];

// ── Helpers ──

function clearSvg(el: SVGElement) {
  d3.select(el).selectAll('*').remove();
}

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Downsample to ~maxPoints using LTTB-like approach (simple nth-point for speed). */
function downsample(samples: RideSample[], maxPoints: number): RideSample[] {
  if (samples.length <= maxPoints) return samples;
  const step = samples.length / maxPoints;
  const result: RideSample[] = [samples[0]];
  for (let i = 1; i < maxPoints - 1; i++) {
    result.push(samples[Math.round(i * step)]);
  }
  result.push(samples[samples.length - 1]);
  return result;
}

// ── Chart 1: Time Series (multi-line) ──

export function renderTimeSeriesChart(
  el: SVGElement,
  samples: RideSample[],
  width: number,
  height: number,
) {
  clearSvg(el);
  if (samples.length === 0) return;

  const data = downsample(samples, 1000);
  const margin = { top: 20, right: 55, bottom: 35, left: 55 };
  const w = width - margin.left - margin.right;
  const h = height - margin.top - margin.bottom;

  const svg = d3.select(el)
    .attr('width', width)
    .attr('height', height);

  const g = svg.append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  // X scale — elapsed time
  const xScale = d3.scaleLinear()
    .domain([0, d3.max(data, d => d.elapsedMs) ?? 0])
    .range([0, w]);

  // Left Y — HR + Power
  const hrMax = d3.max(data, d => d.hr ?? 0) ?? 200;
  const pwrMax = d3.max(data, d => d.powerW ?? 0) ?? 300;
  const yLeftMax = Math.max(hrMax, pwrMax) * 1.1;
  const yLeft = d3.scaleLinear().domain([0, yLeftMax]).range([h, 0]);

  // Right Y — Speed + Cadence
  const spdMax = d3.max(data, d => d.speedKmh ?? 0) ?? 50;
  const cadMax = d3.max(data, d => d.cadence ?? 0) ?? 120;
  const yRightMax = Math.max(spdMax, cadMax) * 1.1;
  const yRight = d3.scaleLinear().domain([0, yRightMax]).range([h, 0]);

  // Grid
  g.append('g')
    .attr('class', 'grid')
    .selectAll('line')
    .data(yLeft.ticks(5))
    .join('line')
    .attr('x1', 0).attr('x2', w)
    .attr('y1', d => yLeft(d)).attr('y2', d => yLeft(d))
    .attr('stroke', COLORS.grid);

  // Axes
  g.append('g')
    .attr('transform', `translate(0,${h})`)
    .call(d3.axisBottom(xScale).ticks(6).tickFormat(d => formatTime(d as number)))
    .call(g => g.selectAll('text').attr('fill', COLORS.text).style('font-family', 'Orbitron, sans-serif').style('font-size', '10px'))
    .call(g => g.selectAll('line, path').attr('stroke', COLORS.axis));

  g.append('g')
    .call(d3.axisLeft(yLeft).ticks(5))
    .call(g => g.selectAll('text').attr('fill', COLORS.text).style('font-family', 'Orbitron, sans-serif').style('font-size', '10px'))
    .call(g => g.selectAll('line, path').attr('stroke', COLORS.axis));

  g.append('g')
    .attr('transform', `translate(${w},0)`)
    .call(d3.axisRight(yRight).ticks(5))
    .call(g => g.selectAll('text').attr('fill', COLORS.text).style('font-family', 'Orbitron, sans-serif').style('font-size', '10px'))
    .call(g => g.selectAll('line, path').attr('stroke', COLORS.axis));

  // Line helper
  function drawLine(
    key: keyof RideSample,
    yScaleFn: d3.ScaleLinear<number, number>,
    color: string,
  ) {
    const line = d3.line<RideSample>()
      .defined(d => d[key] != null)
      .x(d => xScale(d.elapsedMs))
      .y(d => yScaleFn(d[key] as number))
      .curve(d3.curveMonotoneX);

    g.append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', color)
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.85)
      .attr('d', line);
  }

  drawLine('hr', yLeft, COLORS.hr);
  drawLine('powerW', yLeft, COLORS.power);
  drawLine('speedKmh', yRight, COLORS.speed);
  drawLine('cadence', yRight, COLORS.cadence);

  // Legend
  const legend = [
    { label: 'HR', color: COLORS.hr },
    { label: 'Power', color: COLORS.power },
    { label: 'Speed', color: COLORS.speed },
    { label: 'Cadence', color: COLORS.cadence },
  ];

  const lg = svg.append('g')
    .attr('transform', `translate(${margin.left + 10}, 12)`);

  legend.forEach((item, i) => {
    const x = i * 80;
    lg.append('line')
      .attr('x1', x).attr('x2', x + 16)
      .attr('y1', 0).attr('y2', 0)
      .attr('stroke', item.color).attr('stroke-width', 2);
    lg.append('text')
      .attr('x', x + 20).attr('y', 4)
      .attr('fill', COLORS.text)
      .style('font-family', 'Rajdhani, sans-serif')
      .style('font-size', '11px')
      .text(item.label);
  });
}

// ── Chart 2: HR Zone Distribution (horizontal bars) ──

export function renderZoneDistribution(
  el: SVGElement,
  samples: RideSample[],
  hrMax: number,
  width: number,
  height: number,
) {
  clearSvg(el);
  if (samples.length === 0 || hrMax <= 0) return;

  // Calculate time in each zone
  const zoneTimes = [0, 0, 0, 0, 0]; // zones 1-5
  let prevMs = 0;

  for (const s of samples) {
    if (s.hr == null) continue;
    const dt = s.elapsedMs - prevMs;
    prevMs = s.elapsedMs;
    if (dt <= 0 || dt > 10000) continue; // skip gaps
    const zone = getHrZone(s.hr, hrMax);
    if (zone && zone.zone >= 1 && zone.zone <= 5) {
      zoneTimes[zone.zone - 1] += dt;
    }
  }

  const totalTime = zoneTimes.reduce((a, b) => a + b, 0);
  if (totalTime === 0) return;

  const margin = { top: 10, right: 80, bottom: 10, left: 90 };
  const w = width - margin.left - margin.right;
  const h = height - margin.top - margin.bottom;

  const svg = d3.select(el)
    .attr('width', width)
    .attr('height', height);

  const g = svg.append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  const zoneNames = HR_ZONES.map(z => `Z${z.zone} ${z.name}`);
  const barHeight = Math.min(28, h / 5 - 4);

  const xScale = d3.scaleLinear().domain([0, totalTime]).range([0, w]);

  zoneTimes.forEach((time, i) => {
    const y = i * (barHeight + 6);
    const pct = ((time / totalTime) * 100).toFixed(1);

    // Bar
    g.append('rect')
      .attr('x', 0).attr('y', y)
      .attr('width', xScale(time))
      .attr('height', barHeight)
      .attr('fill', ZONE_COLORS[i])
      .attr('opacity', 0.85)
      .attr('rx', 2);

    // Zone label (left)
    g.append('text')
      .attr('x', -8).attr('y', y + barHeight / 2 + 4)
      .attr('fill', COLORS.text)
      .attr('text-anchor', 'end')
      .style('font-family', 'Rajdhani, sans-serif')
      .style('font-size', '12px')
      .text(zoneNames[i]);

    // Percentage + time (right)
    g.append('text')
      .attr('x', xScale(time) + 6).attr('y', y + barHeight / 2 + 4)
      .attr('fill', COLORS.text)
      .style('font-family', 'Orbitron, sans-serif')
      .style('font-size', '10px')
      .text(`${pct}% ${formatTime(time)}`);
  });
}

// ── Chart 3: Power Histogram ──

export function renderPowerHistogram(
  el: SVGElement,
  samples: RideSample[],
  width: number,
  height: number,
) {
  clearSvg(el);

  const powerValues = samples
    .map(s => s.powerW)
    .filter((v): v is number => v != null && v > 0);

  if (powerValues.length === 0) return;

  const margin = { top: 15, right: 20, bottom: 35, left: 50 };
  const w = width - margin.left - margin.right;
  const h = height - margin.top - margin.bottom;

  const svg = d3.select(el)
    .attr('width', width)
    .attr('height', height);

  const g = svg.append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  const maxPower = d3.max(powerValues) ?? 400;
  const binWidth = 20;
  const bins = d3.bin<number, number>()
    .domain([0, Math.ceil(maxPower / binWidth) * binWidth])
    .thresholds(d3.range(0, Math.ceil(maxPower / binWidth) * binWidth, binWidth))
    (powerValues);

  const xScale = d3.scaleLinear()
    .domain([0, Math.ceil(maxPower / binWidth) * binWidth])
    .range([0, w]);

  const yScale = d3.scaleLinear()
    .domain([0, d3.max(bins, d => d.length) ?? 1])
    .range([h, 0]);

  // Grid
  g.selectAll('.grid-line')
    .data(yScale.ticks(4))
    .join('line')
    .attr('x1', 0).attr('x2', w)
    .attr('y1', d => yScale(d)).attr('y2', d => yScale(d))
    .attr('stroke', COLORS.grid);

  // Bars
  g.selectAll('.bar')
    .data(bins)
    .join('rect')
    .attr('x', d => xScale(d.x0 ?? 0) + 1)
    .attr('y', d => yScale(d.length))
    .attr('width', d => Math.max(0, xScale(d.x1 ?? 0) - xScale(d.x0 ?? 0) - 2))
    .attr('height', d => h - yScale(d.length))
    .attr('fill', COLORS.power)
    .attr('opacity', 0.75)
    .attr('rx', 1);

  // X axis
  g.append('g')
    .attr('transform', `translate(0,${h})`)
    .call(d3.axisBottom(xScale).ticks(8))
    .call(g => g.selectAll('text').attr('fill', COLORS.text).style('font-family', 'Orbitron, sans-serif').style('font-size', '10px'))
    .call(g => g.selectAll('line, path').attr('stroke', COLORS.axis));

  // X label
  svg.append('text')
    .attr('x', margin.left + w / 2)
    .attr('y', height - 4)
    .attr('fill', COLORS.text)
    .attr('text-anchor', 'middle')
    .style('font-family', 'Rajdhani, sans-serif')
    .style('font-size', '11px')
    .text('Power (W)');

  // Y axis
  g.append('g')
    .call(d3.axisLeft(yScale).ticks(4))
    .call(g => g.selectAll('text').attr('fill', COLORS.text).style('font-family', 'Orbitron, sans-serif').style('font-size', '10px'))
    .call(g => g.selectAll('line, path').attr('stroke', COLORS.axis));
}

// ── Chart 4: Radar / Spider Chart (current vs PB) ──

export interface RadarData {
  power: number;
  speed: number;
  hrEff: number;
  cadence: number;
  zoneSustain: number;
}

const RADAR_AXES: { key: keyof RadarData; label: string }[] = [
  { key: 'power', label: 'POWER' },
  { key: 'speed', label: 'SPEED' },
  { key: 'hrEff', label: 'HR EFF' },
  { key: 'cadence', label: 'CADENCE' },
  { key: 'zoneSustain', label: 'ZONE' },
];

export function renderRadarChart(
  el: SVGElement,
  current: RadarData,
  pb: RadarData | null,
  width: number,
  height: number,
): void {
  clearSvg(el);

  const svg = d3.select(el)
    .attr('width', width)
    .attr('height', height);

  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(cx, cy) - 35;
  const numAxes = RADAR_AXES.length;
  const angleStep = (2 * Math.PI) / numAxes;

  const g = svg.append('g')
    .attr('transform', `translate(${cx},${cy})`);

  // Normalize values: each axis 0-1, using max(current, pb) as denominator
  function normalize(data: RadarData): number[] {
    return RADAR_AXES.map(({ key }) => {
      const cur = current[key];
      const best = pb ? pb[key] : 0;
      const maxVal = Math.max(cur, best);
      if (maxVal === 0) return 0;
      return data[key] / maxVal;
    });
  }

  // Get point coordinates for a given normalized value at axis index
  function getPoint(axisIdx: number, value: number): [number, number] {
    // Start from top (-π/2), go clockwise
    const angle = axisIdx * angleStep - Math.PI / 2;
    return [
      Math.cos(angle) * radius * value,
      Math.sin(angle) * radius * value,
    ];
  }

  // Draw concentric pentagon grid lines (33%, 66%, 100%)
  [0.33, 0.66, 1.0].forEach(level => {
    const points = Array.from({ length: numAxes }, (_, i) => getPoint(i, level));
    g.append('polygon')
      .attr('points', points.map(p => p.join(',')).join(' '))
      .attr('fill', 'none')
      .attr('stroke', 'rgba(255,255,255,0.06)')
      .attr('stroke-width', 1);
  });

  // Draw axis lines from center to each vertex
  for (let i = 0; i < numAxes; i++) {
    const [x, y] = getPoint(i, 1);
    g.append('line')
      .attr('x1', 0).attr('y1', 0)
      .attr('x2', x).attr('y2', y)
      .attr('stroke', 'rgba(255,255,255,0.1)')
      .attr('stroke-width', 1);
  }

  // Draw PB polygon (gold, behind current)
  if (pb) {
    const pbNorm = normalize(pb);
    const pbPoints = pbNorm.map((v, i) => getPoint(i, v));

    g.append('polygon')
      .attr('points', pbPoints.map(p => p.join(',')).join(' '))
      .attr('fill', 'rgba(255,215,0,0.15)')
      .attr('stroke', '#ffd700')
      .attr('stroke-width', 1.5);

    // PB vertex dots
    pbPoints.forEach(([x, y]) => {
      g.append('circle')
        .attr('cx', x).attr('cy', y)
        .attr('r', 4)
        .attr('fill', '#ffd700')
        .attr('opacity', 0.9);
    });
  }

  // Draw current polygon (cyan, on top)
  const curNorm = normalize(current);
  const curPoints = curNorm.map((v, i) => getPoint(i, v));

  g.append('polygon')
    .attr('points', curPoints.map(p => p.join(',')).join(' '))
    .attr('fill', 'rgba(0,229,255,0.2)')
    .attr('stroke', '#00e5ff')
    .attr('stroke-width', 2);

  // Current vertex dots
  curPoints.forEach(([x, y]) => {
    g.append('circle')
      .attr('cx', x).attr('cy', y)
      .attr('r', 4)
      .attr('fill', '#00e5ff')
      .attr('opacity', 0.9);
  });

  // Axis labels (outside the chart)
  RADAR_AXES.forEach((axis, i) => {
    const [x, y] = getPoint(i, 1.18);
    g.append('text')
      .attr('x', x).attr('y', y)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('fill', 'rgba(255,255,255,0.6)')
      .style('font-family', 'Orbitron, sans-serif')
      .style('font-size', '10px')
      .text(axis.label);
  });
}
