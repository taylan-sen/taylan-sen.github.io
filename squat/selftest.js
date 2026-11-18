// Self-tests for the squat counters and data files.
//
// Run them either way:
//   • in a browser: open squat-test.html
//   • in a terminal: node squat/selftest-node.mjs
//
// The tests use a simulated person (a simple side-view stick figure), not
// real camera data, so they check the logic, not MediaPipe's accuracy.

import { LANDMARK, angleAt, LegsCounter, HeadCounter, SquatCounter } from './counters.js';
import {
  createSession, addFrame, finishSession, sessionToJSON, parseSession, replaySession,
  packLandmarks, unpackLandmarks
} from './datafile.js';

const FRAME = { width: 1280, height: 720 };

// ---------------------------------------------------------------------
// Simulated person
// ---------------------------------------------------------------------

// Repeatable random numbers, so every run gives the same result.
function seededRandom(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// All 33 landmarks for a person whose knees are bent to kneeAngle
// (180 = standing straight). The torso leans forward as the knees bend,
// like a real squat. jitter = random noise in pixels.
function simulatedPose(kneeAngle, random, jitter = 3) {
  const SHIN = 160, THIGH = 160, HIP_TO_SHOULDER = 200, SHOULDER_TO_NOSE = 70;
  const SHOULDER_WIDTH = 140;
  const bend = (180 - kneeAngle) * Math.PI / 180;
  const shinTilt = bend * 0.4;                // shin leans forward
  const thighTilt = bend - shinTilt;          // thigh leans back, so the knee angle is kneeAngle
  const torsoLean = bend * 0.4;               // chest leans forward

  const ankle = { x: 640, y: 680 };
  const knee = { x: ankle.x + SHIN * Math.sin(shinTilt), y: ankle.y - SHIN * Math.cos(shinTilt) };
  const hip = { x: knee.x - THIGH * Math.sin(thighTilt), y: knee.y - THIGH * Math.cos(thighTilt) };
  const shoulder = {
    x: hip.x + HIP_TO_SHOULDER * Math.sin(torsoLean),
    y: hip.y - HIP_TO_SHOULDER * Math.cos(torsoLean)
  };
  const nose = { x: shoulder.x + 20, y: shoulder.y - SHOULDER_TO_NOSE };

  const noise = () => (random() - 0.5) * 2 * jitter;
  const point = (p, dx = 0) => ({
    x: (p.x + dx + noise()) / FRAME.width,
    y: (p.y + noise()) / FRAME.height,
    z: 0,
    visibility: 0.95
  });

  const landmarks = Array.from({ length: 33 }, () => point(hip)); // unused points
  landmarks[LANDMARK.NOSE] = point(nose);
  landmarks[LANDMARK.LEFT_SHOULDER] = point(shoulder, -SHOULDER_WIDTH / 2);
  landmarks[LANDMARK.RIGHT_SHOULDER] = point(shoulder, SHOULDER_WIDTH / 2);
  landmarks[LANDMARK.LEFT_HIP] = landmarks[LANDMARK.RIGHT_HIP] = point(hip);
  landmarks[LANDMARK.LEFT_KNEE] = landmarks[LANDMARK.RIGHT_KNEE] = point(knee);
  landmarks[LANDMARK.LEFT_ANKLE] = landmarks[LANDMARK.RIGHT_ANKLE] = point(ankle);
  return landmarks;
}

// Knee angles for a workout: stand, then `reps` squats down to `depth`
// degrees and back, about 1 second down and up each (30 frames/second).
function squatAngles(reps, depth = 80) {
  const angles = [];
  const stand = (frames) => { for (let i = 0; i < frames; i++) angles.push(175); };
  stand(30);
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i <= 60; i++) angles.push(175 - (175 - depth) * Math.sin(Math.PI * i / 60));
    stand(20);
  }
  return angles;
}

function poses(angles, seed = 1, jitter = 3) {
  const random = seededRandom(seed);
  return angles.map(a => simulatedPose(a, random, jitter));
}

// A copy of a pose with some points made invisible.
function hide(pose, ...points) {
  const copy = pose.slice();
  for (const i of points) copy[i] = { ...copy[i], visibility: 0.1 };
  return copy;
}

function feed(counter, poseList) {
  let message = '';
  for (const p of poseList) message = counter.update(p, FRAME);
  return message;
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------
function assertEqual(actual, expected, what) {
  if (actual !== expected) throw new Error(what + ': expected ' + expected + ', got ' + actual);
}

function assertNear(actual, expected, tolerance, what) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(what + ': expected about ' + expected + ', got ' + actual);
  }
}

