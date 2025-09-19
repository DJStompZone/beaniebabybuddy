let app;

/**
 * Returns Quagga instance if available, regardless of UMD flavor.
 */
function resolveQuagga() {
  const wq = /** @type {any} */ (window).Quagga;
  if (wq && typeof wq.init === "function") return wq;
  if (wq && wq.default && typeof wq.default.init === "function")
    return wq.default;
  return null;
}

/**
 * Wait until Quagga is present (handles slow CDN / deferred execution).
 * @param {number} timeoutMs
 */
async function waitForQuagga(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const q = resolveQuagga();
    if (q) return q;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Quagga failed to load in time");
}

/** @typedef {{title:string, price:number, condition?:string, url?:string, source?:string}} PriceRow */

/**
 * Logger with level threshold, sampling, batching, and debug toggle.
 * - Network logging only if debug mode is enabled.
 * - Batches messages into a single POST every LOG_BATCH_MS.
 * - Soft cap per minute to prevent storms.
 */
class Logger {
  /** Config */
  static LOG_LEVELS = { log: 10, warn: 20, error: 30 };
  static LEVEL = Logger.LOG_LEVELS.warn;                     // minimum level to record
  static DEBUG = false;                                     // network logging on/off
  static LOG_SAMPLE = 1.0;                                  // 0..1 sampling
  static LOG_BATCH_MS = 1500;                               // batch window
  static LOG_MAX_PER_MIN = 60;                              // per minute soft cap

  static _q = [];
  static _timer = null;
  static _minuteStart = Date.now();
  static _sentThisMinute = 0;

  /**
   * Enable or disable network logging at runtime.
   * Sources: URL ?debug=1, localStorage('bbb.debug') === '1', or call Logger.setDebug(true)
   */
  static initDebugFlag() {
    try {
      const url = new URL(location.href);
      if (url.searchParams.get("debug") === "1") localStorage.setItem("bbb.debug", "1");
      if (url.searchParams.get("debug") === "0") localStorage.removeItem("bbb.debug");
      Logger.DEBUG = localStorage.getItem("bbb.debug") === "1";
    } catch (_) {}
  }

  /** Public API */
  static info(msg, meta)  { Logger.write("log", msg, meta); }
  static warn(msg, meta)  { Logger.write("warn", msg, meta); }
  static error(msg, meta) { Logger.write("error", msg, meta); }

  /**
   * Core write: respects level, sampling, batching.
   * Always logs to devtools console; only POSTs if DEBUG is true.
   */
  static write(level, msg, meta) {
    // devtools
    try { (console[level] || console.log)(msg, meta || null); } catch {}

    // network disabled
    if (!Logger.DEBUG) return;

    // level threshold
    if ((Logger.LOG_LEVELS[level] || 999) < Logger.LEVEL) return;

    // sampling
    if (Logger.LOG_SAMPLE < 1 && Math.random() > Logger.LOG_SAMPLE) return;

    // per-minute soft cap
    const now = Date.now();
    if (now - Logger._minuteStart >= 60_000) { Logger._minuteStart = now; Logger._sentThisMinute = 0; }
    if (Logger._sentThisMinute >= Logger.LOG_MAX_PER_MIN) return;

    Logger._q.push({ ts: now, level, msg: String(msg || ""), meta: meta ?? null, ua: navigator.userAgent });
    Logger._scheduleFlush();
  }

  static _scheduleFlush() {
    if (Logger._timer) return;
    Logger._timer = setTimeout(Logger._flush, Logger.LOG_BATCH_MS);
  }

  static async _flush() {
    Logger._timer = null;
    if (!Logger._q.length) return;

    // take snapshot
    const batch = Logger._q.splice(0, Logger._q.length);
    try {
      await fetch("/log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batch })
      });
      Logger._sentThisMinute += batch.length;
    } catch
    {
      // ignore
    }
  }

  static setDebug(on) { Logger.DEBUG = !!on; if (on) localStorage.setItem("bbb.debug", "1"); else localStorage.removeItem("bbb.debug"); }
  static setLevel(name) { if (name in Logger.LOG_LEVELS) Logger.LEVEL = Logger.LOG_LEVELS[name]; }
  static setSample(p) { Logger.LOG_SAMPLE = Math.max(0, Math.min(1, Number(p))); }
}

