import { applicationServices } from './services/application.js';
/**
 * @module hud
 * @description 情報 HUD 覆蓋層 — 衛星戰術情報風格 (繁體中文在地化版)
 */

import * as Cesium from 'cesium';
import { forward as toMGRS } from 'mgrs';
import { CITY_POIS } from './locations.js';
import { composeLocalityTag } from './hudLocality.js';
import {
  ellipsoidalToMslDisplayM,
  ensureGeoidReady,
  geoidHeight,
} from './data/geoid.js';
import { getBasemapLabelContext } from './voice/gevActions.js';
import { isHudSummaryUnconfigured } from './hudSummaryResponse.js';

/** Color palettes keyed by shader mode; applied as CSS custom properties. */
const HUD_COLORS = {
  surveillance: {
    main: 'rgba(51, 255, 51, 0.8)',
    glow: 'rgba(51, 255, 51, 0.5)',
    border: 'rgba(51, 255, 51, 0.2)',
  },
  thermal: {
    main: 'rgba(255, 255, 255, 0.7)',
    glow: 'rgba(255, 255, 255, 0.4)',
    border: 'rgba(255, 255, 255, 0.15)',
  },
  retro: {
    main: 'rgba(255, 170, 0, 0.8)',
    glow: 'rgba(255, 170, 0, 0.5)',
    border: 'rgba(255, 170, 0, 0.2)',
  },
  _default: {
    main: 'rgba(0, 255, 255, 0.6)',
    glow: 'rgba(0, 255, 255, 0.4)',
    border: 'rgba(0, 255, 255, 0.15)',
  },
};

const MILITARY_STYLES = new Set(['retro', 'surveillance', 'thermal']);
const HUD_VARIANTS = new Set(['tactical', 'operator', 'minimal']);
const HUD_SUMMARY_INTERVAL_MS = 15000;
const HUD_GEOID_CELL_DEG = 0.01;

const NEARBY_POINTS = Object.values(CITY_POIS).flatMap((city) =>
  city.pois.map((poi) => ({
    city: city.name,
    poi: poi.name,
    lat: poi.lat,
    lon: poi.lon,
  })),
);

export class IntelHUD {
  constructor(
    viewer,
    {
      placeSearch,
      summaryPolicy = {},
      basemapContext = {},
      summaryService = applicationServices.summary,
    } = {},
  ) {
    this.summaryService = summaryService;
    this.summaryPolicy = summaryPolicy;
    this.basemapContext = basemapContext;
    this.placeSearch = placeSearch;
    this.viewer = viewer;
    this._visible = false;
    this._autoMode = true;
    this._currentStyle = 'normal';
    this._el = null;
    this._variant = 'tactical';
    this._recBlinkState = true;
    this._updateInterval = null;
    this._recBlinkInterval = null;
    this._timestampInterval = null;
    this._summaryInterval = null;
    this._summaryTypingInterval = null;
    this._latestMetrics = null;
    this._dataManager = null;
    this._dataManagerUnsubscribe = null;
    this._summaryDirty = true;
    this._summaryRequest = null;
    this._lastSummarySignature = '';
    this._summaryRevision = 0;
    this._firstMetricsShown = false;
    this._firstSummaryKicked = false;
    this._geoidRequested = false;
    this._geoidReady = false;
    this._geoidCellKey = null;
    this._geoidN = null;
    this._geoidCorrectionApplied = false;

    this._onCameraMoveEnd = () => {
      this._markSummaryDirty();
      if (this._visible) {
        this._updateCameraData();
        this._setSummaryText(this._composeSummary(), false);
      }
      if (!this._firstSummaryKicked && this._visible && this._latestMetrics) {
        this._firstSummaryKicked = true;
        void this._updateSummary(true, true);
      }
    };

    this._missionId = `KH11-${4000 + Math.floor(Math.random() * 200)}`;
    this._sensorId = `OPS-${4100 + Math.floor(Math.random() * 100)}`;
    this._orbitNum = 47000 + Math.floor(Math.random() * 1000);
    this._passNum = 100 + Math.floor(Math.random() * 200);

    this._buildDOM();
    this.viewer.camera.moveEnd.addEventListener(this._onCameraMoveEnd);
    this._startTimers();
  }