const tests = [
  ['angleAt measures a right angle as 90°', () => {
    const a = { x: 0.1, y: 0.5 }, b = { x: 0.5, y: 0.5 }, c = { x: 0.5, y: 0.1 };
    assertNear(angleAt(a, b, c, FRAME), 90, 1e-9, 'angle');
  }],

  ['simulated pose has the requested knee angle', () => {
    const p = simulatedPose(90, seededRandom(1), 0);
    const angle = angleAt(p[LANDMARK.LEFT_HIP], p[LANDMARK.LEFT_KNEE], p[LANDMARK.LEFT_ANKLE], FRAME);
    assertNear(angle, 90, 0.01, 'knee angle');
  }],

  ['legs counter counts 5 squats', () => {
    const legs = new LegsCounter();
    feed(legs, poses(squatAngles(5)));
    assertEqual(legs.count, 5, 'legs count');
  }],

  ['head counter counts 5 squats', () => {
    const head = new HeadCounter();
    feed(head, poses(squatAngles(5)));
    assertEqual(head.count, 5, 'head count');
  }],

  ['standing still with jitter counts nothing', () => {
    const counter = new SquatCounter();
    feed(counter, poses(new Array(300).fill(172), 2, 8));
    assertEqual(counter.legs.count, 0, 'legs count');
    assertEqual(counter.head.count, 0, 'head count');
    assertEqual(counter.count, 0, 'combined count');
  }],

  ['quarter squats (knees to 140°) are not counted by the legs counter', () => {
    const legs = new LegsCounter();
    feed(legs, poses(squatAngles(4, 140)));
    assertEqual(legs.count, 0, 'legs count');
  }],

  ['wobbling around the bottom threshold counts only 1 rep', () => {
    const legs = new LegsCounter();
    const angles = [...new Array(30).fill(175)];
    for (let i = 0; i < 40; i++) angles.push(i % 2 ? 95 : 108); // around downBelow (100°)
    angles.push(...new Array(30).fill(175));
    feed(legs, poses(angles, 3, 0));
    assertEqual(legs.count, 1, 'legs count');
  }],

  ['legs counter reports when legs are hidden', () => {
    const legs = new LegsCounter();
    const p = simulatedPose(175, seededRandom(1));
    p[LANDMARK.LEFT_ANKLE] = { ...p[LANDMARK.LEFT_ANKLE], visibility: 0.1 };
    p[LANDMARK.RIGHT_ANKLE] = { ...p[LANDMARK.RIGHT_ANKLE], visibility: 0.1 };
    assertEqual(legs.update(p, FRAME), 'legs not in view', 'message');
  }],

  ['head counter works at a different distance from the camera', () => {
    // Same squats, but the person is half the size in the frame.
    const head = new HeadCounter();
    const small = poses(squatAngles(3)).map(p => p.map(q => ({ ...q, x: 0.25 + q.x / 2, y: 0.25 + q.y / 2 })));
    feed(head, small);
    assertEqual(head.count, 3, 'head count');
  }],

  ['custom settings change the result', () => {
    const strict = new LegsCounter({ downBelow: 70 }); // squats only reach 80°
    feed(strict, poses(squatAngles(3, 80)));
    assertEqual(strict.count, 0, 'legs count');
  }],

  ['landmarks survive packing to 4 decimal places', () => {
    const p = simulatedPose(120, seededRandom(4));
    const back = unpackLandmarks(packLandmarks(p));
    for (let i = 0; i < p.length; i++) {
      assertNear(back[i].x, p[i].x, 5e-5, 'x of point ' + i);
      assertNear(back[i].y, p[i].y, 5e-5, 'y of point ' + i);
    }
  }],

  ['missing points in a data file count as not visible', () => {
    const back = unpackLandmarks([null, [0.5, 0.5, 0, 0.9]]);
    assertEqual(back[0].visibility, 0, 'visibility of missing point');
    assertEqual(back[1].visibility, 0.9, 'visibility of saved point');
  }],

  ['a saved data file replays to the same counts as live', () => {
    const live = new SquatCounter();
    const session = createSession({ source: 'test', width: FRAME.width, height: FRAME.height, model: 'test' });
    const list = poses(squatAngles(4), 5);
    list.forEach((p, i) => {
      live.update(p, FRAME);
      addFrame(session, i / 30, p);
    });
    addFrame(session, list.length / 30, null); // a frame with nobody in it
    finishSession(session, live, 4);

    const loaded = parseSession(sessionToJSON(session));
    assertEqual(loaded.labels.reps, 4, 'saved actual reps');
    assertEqual(loaded.results.count, live.count, 'saved combined result');
    const replayed = replaySession(loaded, new SquatCounter());
    assertEqual(replayed.count, live.count, 'replayed combined count');
    assertEqual(replayed.legs, live.legs.count, 'replayed legs count');
    assertEqual(replayed.head, live.head.count, 'replayed head count');
    assertEqual(replayed.count, 4, 'combined count');
  }],

  ['replay can try new settings on the same data', () => {
    const session = createSession({ source: 'test', width: FRAME.width, height: FRAME.height, model: 'test' });
    poses(squatAngles(3, 80), 6).forEach((p, i) => addFrame(session, i / 30, p));
    assertEqual(replaySession(session, new SquatCounter()).legs, 3, 'default settings');
    assertEqual(replaySession(session, new SquatCounter({ legs: { downBelow: 70 } })).legs, 0, 'stricter settings');
  }],

  // ----- The combined counter -----

  ['combined: a squat both algorithms see counts once', () => {
    const counter = new SquatCounter();
    feed(counter, poses(squatAngles(5)));
    assertEqual(counter.legs.count, 5, 'legs alone');
    assertEqual(counter.head.count, 5, 'head alone');
    assertEqual(counter.count, 5, 'combined count');
  }],

  ['combined: counts squats only the head sees (legs hidden)', () => {
    const counter = new SquatCounter();
    feed(counter, poses(squatAngles(3)).map(p => hide(p, LANDMARK.LEFT_ANKLE, LANDMARK.RIGHT_ANKLE)));
    assertEqual(counter.legs.count, 0, 'legs alone');
    assertEqual(counter.count, 3, 'combined count');
  }],

  ['combined: counts squats only the legs see (head hidden)', () => {
    const counter = new SquatCounter();
    feed(counter, poses(squatAngles(3)).map(p => hide(p, LANDMARK.NOSE)));
    assertEqual(counter.head.count, 0, 'head alone');
    assertEqual(counter.count, 3, 'combined count');
  }],

  ['combined: adds up squats seen by different algorithms', () => {
    // 2 squats with the legs hidden, then 2 with the head hidden.
    const counter = new SquatCounter();
    const all = poses(squatAngles(4));
    const middle = Math.floor(all.length / 2);
    feed(counter, all.map((p, i) => i < middle
      ? hide(p, LANDMARK.LEFT_ANKLE, LANDMARK.RIGHT_ANKLE)
      : hide(p, LANDMARK.NOSE)));
    assertEqual(counter.count, 4, 'combined count');
  }],

  ['combined: one stuck algorithm does not block the other', () => {
    // The head never comes back "up" (upAbove below zero is impossible).
    const counter = new SquatCounter({ head: { upAbove: -1 } });
    feed(counter, poses(squatAngles(4)));
    assertEqual(counter.head.count, 0, 'head alone');
    assertEqual(counter.count, 4, 'combined count');
  }],

  ['combined: overlapping reps match, separate reps add up', () => {
    const overlap = new SquatCounter();
    overlap.addRep('legs', 10, 40);
    overlap.addRep('head', 30, 60);
    assertEqual(overlap.count, 1, 'overlapping reps');

    const nearby = new SquatCounter();
    nearby.addRep('legs', 10, 40);
    nearby.addRep('head', 45, 70); // starts 5 frames after: within the gap
    assertEqual(nearby.count, 1, 'reps within the gap');

    const apart = new SquatCounter();
    apart.addRep('legs', 10, 40);
    apart.addRep('head', 100, 130);
    assertEqual(apart.count, 2, 'separate reps');

    const sameAlgorithm = new SquatCounter();
    sameAlgorithm.addRep('legs', 10, 40);
    sameAlgorithm.addRep('legs', 35, 60);
    assertEqual(sameAlgorithm.count, 2, 'two reps from the same algorithm');

    // A rep can only be matched once: legs, head (matches), legs again.
    const chain = new SquatCounter();
    chain.addRep('legs', 10, 40);
    chain.addRep('head', 35, 70);
    chain.addRep('legs', 65, 100);
    assertEqual(chain.count, 2, 'chained reps');
  }],

  ['a file that is not a data file is rejected', () => {
    for (const text of ['not json', '{"hello": 1}', '{"frames": [], "width": 0, "height": 720}']) {
      let rejected = false;
      try { parseSession(text); } catch { rejected = true; }
      assertEqual(rejected, true, 'rejected ' + JSON.stringify(text));
    }
  }]
];

// Runs every test; returns [{ name, passed, error }].
export function runSelfTests() {
  return tests.map(([name, test]) => {
    try {
      test();
      return { name, passed: true, error: null };
    } catch (err) {
      return { name, passed: false, error: err.message };
    }
  });
}
