/**
 * Preetham analytic daylight sky as a Phaser GameObjects.Shader.
 *
 * Port of three/addons/objects/Sky.js (Preetham 1999) for the Phaser 2D
 * renderer. The 3D Three.js shader runs on a sky-dome cube; here we run a
 * single fragment-shader pass over the sky region and reconstruct view
 * directions from screen UV under a fixed "rider faces south" assumption.
 *
 * The vertex-shader precomputations from Three.js (vBetaR/vBetaM/vSunE/
 * vSunfade) are computed in JS each time the sun moves and pushed in as
 * uniforms, so the per-pixel work matches Sky.js's fragment shader exactly.
 *
 * Visual contract: only used when weather === 'sunny'. For overcast weather
 * the Preetham model produces blown-out HDR at the horizon (same problem
 * Three.js sidesteps by hiding `Sky` for non-sunny in sky-and-fog.ts:217-219),
 * so the Phaser side hides this shader and falls back to the existing
 * gradient drawn by skyGfx.
 */

import Phaser from 'phaser';

const DEG = Math.PI / 180;

/** Preetham wavelength constants — copied from Sky.js vertex shader. */
const TOTAL_RAYLEIGH = [
  5.804542996261093e-6,
  1.3562911419845635e-5,
  3.0265902468824876e-5,
] as const;

const MIE_CONST = [
  1.8399918514433978e14,
  2.7798023919660528e14,
  4.0790479543861094e14,
] as const;

const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
const EE = 1000.0;

interface PreethamParams {
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
}

/** Sky.js sunny defaults (sky-and-fog.ts:917-922). */
const SUNNY_PARAMS: PreethamParams = {
  turbidity: 2,
  rayleigh: 1,
  mieCoefficient: 0.003,
  mieDirectionalG: 0.8,
};

const FRAG_SRC = `
precision mediump float;

uniform vec2 resolution;
uniform vec3 uSunDirection;
uniform vec3 uBetaR;
uniform vec3 uBetaM;
uniform float uSunE;
uniform float uSunfade;
uniform float uMieDirectionalG;

varying vec2 fragCoord;

const float pi = 3.141592653589793;
const vec3 up = vec3(0.0, 1.0, 0.0);
const float rayleighZenithLength = 8400.0;
const float mieZenithLength = 1250.0;
const float sunAngularDiameterCos = 0.999956676946448;
const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
const float ONE_OVER_FOURPI = 0.07957747154594767;

float rayleighPhase(float cosTheta) {
  return THREE_OVER_SIXTEENPI * (1.0 + pow(cosTheta, 2.0));
}

float hgPhase(float cosTheta, float g) {
  float g2 = pow(g, 2.0);
  float inverse = 1.0 / pow(1.0 - 2.0 * g * cosTheta + g2, 1.5);
  return ONE_OVER_FOURPI * ((1.0 - g2) * inverse);
}

void main() {
  // Phaser fragCoord origin is top-left within the shader's quad. We want
  // v=0 at horizon (bottom of sky band) and v=1 at zenith (top), so flip Y.
  vec2 uv = fragCoord / resolution;
  float v = 1.0 - uv.y;
  // Pad u slightly so the sun never sits exactly on a screen edge — gives
  // the horizon halo a chance to blend into both sides.
  float u = uv.x;

  // Reconstruct a view ray under a "rider faces south" assumption (matches
  // moon mapping in phaser-weather.drawMoon). Screen left = east, screen
  // right = west; this is northern-hemisphere correct.
  float elev = v * (pi * 0.5);                 // 0..π/2
  float ewAngle = (0.5 - u) * pi;              // π/2 (looking east) .. -π/2 (looking west)
  vec3 direction = vec3(
    cos(elev) * sin(ewAngle),
    sin(elev),
    -cos(elev) * cos(ewAngle)
  );

  // ── Preetham fragment math (verbatim from three/addons/objects/Sky.js) ──

  float zenithAngle = acos(max(0.0, dot(up, direction)));
  float inverse = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));
  float sR = rayleighZenithLength * inverse;
  float sM = mieZenithLength * inverse;

  vec3 Fex = exp(-(uBetaR * sR + uBetaM * sM));

  float cosTheta = dot(direction, uSunDirection);

  float rPhase = rayleighPhase(cosTheta * 0.5 + 0.5);
  vec3 betaRTheta = uBetaR * rPhase;

  float mPhase = hgPhase(cosTheta, uMieDirectionalG);
  vec3 betaMTheta = uBetaM * mPhase;

  vec3 Lin = pow(uSunE * ((betaRTheta + betaMTheta) / (uBetaR + uBetaM)) * (1.0 - Fex), vec3(1.5));
  Lin *= mix(
    vec3(1.0),
    pow(uSunE * ((betaRTheta + betaMTheta) / (uBetaR + uBetaM)) * Fex, vec3(0.5)),
    clamp(pow(1.0 - dot(up, uSunDirection), 5.0), 0.0, 1.0)
  );

  vec3 L0 = vec3(0.1) * Fex;
  float sundisk = smoothstep(sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, cosTheta);
  L0 += (uSunE * 19000.0 * Fex) * sundisk;

  vec3 texColor = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);

  // Reinhard-ish tone curve from Sky.js
  vec3 retColor = pow(texColor, vec3(1.0 / (1.2 + (1.2 * uSunfade))));

  gl_FragColor = vec4(retColor, 1.0);
}
`;