// enable from URL/localStorage once at startup
Logger.initDebugFlag();


/* ---------- GTIN validation / normalization --------------------------- */

/**
 * Validate GTIN-8/12/13/14 using the standard mod-10 checksum.
 */
function isValidGTIN(code) {
  const s = String(code || "").replace(/\D/g, "");
  const L = s.length;
  if (L !== 8 && L !== 12 && L !== 13 && L !== 14) return false;
  const digits = s.split("").map(Number);
  const check = digits.pop();
  let sum = 0,
    mul = 3;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += digits[i] * mul;
    mul = mul === 3 ? 1 : 3;
  }
  const cd = (10 - (sum % 10)) % 10;
  return cd === check;
}

/**
 * Accept a scanned barcode only if it passes checksum.
 * Prefer UPC-A/EAN-13; allow EAN-8 but de-prioritize.
 * Returns the normalized numeric string or null.
 */
function acceptScannedCode(raw) {
  const s = String(raw || "").replace(/\D/g, "");
  if (!isValidGTIN(s)) return null;
  if (s.length >= 12) return s; // UPC-A / EAN-13 / GTIN-14
  return s.length === 8 ? s : null; // EAN-8 (okay, but not preferred)
}

/**
 * Normalize manually entered UPC/EAN (strip, pad common cases).
 * For UPC-A vs EAN-13 with leading 0, keep the 12-digit UPC when possible.
 */
function normalizeInputCode(raw) {
  const s = String(raw || "").replace(/\D/g, "");
  if (s.length === 13 && s.startsWith("0")) return s.slice(1);
  return s;
}

/** Quagga Wrapper *******************************************************/
class QuaggaWrapper {
  /**
   * @param {HTMLElement} videoWrap
   */
  constructor(videoWrap) {
    this.videoWrap = videoWrap;
    this.active = false;
    this.eventsAttached = false;
    this._onDetected = null;
    this._onProcessed = null;
    this.currentTrack = null;
    this.currentDeviceId = null;
    this.torchOn = false;
    this.zoom = 1;
    this.onHit = null;
    this._lastCode = "";
    this._lastAt = 0;
  }