  _buildDOM() {
    this._el = document.getElementById('intel-hud');
    if (!this._el) return;

    this._el.innerHTML = `
      <div class="hud-top-bar">
        <span class="hud-top-bar-left">極機密 // 情報特種限制 // 嚴禁外洩</span>
        <span class="hud-top-bar-center">${this._missionId}</span>
        <span class="hud-top-bar-right">頁次 1/1</span>
      </div>

      <div class="hud-corner hud-top-left">
        <div class="hud-bracket">┌</div>
        <div class="hud-content">
          <div class="hud-classification">極機密 // 情報特種限制 // 嚴禁外洩</div>
          <div class="hud-system">${this._missionId}  ${this._sensorId}</div>
          <div class="hud-mode" id="hud-mode">標準模式</div>
          <div class="hud-summary-wrap">
            <div class="hud-summary-label">情資摘要</div>
            <div class="hud-summary" id="hud-summary">等待遙測訊號傳回...</div>
          </div>
        </div>
      </div>

      <div class="hud-corner hud-top-right">
        <div class="hud-content" style="text-align:right">
          <div class="hud-rec"><span id="hud-rec-dot">●</span> 即時錄製  <span id="hud-timestamp">2026-01-01 00:00:00Z</span></div>
          <div class="hud-orbital">軌道編號: ${this._orbitNum}  過頂: 降軌-${this._passNum}</div>
        </div>
        <div class="hud-bracket">┐</div>
      </div>

      <div class="hud-corner hud-bottom-left">
        <div class="hud-bracket">└</div>
        <div class="hud-content">
          <div id="hud-mgrs">軍用座標 (MGRS): ---</div>
          <div id="hud-latlon">--°--'--"北 ---°--'--"西</div>
        </div>
      </div>

      <div class="hud-corner hud-bottom-right">
        <div class="hud-content" style="text-align:right">
          <div id="hud-gsd">地面解析 (GSD): --m  影像判讀 (NIIRS): --</div>
          <div id="hud-alt">海平面高度: --m   太陽仰角: --°</div>
          <div id="hud-ais-vessel" class="hud-ais-vessel">海事船舶 (AIS): --</div>
        </div>
        <div class="hud-bracket">┘</div>
      </div>

      <div class="hud-edge hud-left-edge">
        <div id="hud-coll">獲取時間: --:--:--Z</div>
        <div id="hud-ona">離天頂角 (ONA): --°</div>
      </div>

      <div class="hud-edge hud-right-edge">
        <div>頻段: 全色態 (PAN)</div>
        <div>位元: 11</div>
        <div>處理等級: 1A</div>
      </div>

      <div class="hud-bottom-bar">
        <span id="hud-bottom-line">緯度: --  經度: --  軍用座標: ---</span>
      </div>
    `;
    this._el.dataset.variant = this._variant;
  }

  _startTimers() {
    this._timestampInterval = setInterval(() => {
      const el = document.getElementById('hud-timestamp');
      if (el) el.textContent = this._formatUTC();
    }, 1000);

    this._recBlinkInterval = setInterval(() => {
      this._recBlinkState = !this._recBlinkState;
      const dot = document.getElementById('hud-rec-dot');
      if (dot)
        dot.style.visibility = this._recBlinkState ? 'visible' : 'hidden';
    }, 800);

    this._updateInterval = setInterval(() => {
      if (!this._visible) return;
      this._updateCameraData();
    }, 250);

    this._summaryInterval = setInterval(() => {
      if (!this._visible) return;
      void this._updateSummary(true);
    }, HUD_SUMMARY_INTERVAL_MS);
  }

  _formatUTC() {
    const now = new Date();
    const y = now.getUTCFullYear();
    const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    const h = String(now.getUTCHours()).padStart(2, '0');
    const mi = String(now.getUTCMinutes()).padStart(2, '0');
    const s = String(now.getUTCSeconds()).padStart(2, '0');
    return `${y}-${mo}-${d} ${h}:${mi}:${s}Z`;
  }

