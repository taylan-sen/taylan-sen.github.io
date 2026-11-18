// Squat counting algorithms.
//
// Both counters read MediaPipe pose landmarks: 33 body points, each with
// x and y from 0 to 1 (fractions of the frame width and height) and a
// visibility score from 0 to 1.
//
// They work the same way: measure one number every frame, then feed it
// to a two-state machine (UP / DOWN). Going DOWN and coming back UP use
// different thresholds, so a measurement wobbling around one threshold
// can't count extra reps. A rep counts when the person comes back UP.
//
// This file has no page or camera code, so the self-tests can run it
// anywhere (browser or Node).

// Landmark numbers from MediaPipe's pose model.
export const LANDMARK = {
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28
};

// Points MediaPipe is less sure about than this are ignored.
export const MIN_VISIBILITY = 0.5;

export function isVisible(point) {
  return Boolean(point) && (point.visibility ?? 1) >= MIN_VISIBILITY;
}

// Landmarks are fractions of the frame. Convert to pixels so angles and
// distances aren't stretched by the frame's shape (e.g. 16:9).
export function toPixels(point, frame) {
  return { x: point.x * frame.width, y: point.y * frame.height };
}

export function distance(a, b, frame) {
  const A = toPixels(a, frame);
  const B = toPixels(b, frame);
  return Math.hypot(A.x - B.x, A.y - B.y);
}

// The angle at point b, formed by a–b–c, in degrees (0–180).
export function angleAt(a, b, c, frame) {
  const A = toPixels(a, frame);
  const B = toPixels(b, frame);
  const C = toPixels(c, frame);
  const ba = { x: A.x - B.x, y: A.y - B.y };
  const bc = { x: C.x - B.x, y: C.y - B.y };
  const cos = (ba.x * bc.x + ba.y * bc.y) / (Math.hypot(ba.x, ba.y) * Math.hypot(bc.x, bc.y));
  return Math.acos(Math.min(1, Math.max(-1, cos))) * 180 / Math.PI;
}

// Blend each new value with the previous one to calm frame-to-frame jitter.
// amount = how much of the old value to keep (0 = no smoothing).
function smooth(previous, value, amount) {
  return previous == null ? value : previous * amount + value * (1 - amount);
}

// The UP / DOWN state machine shared by both counters.
export class RepTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.count = 0;
    this.isDown = false;
  }

  // reachedBottom: the measurement passed the "down" threshold.
  // backUp: the measurement passed the "up" threshold.
  step(reachedBottom, backUp) {
    if (!this.isDown && reachedBottom) {
      this.isDown = true;
    } else if (this.isDown && backUp) {
      this.isDown = false;
      this.count++;
    }
  }
}

// ---------------------------------------------------------------------
// Algorithm 1: LEGS
// Measures the knee angle (hip–knee–ankle), averaged over whichever legs
// are visible. Straight legs are about 170–180°; a deep squat is under 90°.
// ---------------------------------------------------------------------
export class LegsCounter {
  static DEFAULTS = {
    downBelow: 100, // knee angle (degrees) that counts as the bottom
    upAbove: 160,   // knee angle (degrees) that counts as standing again
    smoothing: 0.5
  };

  constructor(settings = {}) {
    this.settings = { ...LegsCounter.DEFAULTS, ...settings };
    this.reset();
  }

  reset() {
    this.reps = new RepTracker();
    this.kneeAngle = null;
  }

  get count() { return this.reps.count; }
  get isDown() { return this.reps.isDown; }

  // Returns a short message describing the current measurement.
  update(landmarks, frame) {
    const legs = [
      [LANDMARK.LEFT_HIP, LANDMARK.LEFT_KNEE, LANDMARK.LEFT_ANKLE],
      [LANDMARK.RIGHT_HIP, LANDMARK.RIGHT_KNEE, LANDMARK.RIGHT_ANKLE]
    ];
    const angles = [];
    for (const [hip, knee, ankle] of legs) {
      const points = [landmarks[hip], landmarks[knee], landmarks[ankle]];
      if (points.every(isVisible)) angles.push(angleAt(...points, frame));
    }
    if (angles.length === 0) return 'legs not in view';

    const average = angles.reduce((sum, a) => sum + a, 0) / angles.length;
    this.kneeAngle = smooth(this.kneeAngle, average, this.settings.smoothing);
    this.reps.step(
      this.kneeAngle < this.settings.downBelow,
      this.kneeAngle > this.settings.upAbove
    );
    return 'knee angle ' + Math.round(this.kneeAngle) + '°';
  }
}

// ---------------------------------------------------------------------
// Algorithm 2: HEAD
// Measures how far the nose has dropped below its standing height. The
// drop is in shoulder-widths, so it works at any distance from the camera,
// and only the head and shoulders need to be in view.
// ---------------------------------------------------------------------
export class HeadCounter {
  static DEFAULTS = {
    downBelow: 0.7, // drop (shoulder-widths) that counts as the bottom
    upAbove: 0.25,  // drop (shoulder-widths) that counts as standing again
    smoothing: 0.5,
    // While standing, the standing height slowly follows the head, so
    // stepping closer or farther from the camera is tolerated.
    standingDrift: 0.005,
    // Shoulders look narrow when turned sideways, so the widest recent
    // shoulder width is used, shrinking slowly by this factor per frame.
    shoulderDecay: 0.999
  };

  constructor(settings = {}) {
    this.settings = { ...HeadCounter.DEFAULTS, ...settings };
    this.reset();
  }

  reset() {
    this.reps = new RepTracker();
    this.headY = null;          // smoothed nose height, pixels (grows downward)
    this.standingY = null;      // nose height when standing, pixels
    this.shoulderWidth = null;  // body scale, pixels
    this.drop = null;           // shoulder-widths below standing height
  }

  get count() { return this.reps.count; }
  get isDown() { return this.reps.isDown; }

  // Returns a short message describing the current measurement.
  update(landmarks, frame) {
    const nose = landmarks[LANDMARK.NOSE];
    const left = landmarks[LANDMARK.LEFT_SHOULDER];
    const right = landmarks[LANDMARK.RIGHT_SHOULDER];
    if (![nose, left, right].every(isVisible)) return 'head not in view';

    const width = distance(left, right, frame);
    if (width < 1) return 'head not in view';
    const s = this.settings;
    this.shoulderWidth = this.shoulderWidth == null
      ? width
      : Math.max(this.shoulderWidth * s.shoulderDecay, width);

    this.headY = smooth(this.headY, toPixels(nose, frame).y, s.smoothing);

    if (this.standingY == null || this.headY < this.standingY) {
      this.standingY = this.headY; // highest head position seen
    } else if (!this.isDown) {
      this.standingY += (this.headY - this.standingY) * s.standingDrift;
    }

    this.drop = (this.headY - this.standingY) / this.shoulderWidth;
    this.reps.step(this.drop > s.downBelow, this.drop < s.upAbove);
    return 'head drop ' + this.drop.toFixed(2) + ' shoulder-widths';
  }
}

// Both counters together, so callers can update and reset them as one.
export function createCounters(settings = {}) {
  return {
    legs: new LegsCounter(settings.legs),
    head: new HeadCounter(settings.head)
  };
}