  /**
   * Initialize and start Quagga with the given device. Quagga opens the stream.
   * @param {string|null} deviceId
   * @returns {Promise<void>}
   */
  async init(deviceId) {
    const Q = await waitForQuagga();
    this.currentDeviceId = deviceId || null;

    /** @type {any} */
    const config = {
      inputStream: {
        name: "Live",
        type: "LiveStream",
        target: this.videoWrap,
        constraints: {
          deviceId: this.currentDeviceId
            ? { exact: this.currentDeviceId }
            : undefined,
          facingMode: this.currentDeviceId ? undefined : "environment",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        area: { top: "30%", right: "10%", left: "10%", bottom: "30%" },
      },
      locator: { patchSize: "large", halfSample: false },
      numOfWorkers: 0,
      frequency: 15,
      decoder: {
        readers: [
          "ean_reader",
          "ean_8_reader",
          "upc_reader",
          "upc_e_reader",
          "code_128_reader",
        ],
      },
      locate: true,
    };

    Logger.info("Quagga.init begin", { deviceId: this.currentDeviceId });

    await new Promise((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          Q.stop();
        } catch (_) {}
        this.active = false;
        Logger.warn("Quagga init timeout", null);
        reject(new Error("Quagga init timeout"));
      }, 12000);

      Q.init(config, async (err) => {
        if (timedOut) return;
        clearTimeout(timer);

        if (err) {
          Logger.error("Quagga init failed", String(err));
          reject(err);
          return;
        }

        try {
          Q.start();
        } catch (e) {
          Logger.error("Quagga start failed", String(e));
          reject(e);
          return;
        }
        this.active = true;

        try {
          const track =
            Q.CameraAccess && Q.CameraAccess.getActiveTrack
              ? Q.CameraAccess.getActiveTrack()
              : null;
          if (track) {
            this.currentTrack = track;
            this.zoom = 2;

            const s = (track.getSettings && track.getSettings()) || {};
            if (s.width && s.height) {
              this.videoWrap.style.setProperty(
                "--aspect",
                `${s.width} / ${s.height}`
              );
              this.videoWrap.style.setProperty(
                "--aspect-inv",
                `${s.height} / ${s.width}`
              );
            }

            await this.applyTrackConstraints();
          }
        } catch (e) {
          Logger.warn("No track capabilities", String(e));
        }

        if (!this.eventsAttached) {
          this._onProcessed = (res) => {
            const boxes = res && res.boxes ? res.boxes.length : 0;
            if (boxes) {
              Logger.info("processed", { boxes });
            }
          };
          Q.onProcessed(this._onProcessed);

          this._onDetected = (data) => {
            const raw =
              data && data.codeResult && data.codeResult.code
                ? data.codeResult.code
                : "";
            const code = acceptScannedCode(raw);
            if (!code) return; // bad checksum / junk

            const now = Date.now();
            if (code === this._lastCode && now - this._lastAt < 1200) return;
            this._lastCode = code;
            this._lastAt = now;
            Logger.info("barcode detected", { code });
            this.flash();
            try {
              if (navigator.vibrate) navigator.vibrate(150);
            } catch (_) {}
            if (this.onHit) this.onHit(code);
          };
          Q.onDetected(this._onDetected);

          this.eventsAttached = true;
        }

        Logger.info("Quagga started", { deviceId: this.currentDeviceId });
        resolve();
      });
    });
  }

  stop() {
    const Q = resolveQuagga();
    try {
      Q && Q.stop();
    } catch (_) {}
    try {
      const t =
        Q && Q.CameraAccess && Q.CameraAccess.getActiveTrack
          ? Q.CameraAccess.getActiveTrack()
          : null;
      if (t && t.stop) t.stop();
    } catch (_) {}
    if (this.eventsAttached) {
      try {
        if (Q && typeof Q.offProcessed === "function" && this._onProcessed)
          Q.offProcessed(this._onProcessed);
      } catch (_) {}
      try {
        if (Q && typeof Q.offDetected === "function" && this._onDetected)
          Q.offDetected(this._onDetected);
      } catch (_) {}
      this.eventsAttached = false;
    }
    this.active = false;
    this.currentTrack = null;
    Logger.info("Quagga stopped", null);
  }

  async applyTrackConstraints() {
    if (!this.currentTrack) return;
    const caps = this.currentTrack.getCapabilities
      ? this.currentTrack.getCapabilities()
      : {};
    const cons = { advanced: [] };
    if (caps.torch) cons.advanced.push({ torch: this.torchOn });
    if (
      typeof caps.zoom === "number" ||
      (caps.zoom && typeof caps.zoom.max === "number")
    )
      cons.advanced.push({ zoom: this.zoom });
    try {
      await this.currentTrack.applyConstraints(cons);
      Logger.info("applied constraints", cons);
    } catch (e) {
      Logger.warn("applyConstraints failed", String(e));
    }
  }

  flash() {
    this.videoWrap.classList.add("ok-flash");
    setTimeout(() => {
      this.videoWrap.classList.remove("ok-flash");
    }, 220);
  }

  async toggleTorch() {
    this.torchOn = !this.torchOn;
    await this.applyTrackConstraints();
  }
  async zoomIn() {
    this.zoom = (this.zoom || 1) + 0.5;
    await this.applyTrackConstraints();
  }
  async zoomOut() {
    this.zoom = Math.max(1, (this.zoom || 1) - 0.5);
    await this.applyTrackConstraints();
  }
}

/** Camera Controller *****************************************************/
class CameraController {
  /**
   * @param {HTMLElement} videoWrap
   * @param {HTMLSelectElement} selectEl
   */
  constructor(videoWrap, selectEl) {
    this.videoWrap = videoWrap;
    this.selectEl = selectEl;
    this.wrapper = new QuaggaWrapper(videoWrap);
    this.devices = [];
    this.currentId = null;
    this.onStatus = null;
  }