export class PreethamSky {
  private scene: Phaser.Scene;
  private shaderObj: Phaser.GameObjects.Shader;
  private params: PreethamParams = { ...SUNNY_PARAMS };

  constructor(scene: Phaser.Scene, w: number, skyH: number) {
    this.scene = scene;

    const baseShader = new Phaser.Display.BaseShader(
      '__preetham_sky__',
      FRAG_SRC,
      undefined,
      {
        uSunDirection: { type: '3f', value: [0, 1, 0] },
        uBetaR:        { type: '3f', value: [0, 0, 0] },
        uBetaM:        { type: '3f', value: [0, 0, 0] },
        uSunE:         { type: '1f', value: 0 },
        uSunfade:      { type: '1f', value: 0 },
        uMieDirectionalG: { type: '1f', value: SUNNY_PARAMS.mieDirectionalG },
      },
    );

    this.shaderObj = scene.add.shader(baseShader, w / 2, skyH / 2, w, skyH);
    this.shaderObj.setScrollFactor(0);
    // Above skyGfx (-100) so it covers the gradient when active; below stars
    // (-98) and parallax mountains (-90) so foreground silhouettes still show.
    this.shaderObj.setDepth(-99);
    this.shaderObj.setVisible(false);
  }

  /**
   * Push sun state into the shader. Inputs match the Three.js convention
   * (azimuth in compass degrees, elevation above horizon).
   */
  setSun(sunElevationDeg: number, sunAzimuthDeg: number): void {
    const phi = DEG * (90 - sunElevationDeg);
    const theta = DEG * sunAzimuthDeg;
    // Three.js Vector3.setFromSphericalCoords(1, phi, theta).
    const sx = Math.sin(phi) * Math.sin(theta);
    const sy = Math.cos(phi);
    const sz = Math.sin(phi) * Math.cos(theta);

    // dot(sunDir, up=(0,1,0)) is just sy.
    const sunE = sunIntensity(sy);

    // sunfade — Sky.js uses sunPosition.y / 450000, where sunPosition is the
    // raw input (not normalized). With our unit-length sunDir, sunPosition.y
    // equals sy directly, but Sky.js feeds in a much larger magnitude vector
    // (the actual sky-dome distance scaled in setScalar), so the / 450000
    // ends up tiny. Replicate the spirit: clamp by elevation so high noon
    // gets a softer gamma than horizon.
    const sunfade = 1 - clamp(1 - Math.exp(sy / 450000), 0, 1);

    const rayleighCoefficient = this.params.rayleigh - 1 * (1 - sunfade);
    const betaR = TOTAL_RAYLEIGH.map((r) => r * rayleighCoefficient) as [number, number, number];

    const mieAmount = (0.2 * this.params.turbidity) * 10e-18;
    const betaM = MIE_CONST.map((m) => 0.434 * mieAmount * m * this.params.mieCoefficient) as [number, number, number];

    this.shaderObj.setUniform('uSunDirection.value', [sx, sy, sz]);
    this.shaderObj.setUniform('uBetaR.value', betaR);
    this.shaderObj.setUniform('uBetaM.value', betaM);
    this.shaderObj.setUniform('uSunE.value', sunE);
    this.shaderObj.setUniform('uSunfade.value', sunfade);
    this.shaderObj.setUniform('uMieDirectionalG.value', this.params.mieDirectionalG);
  }

  setVisible(v: boolean): void {
    this.shaderObj.setVisible(v);
  }

  /** Resize follows the parent scene; called from PhaserWeatherSystem.onResize. */
  onResize(w: number, skyH: number): void {
    this.shaderObj.setSize(w, skyH);
    // ComputedSize.setSize 不會重算 display origin(建構子是 setSize 後另外
    // setOrigin(0.5) 才算出來的),不補這行 quad 會保留舊尺寸的偏移,
    // resize 後整片天空位移、只剩一角留在畫面左上(PiP 黑塊 bug)。
    this.shaderObj.updateDisplayOrigin();
    this.shaderObj.setPosition(w / 2, skyH / 2);
  }

  destroy(): void {
    this.shaderObj.destroy();
  }
}

function sunIntensity(zenithAngleCos: number): number {
  const c = clamp(zenithAngleCos, -1, 1);
  return EE * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(c)) / STEEPNESS)));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
