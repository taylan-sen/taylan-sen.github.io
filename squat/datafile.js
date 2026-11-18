// Data files: a recorded session saved as JSON, so it can be replayed
// through the counters later without a camera or MediaPipe.
//
// File format (version 1):
// {
//   version: 1,
//   source: "camera" or "file:<video name>",
//   createdAt: ISO date,
//   model: MediaPipe model name,
//   width, height: video size in pixels,
//   labels:   { reps: the true rep count typed in, or null },
//   results:  { count, legs, head }: the combined count, and what each
//             algorithm counted on its own,
//   settings: { legs, head, combined }: counter settings used,
//   frames:   [ { t: seconds, lm: 33 × [x, y, z, visibility] or null } ]
// }

export const DATA_FILE_VERSION = 1;

export function createSession({ source, width, height, model }) {
  return {
    version: DATA_FILE_VERSION,
    source,
    createdAt: new Date().toISOString(),
    model,
    width,
    height,
    labels: { reps: null },
    results: null,
    settings: null,
    frames: []
  };
}

// 4 decimal places is far finer than MediaPipe's accuracy and keeps files small.
const round4 = (v) => Math.round(v * 1e4) / 1e4;

export function packLandmarks(landmarks) {
  return landmarks.map(p => [round4(p.x), round4(p.y), round4(p.z ?? 0), round4(p.visibility ?? 1)]);
}

export function unpackLandmarks(packed) {
  return packed.map(p => p
    ? { x: p[0], y: p[1], z: p[2], visibility: p[3] }
    : { x: 0, y: 0, z: 0, visibility: 0 }); // a missing point counts as not visible
}

// landmarks = MediaPipe's points, or null when no person was found.
export function addFrame(session, seconds, landmarks) {
  session.frames.push({ t: round4(seconds), lm: landmarks ? packLandmarks(landmarks) : null });
}

// Store the results, settings and true rep count before saving.
// counter = a SquatCounter (see counters.js).
export function finishSession(session, counter, actualReps) {
  session.labels.reps = Number.isInteger(actualReps) ? actualReps : null;
  session.results = { count: counter.count, legs: counter.legs.count, head: counter.head.count };
  session.settings = {
    legs: { ...counter.legs.settings },
    head: { ...counter.head.settings },
    combined: { ...counter.settings }
  };
  return session;
}

export function sessionToJSON(session) {
  return JSON.stringify(session);
}

// Throws an Error with a readable message if the text isn't a data file.
export function parseSession(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  if (!data || !Array.isArray(data.frames) || !(data.width > 0) || !(data.height > 0)) {
    throw new Error('not a squat data file');
  }
  return data;
}

// Run every saved frame through a SquatCounter (after resetting it).
// Returns the combined count, each algorithm's own count, the true count,
// and each algorithm's last message.
export function replaySession(session, counter) {
  const frame = { width: session.width, height: session.height };
  counter.reset();
  let messages = { legs: 'no legs found', head: 'no head found' };
  for (const { lm } of session.frames) {
    if (lm) messages = counter.update(unpackLandmarks(lm), frame);
  }
  return {
    count: counter.count,
    legs: counter.legs.count,
    head: counter.head.count,
    actual: session.labels?.reps ?? null,
    messages
  };
}