  async populateDevices() {
    const devs = await navigator.mediaDevices.enumerateDevices();
    this.devices = devs.filter((d) => d.kind === "videoinput");
    this.selectEl.innerHTML = "";
    this.devices.forEach((d, i) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || "Camera " + String(i + 1);
      this.selectEl.appendChild(opt);
    });
    const env =
      this.devices.find((c) => /back|rear|environment/i.test(c.label)) ||
      this.devices[0] ||
      null;
    this.currentId = env ? env.deviceId : null;
    if (this.currentId) this.selectEl.value = this.currentId;
  }

  async start() {
    if (this.onStatus) this.onStatus("starting");

    // Preflight permission so enumerateDevices has labels (helps iOS/Safari)
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      tmp.getTracks().forEach((t) => t.stop());
    } catch (e) {
      Logger.warn("preflight getUserMedia failed (will try anyway)", String(e));
    }

    const perm = await this.permissionState();
    Logger.info("permission state", { camera: perm });
    if (perm === "denied") {
      if (this.onStatus) this.onStatus("blocked");
      throw new Error("Camera permission blocked");
    }

    await this.populateDevices();
    await this.wrapper.init(this.currentId);
    if (this.onStatus) this.onStatus("running");
  }

  stop() {
    this.wrapper.stop();
    if (this.onStatus) this.onStatus("stopped");
  }

  async switchCamera() {
    if (!this.devices.length) await this.populateDevices();
    const idx = this.devices.findIndex((d) => d.deviceId === this.currentId);
    const next = this.devices[(idx + 1) % this.devices.length];
    this.currentId = next.deviceId;
    this.selectEl.value = this.currentId;
    this.stop();
    await this.start();
  }

  async permissionState() {
    try {
      if (!navigator.permissions || !navigator.permissions.query)
        return "unknown";
      const res = await navigator.permissions.query({ name: "camera" });
      return res.state || "unknown";
    } catch (_) {
      return "unknown";
    }
  }
}

/** Pricing ***************************************************************/
class PriceEstimator {
  static async estimate(q) {
    const res = await fetch("/api/estimate?query=" + encodeURIComponent(q));
    if (!res.ok) throw new Error((await res.text()) || String(res.status));
    return res.json();
  }
}