  _geoidUndulationM(latDeg, lonDeg) {
    if (!this._geoidReady) {
      if (!this._geoidRequested) {
        this._geoidRequested = true;
        ensureGeoidReady()
          .then(() => {
            this._geoidReady = true;
          })
          .catch(() => {});
      }
      return null;
    }
    const key = `${Math.round(latDeg / HUD_GEOID_CELL_DEG)}:${Math.round(lonDeg / HUD_GEOID_CELL_DEG)}`;
    if (key !== this._geoidCellKey) {
      try {
        this._geoidN = geoidHeight(latDeg, lonDeg);
      } catch {
        this._geoidN = null;
      }
      this._geoidCellKey = key;
    }
    return Number.isFinite(this._geoidN) ? this._geoidN : null;
  }

  _updateCameraData() {
    const camera = this.viewer.camera;
    const cartographic = camera.positionCartographic;
    if (!cartographic) return;

    const lonDeg = Cesium.Math.toDegrees(cartographic.longitude);
    const latDeg = Cesium.Math.toDegrees(cartographic.latitude);
    const altM = cartographic.height;
    const latDMS = this._toDMS(latDeg, 'lat');
    const lonDMS = this._toDMS(lonDeg, 'lon');
    let mgrsLabel = '---';

    try {
      const mgrsStr = toMGRS([lonDeg, latDeg], 4);
      const formatted = this._formatMGRS(mgrsStr);
      mgrsLabel = formatted;
      const el = document.getElementById('hud-mgrs');
      if (el) el.textContent = `軍用座標: ${formatted}`;
    } catch {
      const el = document.getElementById('hud-mgrs');
      if (el) el.textContent = '軍用座標: ---';
    }

    const llEl = document.getElementById('hud-latlon');
    if (llEl) llEl.textContent = `${latDMS} ${lonDMS}`;
    const bottomEl = document.getElementById('hud-bottom-line');
    if (bottomEl) {
      bottomEl.textContent = `軍用座標: ${mgrsLabel}  緯度: ${latDMS}  經度: ${lonDMS}`;
    }

    const gsd = Math.max(0.01, altM * 0.000375);
    const gsdInches = gsd * 39.37;
    const niirs = Math.max(
      0,
      Math.min(9, 10.25 - 3.32 * Math.log10(gsdInches)),
    );
    const gsdEl = document.getElementById('hud-gsd');
    if (gsdEl)
      gsdEl.textContent = `地面解析: ${gsd.toFixed(2)}m  影像判讀: ${niirs.toFixed(1)}`;

    const altEl = document.getElementById('hud-alt');
    const geoidN = this._geoidUndulationM(latDeg, lonDeg);
    const altMslM = ellipsoidalToMslDisplayM(altM, geoidN);
    const sunEl = this._estimateSunElevation(latDeg, lonDeg);
    if (altEl)
      altEl.textContent = `高度: ${Math.round(altMslM)}m   太陽仰角: ${sunEl.toFixed(1)}°`;

    const collEl = document.getElementById('hud-coll');
    if (collEl) {
      const now = new Date();
      const h = String(now.getUTCHours()).padStart(2, '0');
      const m = String(now.getUTCMinutes()).padStart(2, '0');
      const s = String(now.getUTCSeconds()).padStart(2, '0');
      collEl.textContent = `獲取時間: ${h}:${m}:${s}Z`;
    }

    const pitchDeg = Cesium.Math.toDegrees(camera.pitch);
    const ona = Math.max(0, 90 + pitchDeg);
    const onaEl = document.getElementById('hud-ona');
    if (onaEl) onaEl.textContent = `離天頂角: ${ona.toFixed(1)}°`;

    this._latestMetrics = {
      latDeg,
      lonDeg,
      altM,
      altMslM,
      sunEl,
      ona,
    };

    if (!this._firstMetricsShown) {
      this._firstMetricsShown = true;
      this._setSummaryText(this._composeSummary(), false);
    }

    const geoidCorrectionApplied = Number.isFinite(geoidN);
    if (geoidCorrectionApplied !== this._geoidCorrectionApplied) {
      this._geoidCorrectionApplied = geoidCorrectionApplied;
      this._markSummaryDirty();
      this._setSummaryText(this._composeSummary(), false);
    }
  }

