// SQUAT CHALLENGE NU page: camera → MediaPipe skeleton → squat counters.
//
// Sections:
//   1. Setup: page elements, MediaPipe model
//   2. Scoreboard
//   3. The pipeline: one video frame in, skeleton and counts out
//   4. Live camera
//   5. Recording (video file + data file)
//   6. Opening a saved video
//   7. Opening a saved data file
//   8. Stop, and button wiring

import {
  FilesetResolver,
  PoseLandmarker,
  DrawingUtils
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
import { createCounters } from './counters.js';
import { launchBalloons } from './balloons.js';
import {
  createSession, addFrame, finishSession, sessionToJSON, parseSession, replaySession
} from './datafile.js';

// ---------------------------------------------------------------------
// 1. Setup
// ---------------------------------------------------------------------
const MEDIAPIPE_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_NAME = 'pose_landmarker_lite';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/'
  + 'pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');
const drawing = new DrawingUtils(ctx);
const buttons = {
  start: $('startBtn'),
  record: $('recordBtn'),
  stop: $('stopBtn'),
  reset: $('resetBtn'),
  openVideo: $('openVideoBtn'),
  openData: $('openDataBtn'),
  saveData: $('saveDataBtn')
};

const counters = createCounters();

// What's running right now.
const state = {
  source: null,        // null, 'camera' or 'file'
  stream: null,        // camera stream
  recorder: null,      // MediaRecorder while recording
  recordStart: 0,      // performance.now() when recording began
  session: null,       // data being collected, or the last data file
  baseName: 'squat',   // file name (without extension) for downloads
  frame: { width: 0, height: 0 },
  lastVideoTime: -1,
  animationId: null
};

function setStatus(text) {
  $('status').textContent = text;
}

// Load the pose model once (tries the graphics card first, then the CPU).
let poseLandmarker = null;
let poseLoading = null;
function loadPoseModel() {
  if (!poseLoading) {
    poseLoading = (async () => {
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
      const options = (delegate) => ({
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numPoses: 1
      });
      try {
        poseLandmarker = await PoseLandmarker.createFromOptions(vision, options('GPU'));
      } catch (err) {
        console.warn('GPU pose model failed, using CPU:', err);
        poseLandmarker = await PoseLandmarker.createFromOptions(vision, options('CPU'));
      }
      return poseLandmarker;
    })();
    poseLoading.catch(() => { poseLoading = null; }); // allow a retry
  }
  return poseLoading;
}

// ---------------------------------------------------------------------
// 2. Scoreboard
// ---------------------------------------------------------------------
// Balloons go up once, when either counter first reaches this many reps.
// Resetting the counts arms them again.
const PARTY_AT = 10;
let partyDone = false;

function showCounts(legsMessage, headMessage) {
  $('legsCount').textContent = counters.legs.count;
  $('headCount').textContent = counters.head.count;
  $('legsDetail').textContent = legsMessage;
  $('headDetail').textContent = headMessage;
  // A box lights up while its counter thinks you're at the bottom.
  $('legsScore').classList.toggle('down', counters.legs.isDown);
  $('headScore').classList.toggle('down', counters.head.isDown);

  if (!partyDone && Math.max(counters.legs.count, counters.head.count) >= PARTY_AT) {
    partyDone = true;
    launchBalloons(PARTY_AT + ' SQUATS!');
  }
}

function resetCounts() {
  counters.legs.reset();
  counters.head.reset();
  partyDone = false;
  showCounts('knee angle —', 'head drop —');
}

// ---------------------------------------------------------------------
// 3. The pipeline: runs once per new video frame, for the live camera
//    and for saved videos alike.
// ---------------------------------------------------------------------
function drawSkeleton(landmarks) {
  const lineWidth = Math.max(2, canvas.width / 200);
  drawing.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, {
    color: '#f2c75c', // gold
    lineWidth
  });
  drawing.drawLandmarks(landmarks, {
    color: '#2a0845',     // dark purple outline
    fillColor: '#b48ce6', // light purple
    lineWidth: lineWidth / 2,
    radius: lineWidth * 1.2
  });
}

function processFrame() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!poseLandmarker) return; // model still loading

  // MediaPipe needs a timestamp that always increases.
  const result = poseLandmarker.detectForVideo(video, performance.now());
  const landmarks = result.landmarks[0] ?? null;

  // The canvas is mirrored together with the video (in CSS), so the
  // skeleton can be drawn in camera coordinates and still line up.
  if (landmarks) {
    drawSkeleton(landmarks);
    showCounts(
      counters.legs.update(landmarks, state.frame),
      counters.head.update(landmarks, state.frame)
    );
  } else {
    showCounts('no person detected', 'no person detected');
  }

  // Save the landmarks while recording the camera or processing a video.
  if (state.source === 'file') {
    addFrame(state.session, video.currentTime, landmarks);
  } else if (state.recorder) {
    addFrame(state.session, (performance.now() - state.recordStart) / 1000, landmarks);
  }
}