/** Utilities *************************************************************/
function usd(n) {
  if (n == null || !isFinite(n)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format(n);
}
function stats(vals) {
  const a = vals.slice().sort((x, y) => x - y);
  function q(p) {
    const i = (a.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return (a[lo] + a[hi]) / 2;
  }
  return { median: q(0.5), p25: q(0.25), p75: q(0.75) };
}

/**
 * Pick items and stats from either the legacy shape ({items})
 * or the new unified shape ({items_current, items_sold, stats}).
 * Prefers SOLD items for display; falls back to CURRENT.
 */
function unpackEstimateResponse(data) {
  if (Array.isArray(data.items)) {
    const vals = data.items.map((i) => i.price).filter(Number.isFinite);
    return {
      itemsForTable: data.items,
      stats: { count: vals.length, ...stats(vals) },
      note: data.note || "",
    };
  }
  const sold = Array.isArray(data.items_sold) ? data.items_sold : [];
  const current = Array.isArray(data.items_current) ? data.items_current : [];
  const combined = sold.concat(current);
  const vals = combined.map((i) => i.price).filter(Number.isFinite);
  const combinedStats =
    data.stats && data.stats.combined
      ? data.stats.combined
      : { count: vals.length, ...stats(vals) };
  const itemsForTable = sold.length ? sold : current;
  return { itemsForTable, stats: combinedStats, note: data.note || "" };
}

function setStatus(icon, text) {
  const el = document.getElementById("statusPill");
  if (el) el.textContent = icon + " " + text;
}

/** App *******************************************************************/
class App {
  constructor() {
    this.els = {
      start: document.getElementById("startBtn"),
      stop: document.getElementById("stopBtn"),
      switchBtn: document.getElementById("switchBtn"),
      torchBtn: document.getElementById("torchBtn"),
      zoomInBtn: document.getElementById("zoomInBtn"),
      zoomOutBtn: document.getElementById("zoomOutBtn"),
      rotateBtn: document.getElementById("rotateBtn"),
      select: document.getElementById("cameraSelect"),
      videoWrap: document.getElementById("videoWrap"),
      state: document.getElementById("camState"),
      detected: document.getElementById("detected"),
      error: document.getElementById("error"),
      count: document.getElementById("count"),
      median: document.getElementById("median"),
      iqr: document.getElementById("iqr"),
      manual: document.getElementById("manual"),
      lookupBtn: document.getElementById("lookupBtn"),
      results: document.getElementById("results"),
    };

    this.camera = new CameraController(this.els.videoWrap, this.els.select);
    this.camera.wrapper.onHit = (code) => this.onHit(code);
    this.camera.onStatus = (s) => {
      this.els.state.textContent = s;
    };

    this.bindUI();
  }

  bindUI() {
    this.els.start.onclick = () => {
      this.start();
    };
    this.els.stop.onclick = () => {
      this.stop();
    };
    this.els.switchBtn.onclick = () => {
      this.switchCamera();
    };
    this.els.lookupBtn.onclick = () => {
      const v = normalizeInputCode(this.els.manual.value.trim());
      if (v) this.lookupWithStatus(v);
    };
    this.els.manual.onkeydown = (e) => {
      if (e.key === "Enter") this.els.lookupBtn.click();
    };

    this.els.torchBtn.onclick = () => {
      this.camera.wrapper.toggleTorch();
    };
    this.els.zoomInBtn.onclick = () => {
      this.camera.wrapper.zoomIn();
    };
    this.els.zoomOutBtn.onclick = () => {
      this.camera.wrapper.zoomOut();
    };
    this.els.rotateBtn.onclick = () => {
      this.els.videoWrap.classList.toggle("rot90");
    };

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.stop();
    });
  }

  async start() {
    this.clearError();
    try {
      await this.camera.start();
    } catch (e) {
      this.showError(
        "Camera failed to start: " + String(e && e.message ? e.message : e)
      );
    }
  }

  stop() {
    this.camera.stop();
  }

  async switchCamera() {
    this.clearError();
    try {
      await this.camera.switchCamera();
    } catch (e) {
      this.showError(
        "Switch camera failed: " + String(e && e.message ? e.message : e)
      );
    }
  }

  async onHit(code) {
    this.els.detected.textContent = "Detected: " + code;
    try {
      await this.lookupWithStatus(code);
    } catch (e) {
      this.showError(
        "Lookup failed: " + String(e && e.message ? e.message : e)
      );
    }
  }

  async lookupWithStatus(q) {
    this.clearError();
    setStatus("⏳", "queued");
    await Promise.resolve();
    try {
      setStatus("🔎", "fetching");
      const data = await PriceEstimator.estimate(q);
      setStatus("📈", "calculating");
      const { itemsForTable, stats, note } = unpackEstimateResponse(data);

      let rows = Array.isArray(itemsForTable) ? itemsForTable : [];

      // Local fallback: if API gave nothing and q looks like a UPC/EAN with valid checksum
      if (rows.length === 0 && isValidGTIN(q)) {
        try {
          const localRows = await localLookupByUPC(q);
          if (localRows.length) {
            rows = localRows;

            // recompute minimal stats for local rows
            const vals = rows
              .map((r) => r.price)
              .filter(Number.isFinite)
              .sort((a, b) => a - b);
            const qf = (p) => {
              const i = (vals.length - 1) * p;
              const lo = Math.floor(i);
              const hi = Math.ceil(i);
              return (vals[lo] + vals[hi]) / 2;
            };
            const localStats = {
              count: vals.length,
              median: qf(0.5),
              p25: qf(0.25),
              p75: qf(0.75),
            };

            this.els.count.textContent = String(localStats.count);
            this.els.median.textContent = usd(localStats.median);
            this.els.iqr.textContent =
              usd(localStats.p25) + "–" + usd(localStats.p75);
            this.els.detected.textContent =
              (note ? note + " | " : "") + "Local UPC match";
          }
        } catch (e) {
          // don't fail the run if local file is missing; just log
          Logger.warn(
            "local beanies.json lookup failed",
            String(e && e.message ? e.message : e)
          );
        }
      }

      // If we didn’t use local, display API stats as before
      if (
        rows.length &&
        this.els.detected.textContent.indexOf("Local UPC match") === -1
      ) {
        this.els.count.textContent = String(stats.count || rows.length || 0);
        this.els.median.textContent = usd(stats.median);
        this.els.iqr.textContent = usd(stats.p25) + "–" + usd(stats.p75);
        this.els.detected.textContent = note || "Done";
      }

      // Render whatever we ended up with
      this.renderRows(rows);
      setStatus("🏁", "done");
    } catch (e) {
      setStatus("❌", "error");
      this.showError(
        "Lookup failed: " + (e && e.message ? e.message : String(e))
      );
    }
  }

  renderRows(items) {
    this.els.results.innerHTML = "";
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" +
        it.title +
        "</td>" +
        "<td class='price'>" +
        usd(it.price) +
        "</td>" +
        "<td>" +
        (it.condition || "") +
        "</td>" +
        "<td>" +
        (it.url
          ? "<a href='" + it.url + "' target='_blank' rel='noreferrer'>Open</a>"
          : "") +
        "</td>" +
        "<td>" +
        (it.source || "") +
        "</td>";
      this.els.results.appendChild(tr);
    }
  }

  showError(msg) {
    this.els.error.textContent = msg;
    this.els.error.style.display = "block";
  }
  clearError() {
    this.els.error.textContent = "";
    this.els.error.style.display = "none";
  }
}