  _formatMGRS(mgrs) {
    const match = mgrs.match(/^(\d{1,2}[A-Z])\s*([A-Z]{2})\s*(\d+)$/);
    if (!match) return mgrs;
    const [, zone, square, coords] = match;
    const half = coords.length / 2;
    const easting = coords.slice(0, half);
    const northing = coords.slice(half);
    return `${zone} ${square} ${easting} ${northing}`;
  }

  _toDMS(decimal, type) {
    const abs = Math.abs(decimal);
    const deg = Math.floor(abs);
    const minFloat = (abs - deg) * 60;
    const min = Math.floor(minFloat);
    const sec = ((minFloat - min) * 60).toFixed(2);

    let dir;
    if (type === 'lat') dir = decimal >= 0 ? '北' : '南';
    else dir = decimal >= 0 ? '東' : '西';

    const degStr =
      type === 'lon'
        ? String(deg).padStart(3, '0')
        : String(deg).padStart(2, '0');
    return `${degStr}°${String(min).padStart(2, '0')}'${String(sec).padStart(5, '0')}"${dir}`;
  }

  _estimateSunElevation(lat, lon) {
    const now = new Date();
    const hours = now.getUTCHours() + now.getUTCMinutes() / 60 + lon / 15;
    const solarNoon = 12;
    const hourAngle = (hours - solarNoon) * 15;
    const declination =
      23.45 *
      Math.sin(
        Cesium.Math.toRadians(
          (360 / 365) * (now.getUTCDate() + 30 * now.getUTCMonth() - 81),
        ),
      );
    const latRad = Cesium.Math.toRadians(lat);
    const decRad = Cesium.Math.toRadians(declination);
    const haRad = Cesium.Math.toRadians(hourAngle);
    const sinEl =
      Math.sin(latRad) * Math.sin(decRad) +
      Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad);
    return Cesium.Math.toDegrees(Math.asin(Math.max(-1, Math.min(1, sinEl))));
  }

  _viewBand(altM) {
    if (altM < 1200) return '街道層級';
    if (altM < 5000) return '市區層級';
    if (altM < 30000) return '都會層級';
    if (altM < 250000) return '區域層級';
    return '全球視野';
  }

  _regionLabel(lat, lon) {
    if (lat > 72) return '北極地區';
    if (lat < -60) return '南極地區';
    if (lat >= 5 && lat <= 83 && lon >= -170 && lon <= -50)
      return '北美洲';
    if (lat >= -60 && lat <= 15 && lon >= -90 && lon <= -30)
      return '南美洲';
    if (lat >= 34 && lat <= 72 && lon >= -25 && lon <= 45) return '歐洲';
    if (lat >= -35 && lat <= 38 && lon >= -20 && lon <= 55) return '非洲';
    if (lat >= 5 && lat <= 80 && lon >= 45 && lon <= 180) return '亞洲';
    if (lat >= -50 && lat <= 5 && lon >= 110 && lon <= 180) return '大洋洲';
    return lat >= 0 ? '北半球大洋網格' : '南半球大洋網格';
  }

  _viewWindowKm(latDeg) {
    const rect = this.viewer.camera.computeViewRectangle();
    if (!rect) return null;
    const north = Cesium.Math.toDegrees(rect.north);
    const south = Cesium.Math.toDegrees(rect.south);
    let east = Cesium.Math.toDegrees(rect.east);
    let west = Cesium.Math.toDegrees(rect.west);
    let lonSpan = Math.abs(east - west);
    if (lonSpan > 180) lonSpan = 360 - lonSpan;
    const latSpan = Math.abs(north - south);
    const widthKm = Math.max(
      0,
      lonSpan * 111 * Math.cos(Cesium.Math.toRadians(latDeg)),
    );
    const heightKm = Math.max(0, latSpan * 111);
    return { widthKm, heightKm };
  }

  _haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => Cesium.Math.toRadians(deg);
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  _nearestKnownPoint(latDeg, lonDeg) {
    let best = null;
    for (const point of NEARBY_POINTS) {
      const distKm = this._haversineKm(latDeg, lonDeg, point.lat, point.lon);
      if (!best || distKm < best.distKm) {
        best = { ...point, distKm };
      }
    }
    return best;
  }

  _composeSummary() {
    const m = this._latestMetrics;
    if (!m) return '等待遙測訊號傳回...';

    const modeEl = document.getElementById('hud-mode');
    const modeLabel = modeEl?.textContent || '標準模式';
    const region = this._regionLabel(m.latDeg, m.lonDeg);
    const nearest = this._nearestKnownPoint(m.latDeg, m.lonDeg);
    const band = this._viewBand(m.altM);
    const window = this._viewWindowKm(m.latDeg);
    const utcOffset = Math.round(m.lonDeg / 15);
    const localTag = `UTC${utcOffset >= 0 ? '+' : ''}${utcOffset}`;
    const altDisplayM = Number.isFinite(m.altMslM) ? m.altMslM : m.altM;
    const altTag =
      altDisplayM >= 1000
        ? `${(altDisplayM / 1000).toFixed(1)}公里`
        : `${Math.round(altDisplayM)}公尺`;
    const winTag = window
      ? `${Math.max(1, Math.round(window.widthKm))}x${Math.max(1, Math.round(window.heightKm))}公里`
      : '無資料';
    const localityTag = composeLocalityTag(nearest, m.latDeg, m.lonDeg);

    return `${modeLabel} ${band} ${localityTag} | ${region} | 高度: ${altTag} | 視窗: ${winTag} | 太陽仰角: ${m.sunEl.toFixed(0)}° | 離天頂角: ${m.ona.toFixed(0)}° | 時區: ${localTag}`;
  }

  _typeSummary(text) {
    const el = document.getElementById('hud-summary');
    if (!el) return;
    clearInterval(this._summaryTypingInterval);
    let index = 0;
    el.textContent = '';
    this._summaryTypingInterval = setInterval(() => {
      index += 2;
      if (index >= text.length) {
        el.textContent = text;
        clearInterval(this._summaryTypingInterval);
        this._summaryTypingInterval = null;
        return;
      }
      el.textContent = text.slice(0, index);
    }, 24);
  }

  async _updateSummary(animate = false, force = false) {
    const fallbackText = this._composeSummary();
    if (!this._latestMetrics) {
      this._setSummaryText(fallbackText, animate);
      return;
    }
    if (!force && !this._summaryDirty) return;
    if (this.summaryPolicy.canRequest?.() === false) return;

    const revision = this._summaryRevision;
    let context;
    try {
      context = await this._summaryContext();
    } catch (error) {
      console.warn('[HUD] summary context unavailable:', error);
      this._setSummaryText(fallbackText, animate);
      return;
    }
    if (revision !== this._summaryRevision) return;
    const signature = JSON.stringify(context);
    if (!force && signature === this._lastSummarySignature) {
      this._summaryDirty = false;
      return;
    }
    if (this._summaryRequest) return;

    if (force) this._setSummaryText(fallbackText, false);
    this._summaryDirty = false;
    this._lastSummarySignature = signature;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    this._summaryRequest = controller;
    try {
      this.summaryPolicy.onRequest?.();
      const response = await this.summaryService.summarize(context, {
        signal: controller.signal,
      });
      const data = response.data;
      if (revision !== this._summaryRevision) return;
      if (isHudSummaryUnconfigured(response.status, data)) {
        this._setSummaryText(fallbackText, animate);
        return;
      }
      if (!response.ok || !data?.summary) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
      this._setSummaryText(data.summary, animate);
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.warn('[HUD] AI summary unavailable:', error);
        this._lastSummarySignature = null;
        this._summaryDirty = true;
      }
      this._setSummaryText(fallbackText, animate);
    } finally {
      window.clearTimeout(timeout);
      if (this._summaryRequest === controller) this._summaryRequest = null;
    }
  }

  _setSummaryText(text, animate) {
    if (animate) {
      this._typeSummary(text);
      return;
    }
    const el = document.getElementById('hud-summary');
    if (el) el.textContent = text;
  }

  async _summaryContext() {
    const labels = await getBasemapLabelContext(
      this.viewer,
      this.placeSearch,
      this.basemapContext,
    );
    const enabledLayers =
      this._dataManager
        ?.getAll?.()
        ?.filter((layer) => layer.enabled)
        ?.map((layer) => layer.name) || [];
    return {
      placeLabels: labels.placeLabels,
      streetLabels: labels.streetLabels,
      nearbyPlaceLabels: labels.nearbyPlaceLabels,
      enabledLayerLabels: enabledLayers,
    };
  }

  _markSummaryDirty() {
    this._summaryDirty = true;
    this._summaryRevision++;
  }

  onStyleChange(styleName) {
    this._currentStyle = styleName;

    const modeEl = document.getElementById('hud-mode');
    if (modeEl) {
      const modeNames = {
        surveillance: '夜視模式 (NVG)',
        thermal: '紅外熱成像 (FLIR)',
        retro: '戰術監視器 (CRT)',
        normal: '標準模式'
      };
      modeEl.textContent = modeNames[styleName] || styleName.toUpperCase();
    }
    const colors = HUD_COLORS[styleName] || HUD_COLORS._default;
    if (this._el) {
      this._el.style.setProperty('--hud-color', colors.main);
      this._el.style.setProperty('--hud-glow', colors.glow);
      this._el.style.setProperty('--hud-border', colors.border);
    }

    if (this._autoMode) {
      if (MILITARY_STYLES.has(styleName)) {
        this.show();
      } else {
        this.hide();
      }
    }
  }

  show() {
    this._visible = true;
    if (this._el) this._el.classList.add('active');
    this._updateCameraData();
    this._markSummaryDirty();
    void this._updateSummary(false, true);
  }

  hide() {
    this._visible = false;
    if (this._el) this._el.classList.remove('active');
  }

  toggle() {
    if (this._visible) {
      this._autoMode = false;
      this.hide();
    } else {
      this._autoMode = false;
      this.show();
    }
  }

  setMode(mode) {
    if (mode === 'auto') {
      this._autoMode = true;
      this.onStyleChange(this._currentStyle);
      return;
    }

    this._autoMode = false;
    if (mode === 'on') this.show();
    else this.hide();
  }

  setVariant(variantName) {
    const normalized = String(variantName || '').toLowerCase();
    this._variant = HUD_VARIANTS.has(normalized) ? normalized : 'tactical';
    if (this._el) {
      this._el.dataset.variant = this._variant;
    }
  }

  getVariant() {
    return this._variant;
  }

  getMode() {
    if (this._autoMode) return 'auto';
    return this._visible ? 'on' : 'off';
  }

  get visible() {
    return this._visible;
  }

  attachDataManager(dataManager) {
    if (this._dataManagerUnsubscribe) {
      this._dataManagerUnsubscribe();
      this._dataManagerUnsubscribe = null;
    }
    this._dataManager = dataManager || null;
    if (typeof this._dataManager?.subscribe === 'function') {
      this._dataManagerUnsubscribe = this._dataManager.subscribe((change) => {
        if (change?.type === 'visibility') this._markSummaryDirty();
      });
    }
    this._markSummaryDirty();
  }

  destroy() {
    clearInterval(this._updateInterval);
    clearInterval(this._recBlinkInterval);
    clearInterval(this._timestampInterval);
    clearInterval(this._summaryInterval);
    clearInterval(this._summaryTypingInterval);
    this.viewer.camera.moveEnd.removeEventListener(this._onCameraMoveEnd);
    this._dataManagerUnsubscribe?.();
    this._summaryRequest?.abort();
  }
}