function runLoop() {
  if (!state.source) return;
  // Only process frames the video hasn't shown before.
  if (video.readyState >= 2 && video.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = video.currentTime;
    processFrame();
  }
  state.animationId = requestAnimationFrame(runLoop);
}

function startLoop() {
  state.lastVideoTime = -1;
  state.animationId = requestAnimationFrame(runLoop);
}

function showVideo() {
  // Match the drawing surface to the real video size.
  canvas.width = state.frame.width = video.videoWidth;
  canvas.height = state.frame.height = video.videoHeight;
  video.hidden = false;
  canvas.hidden = false;
  $('placeholder').hidden = true;
}

function hideVideo() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  video.hidden = true;
  canvas.hidden = true;
  $('placeholder').hidden = false;
}

// While something is running, only Stop (and Record, for the camera) work.
function setRunning(running) {
  buttons.start.disabled = running;
  buttons.openVideo.disabled = running;
  buttons.openData.disabled = running;
  buttons.stop.disabled = !running;
}

// ---------------------------------------------------------------------
// 4. Live camera
// ---------------------------------------------------------------------
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('This browser does not support camera access (it needs https or localhost).');
    return;
  }
  setRunning(true);
  buttons.stop.disabled = true; // nothing to stop until the camera is on
  setStatus('Requesting camera…');
  const modelReady = loadPoseModel(); // download the model meanwhile
  modelReady.catch(() => {});

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
  } catch (err) {
    state.stream = null;
    setRunning(false);
    setStatus(err.name === 'NotAllowedError'
      ? 'Camera permission was denied. Allow it in your browser settings and try again.'
      : 'Could not start the camera: ' + err.message);
    return;
  }

  video.srcObject = state.stream;
  await video.play();
  state.source = 'camera';
  showVideo();
  buttons.stop.disabled = false;
  buttons.record.disabled = false;
  startLoop();

  const size = video.videoWidth + '×' + video.videoHeight;
  if (!poseLandmarker) setStatus('Camera on (' + size + ') · loading skeleton tracking…');
  try {
    await modelReady;
    if (state.source === 'camera') setStatus('Camera on (' + size + ') · skeleton tracking on');
  } catch (err) {
    console.error(err);
    if (state.source === 'camera') setStatus('Camera on (' + size + ') · skeleton tracking failed to load');
  }
}

// ---------------------------------------------------------------------
// 5. Recording: saves the camera video and a data file side by side.
// ---------------------------------------------------------------------
function timestampForFileName() {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate())
    + '-' + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds());
}

