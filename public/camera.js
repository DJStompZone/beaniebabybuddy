// camera.js
// Camera utilities for BeanieBabyBuddy with detailed client logs and visual indicator for barcode detections

const Quagga = window.Quagga;

export function initCamera(els, estimate) {
  let stream = null;
  let currentTrack = null;
  let currentDeviceId = null;
  let torchOn = false;
  let currentZoom = 1;
  let onDetectedBound = null;
  let lastCode = "";
  let lastHitMs = 0;

  function log(level, msg, meta) {
    try { console[level](msg, meta || null); } catch (_) {}
    try {
      fetch("/log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ level: level, msg: msg, meta: meta || null })
      });
    } catch (_) {}
  }

  function uiStatus(text) { els.camState.textContent = text; }
  function uiError(text) { els.error.textContent = text; els.error.style.display = "block"; }
  function uiClearError() { els.error.textContent = ""; els.error.style.display = "none"; }

  async function permissionState() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return "unknown";
      const res = await navigator.permissions.query({ name: "camera" });
      return res.state || "unknown";
    } catch (_) {
      return "unknown";
    }
  }

  async function listCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(function (d) { return d.kind === "videoinput"; });
    log("log", "enumerated cameras", { count: cams.length, labels: cams.map(function (c) { return c.label; }) });
    return cams;
  }

  async function openStreamForDevice(deviceId) {
    const constraints = deviceId
      ? { video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } }
      : { video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } } };

    uiStatus("requesting");
    log("log", "getUserMedia request", { constraints: constraints });

    const s = await navigator.mediaDevices.getUserMedia(constraints);
    stream = s;

    const video = els.preview;
    video.srcObject = stream;
    await video.play();

    const track = stream.getVideoTracks()[0];
    currentTrack = track;

    const settings = track.getSettings ? track.getSettings() : {};
    currentDeviceId = settings.deviceId || deviceId || null;

    log("log", "getUserMedia granted", { deviceId: currentDeviceId, settings: settings });
    return currentDeviceId;
  }

  function closeStream() {
    try {
      if (stream) {
        stream.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
      }
    } catch (_) {}
    stream = null;
    currentTrack = null;
  }

  async function applyTrackControls() {
    if (!currentTrack) return;
    const caps = currentTrack.getCapabilities ? currentTrack.getCapabilities() : {};
    const cons = { advanced: [] };

    if (caps.torch) cons.advanced.push({ torch: torchOn });

    if (typeof caps.zoom === "number" || (caps.zoom && typeof caps.zoom.max === "number")) {
      cons.advanced.push({ zoom: currentZoom });
    }

    try {
      await currentTrack.applyConstraints(cons);
      log("log", "applied constraints", { constraints: cons });
    } catch (e) {
      log("warn", "applyConstraints failed", { error: String(e) });
    }
  }

  function flashDetected() {
    const frame = els.preview.parentElement;
    const prev = frame.style.boxShadow;
    frame.style.boxShadow = "0 0 0 3px #10b981 inset";
    setTimeout(function () { frame.style.boxShadow = prev; }, 220);
  }

  function attachDetectionHandler() {
    if (onDetectedBound) Quagga.offDetected(onDetectedBound);
    onDetectedBound = function onDetected(data) {
      const code = data && data.codeResult && data.codeResult.code;
      if (!code) return;

      const now = Date.now();
      if (code === lastCode && now - lastHitMs < 1200) return; // debounce duplicate hits
      lastCode = code;
      lastHitMs = now;

      log("log", "barcode detected", { code: code });
      flashDetected();
      try { if (navigator.vibrate) navigator.vibrate(35); } catch (_) {}

      Quagga.pause();
      els.detected.textContent = "Detected: " + code;

      const query = /^\d{8,14}$/.test(code) ? code : code;
      Promise.resolve(estimate(query)).finally(function () { Quagga.start(); });
    };
    Quagga.onDetected(onDetectedBound);
  }

  async function start() {
    uiClearError();
    const pstate = await permissionState();
    log("log", "permission state", { camera: pstate });

    if (pstate === "denied") {
      uiStatus("blocked");
      uiError("Camera permission is blocked. Allow camera in site settings, then tap Start again.");
      return false;
    }

    uiStatus("starting");

    const cams = await listCameras();
    els.cameraSelect.innerHTML = "";
    cams.forEach(function (d, i) {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || "Camera " + String(i + 1);
      els.cameraSelect.appendChild(opt);
    });

    const env = cams.find(function (c) { return /back|rear|environment/i.test(c.label); }) || cams[0];
    const desiredId = env ? env.deviceId : null;
    els.cameraSelect.value = desiredId || (cams[0] && cams[0].deviceId) || "";

    try {
      await openStreamForDevice(desiredId);
    } catch (e) {
      uiStatus("error");
      uiError("getUserMedia failed: " + String(e && e.message ? e.message : e));
      log("error", "getUserMedia failed", { error: String(e) });
      return false;
    }

    try {
      currentZoom = 2;
      await applyTrackControls();
    } catch (_) {}

    const config = {
      inputStream: {
  name: "Live",
  type: "LiveStream",
  target: els.preview.parentElement,
  constraints: {
      deviceId: currentDeviceId ? { exact: currentDeviceId } : undefined,
      width: { ideal: 720 },
      height: { ideal: 1280 }
  },
  area: {
      top: "30%", right: "10%", left: "10%", bottom: "30%" }
  },
      locator: { patchSize: "large", halfSample: true },
      numOfWorkers: 0,
      frequency: 15,
      decoder: {
        readers: [
          "ean_reader",
          "ean_8_reader",
          "upc_reader",
          "upc_e_reader",
          "code_128_reader"
        ]
      },
      locate: true
    };

    let initDone = false;
    const timeoutMs = 14000;
    const timer = setTimeout(function () {
      if (initDone) return;
      uiStatus("timeout");
      uiError("Camera init timed out. If no permission prompt appeared, allow camera for this site and try Start again.");
      log("warn", "Quagga init timeout", null);
      try { Quagga.stop(); } catch (_) {}
    }, timeoutMs);

    return new Promise(function (resolve) {
      log("log", "Quagga.init begin", { deviceId: currentDeviceId });
      Quagga.init(config, async function (err) {
        initDone = true;
        clearTimeout(timer);

        if (err) {
          uiStatus("error");
          uiError("Quagga init failed: " + String(err));
          log("error", "Quagga init failed", { error: String(err) });
          resolve(false);
          return;
        }

        Quagga.start();
        uiStatus("running");
        log("log", "Quagga started", { deviceId: currentDeviceId });

        try {
          const qTrack = Quagga.CameraAccess.getActiveTrack();
          if (qTrack) currentTrack = qTrack;
          await applyTrackControls();
        } catch (e) {
          log("warn", "track capabilities not available", { error: String(e) });
        }

        attachDetectionHandler();
        resolve(true);
      });
    });
  }

  function stop() {
    try { Quagga.stop(); } catch (_) {}
    closeStream();
    uiStatus("stopped");
    log("log", "stopped", null);
  }

  async function switchCamera() {
    const cams = await listCameras();
    if (!cams.length) return;
    const idx = cams.findIndex(function (c) { return c.deviceId === currentDeviceId; });
    const next = cams[(idx + 1) % cams.length];
    els.cameraSelect.value = next.deviceId;
    stop();
    await start();
  }

  async function toggleTorch() { torchOn = !torchOn; await applyTrackControls(); }
  async function zoomIn() { currentZoom = (currentZoom || 1) + 0.5; await applyTrackControls(); }
  async function zoomOut() { currentZoom = (currentZoom || 1) - 0.5; if (currentZoom < 1) currentZoom = 1; await applyTrackControls(); }

  document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); });

  return { start, stop, switchCamera, toggleTorch, zoomIn, zoomOut };
}