async function initCameraUI() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    app.els.start.disabled = true;
    app.els.stop.disabled = true;
    app.els.switchBtn.disabled = true;
    app.els.torchBtn.disabled = true;
    app.els.zoomInBtn.disabled = true;
    app.els.zoomOutBtn.disabled = true;
    app.els.rotateBtn.disabled = true;
    app.showError("Camera API not supported in this browser");
    return;
  }
  try {
    await app.camera.populateDevices();
  } catch (e) {
    app.showError(
      "Failed to enumerate cameras: " + String(e && e.message ? e.message : e)
    );
  }
}

function initLookupUI() {
  try {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q") || params.get("query") || "";
    if (q) {
      app.els.manual.value = q;
      if (typeof app.lookupWithStatus === "function") app.lookupWithStatus(q);
      else document.getElementById("lookupBtn")?.click(); // fallback
    }
  } catch (_) {}
}
/** ---------- Local beanies.json fallback ---------- */
let __BEANIES_INDEX = null;

/**
 * Load and index /beanies.json by UPC, de-duping by sku.
 * Returns a Map<upc, Array<{title,price,condition?,url?,source}>> ready for the table.
 */
async function loadBeaniesIndex() {
  if (__BEANIES_INDEX) return __BEANIES_INDEX;
  const res = await fetch("/beanies.json", { cache: "reload" });
  if (!res.ok) throw new Error("Failed to load beanies.json: " + res.status);
  const raw = await res.json();

  const byUpc = new Map();
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] || {};
    const upc = String(r.upc || "").replace(/\D/g, "");
    if (!upc) continue;

    const arr = byUpc.get(upc) || [];
    if (arr.some((x) => x.__sku === r.sku)) continue;

    const priceNum = Number(String(r.we_pay || "").replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(priceNum)) continue;

    arr.push({
      title: r.name || r.sku || "Beanie (local)",
      price: priceNum,
      condition: undefined,
      url: r.url || r.icollect_url || undefined,
      source: "local",
      __sku: r.sku || undefined,
    });
    byUpc.set(upc, arr);
  }
  __BEANIES_INDEX = byUpc;
  return byUpc;
}

/**
 * Lookup local rows by UPC (returns [] if none). Requires clean, checksum-valid GTIN.
 * @param {string} upc
 */
async function localLookupByUPC(upc) {
  const s = String(upc || "").replace(/\D/g, "");
  if (!s || !isValidGTIN(s)) return [];
  const idx = await loadBeaniesIndex();
  const rows = idx.get(s) || [];
  return rows.map((r) => ({
    title: r.title,
    price: r.price,
    condition: r.condition,
    url: r.url,
    source: r.source,
  }));
}

document.addEventListener("DOMContentLoaded", () => {
  app = new App(); // Kick it
  initCameraUI();
  initLookupUI();
});