function downloadFile(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function readActualReps() {
  const value = parseInt($('actualReps').value, 10);
  return Number.isInteger(value) ? value : null;
}

function saveDataFile() {
  const session = state.session;
  if (!session || session.frames.length === 0) return;
  finishSession(session, counters, readActualReps());
  downloadFile(new Blob([sessionToJSON(session)], { type: 'application/json' }), state.baseName + '.json');
}

// Chrome and Firefox record WebM; Safari records MP4.
function pickVideoFormat() {
  const formats = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  return formats.find(type => MediaRecorder.isTypeSupported(type)) ?? '';
}

function startRecording() {
  if (!window.MediaRecorder) {
    setStatus('This browser cannot record video.');
    return;
  }
  const format = pickVideoFormat();
  const chunks = [];
  const recorder = new MediaRecorder(state.stream, format ? { mimeType: format } : undefined);
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  recorder.onstop = () => {
    state.recorder = null;
    const type = recorder.mimeType || format || 'video/webm';
    const videoName = state.baseName + (type.includes('mp4') ? '.mp4' : '.webm');
    downloadFile(new Blob(chunks, { type }), videoName);
    saveDataFile();
    buttons.record.textContent = 'Record';
    buttons.record.classList.remove('recording');
    buttons.saveData.disabled = false;
    setStatus('Saved ' + videoName + ' and ' + state.baseName + '.json ('
      + state.session.frames.length + ' frames)');
  };

  resetCounts(); // so the saved counts match the recording
  state.baseName = 'squat-' + timestampForFileName();
  state.session = createSession({
    source: 'camera', width: state.frame.width, height: state.frame.height, model: MODEL_NAME
  });
  state.recordStart = performance.now();
  state.recorder = recorder;
  recorder.start(1000); // hand over video data every second
  buttons.record.textContent = 'Stop recording';
  buttons.record.classList.add('recording');
  buttons.saveData.disabled = true;
  setStatus('Recording…');
}

function stopRecording() {
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
}

// ---------------------------------------------------------------------
// 6. Opening a saved video: runs it through the same pipeline as the
//    camera, collecting a data file as it plays.
// ---------------------------------------------------------------------
function waitForVideo() {
  return new Promise((resolve, reject) => {
    video.onloadeddata = resolve;
    video.onerror = () => reject(new Error('this browser cannot play it'));
  });
}

async function openVideo(file) {
  stop();
  setRunning(true);
  buttons.stop.disabled = true;
  setStatus('Loading skeleton tracking…');
  try {
    await loadPoseModel();
  } catch (err) {
    console.error(err);
    setRunning(false);
    setStatus('Skeleton tracking failed to load.');
    return;
  }

  video.src = URL.createObjectURL(file);
  try {
    await waitForVideo();
  } catch (err) {
    setRunning(false);
    setStatus('Could not open ' + file.name + ': ' + err.message);
    return;
  }

  resetCounts();
  state.source = 'file';
  showVideo();
  state.baseName = file.name.replace(/\.[^.]+$/, '');
  state.session = createSession({
    source: 'file:' + file.name, width: state.frame.width, height: state.frame.height, model: MODEL_NAME
  });
  buttons.saveData.disabled = true;
  buttons.stop.disabled = false;
  setStatus('Processing ' + file.name + '…');

  video.onended = () => {
    stop();
    setStatus('Finished ' + file.name + ' · ' + state.session.frames.length
      + ' frames · use “Save data file” to keep the landmarks');
  };
  await video.play();
  startLoop();
}

// ---------------------------------------------------------------------
// 7. Opening a saved data file: replays the landmarks through the
//    counters instantly (no camera, no MediaPipe).
// ---------------------------------------------------------------------
async function openDataFile(file) {
  stop();
  let session;
  try {
    session = parseSession(await file.text());
  } catch (err) {
    setStatus('Could not read ' + file.name + ': ' + err.message);
    return;
  }
  state.session = session;
  state.baseName = file.name.replace(/\.json$/i, '');
  $('actualReps').value = session.labels?.reps ?? '';
  buttons.saveData.disabled = false;
  const result = replayInPage(session);
  setStatus('Replayed ' + file.name + ' (' + session.frames.length + ' frames): legs ' + result.legs
    + ', head ' + result.head + (result.actual != null ? ', actual ' + result.actual : ''));
}

function replayInPage(session) {
  const result = replaySession(session, counters); // resets the counters first
  partyDone = false;
  showCounts(result.legsMessage, result.headMessage);
  return result;
}

// For tuning from the browser console, e.g.:
//   squat.counters.legs.settings.downBelow = 110
//   squat.replay()        → counts for the loaded data file
//   squat.party()         → preview the balloons
window.squat = {
  counters,
  replay: (session = state.session) => replayInPage(session),
  party: () => launchBalloons(PARTY_AT + ' SQUATS!')
};

// ---------------------------------------------------------------------
// 8. Stop whatever is running, and wire up the buttons.
// ---------------------------------------------------------------------
function stop() {
  stopRecording(); // saves the files if a recording was running
  cancelAnimationFrame(state.animationId);
  const wasVideoFile = state.source === 'file';
  state.source = null;

  state.stream?.getTracks().forEach(track => track.stop());
  state.stream = null;
  video.onended = null;
  video.pause();
  video.srcObject = null;
  if (video.src) {
    URL.revokeObjectURL(video.src);
    video.removeAttribute('src');
    video.load();
  }

  hideVideo();
  setRunning(false);
  buttons.record.disabled = true;
  if (wasVideoFile && state.session.frames.length > 0) buttons.saveData.disabled = false;
  setStatus('Stopped');
}

// Hidden file pickers behind the "Open…" buttons.
function pickFile(inputId, onPicked) {
  const input = $(inputId);
  input.addEventListener('change', () => {
    if (input.files[0]) onPicked(input.files[0]);
    input.value = ''; // allow picking the same file again
  });
  return () => input.click();
}

buttons.start.addEventListener('click', startCamera);
buttons.stop.addEventListener('click', stop);
buttons.reset.addEventListener('click', resetCounts);
buttons.record.addEventListener('click', () => (state.recorder ? stopRecording() : startRecording()));
buttons.openVideo.addEventListener('click', pickFile('videoFile', openVideo));
buttons.openData.addEventListener('click', pickFile('dataFile', openDataFile));
buttons.saveData.addEventListener('click', saveDataFile);
