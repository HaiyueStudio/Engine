export type EasingFunction = (t: number) => number;

export const Easing = {
  // Linear
  linear: (t: number) => t,

  // Quadratic
  quadIn:    (t: number) => t * t,
  quadOut:   (t: number) => t * (2 - t),
  quadInOut: (t: number) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,

  // Cubic
  cubicIn:    (t: number) => t * t * t,
  cubicOut:   (t: number) => (--t) * t * t + 1,
  cubicInOut: (t: number) =>
    t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,

  // Quartic
  quartIn:    (t: number) => t * t * t * t,
  quartOut:   (t: number) => 1 - (--t) * t * t * t,
  quartInOut: (t: number) =>
    t < 0.5 ? 8 * t * t * t * t : 1 - 8 * (--t) * t * t * t,

  // Sinusoidal
  sineIn:    (t: number) => 1 - Math.cos((t * Math.PI) / 2),
  sineOut:   (t: number) => Math.sin((t * Math.PI) / 2),
  sineInOut: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,

  // Exponential
  expoIn:    (t: number) => t === 0 ? 0 : Math.pow(2, 10 * (t - 1)),
  expoOut:   (t: number) => t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
  expoInOut: (t: number) => {
    if (t === 0 || t === 1) return t;
    return t < 0.5
      ? Math.pow(2, 20 * t - 10) / 2
      : (2 - Math.pow(2, -20 * t + 10)) / 2;
  },

  // Circular
  circIn:    (t: number) => 1 - Math.sqrt(1 - t * t),
  circOut:   (t: number) => Math.sqrt(1 - (--t) * t),
  circInOut: (t: number) =>
    t < 0.5
      ? (1 - Math.sqrt(1 - 4 * t * t)) / 2
      : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2,

  // Elastic
  elasticIn: (t: number) => {
    if (t === 0 || t === 1) return t;
    return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * ((2 * Math.PI) / 3));
  },
  elasticOut: (t: number) => {
    if (t === 0 || t === 1) return t;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
  },

  // Back
  backIn:  (t: number) => 2.70158 * t * t * t - 1.70158 * t * t,
  backOut: (t: number) => 1 + 2.70158 * (--t) * t * t + 1.70158 * t * t,

  // Bounce
  bounceOut: (t: number): number => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1)      return n1 * t * t;
    if (t < 2 / d1)      return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1)    return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
  bounceIn: (t: number): number => 1 - Easing.bounceOut(1 - t),
} as const;
