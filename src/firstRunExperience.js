import { createSurfaceKeyboard } from './ui/surfaceKeyboard.js';

// 首次啟動任務引導面板（First-run mission launcher）
//
// 本地圖在每次造訪時刻意不自動啟用所有即時資料串流：
// 這樣做是為了避免消耗可選的 API 配額、避免干擾回訪操作員，並避免破壞分享連結的視圖。
// 新訪客在啟動後會獲得一次緊湊且明確的任務選擇體驗。

/** 長期偏好設定抑制。僅在勾選「不再顯示此引導」時寫入。 */
export const FIRST_RUN_STORAGE_KEY = 'gev:first-run-mission:v1';
/** 單次工作階段關閉紀錄。任何關閉途徑皆會寫入；限定於 sessionStorage。 */
export const FIRST_RUN_SESSION_KEY = 'gev:first-run-mission-session:v1';

/**
 * 環境監測任務的自訂標籤選項。
 * @type {'ENVIRONMENTAL'|'EARTH_WATCH'|'ACTIVE_EVENTS'}
 */
export const ENVIRONMENTAL_LABEL_CHOICE = 'ENVIRONMENTAL';

const ENVIRONMENTAL_LABELS = Object.freeze({
  ENVIRONMENTAL: Object.freeze({ title: '環境監控' }),
  EARTH_WATCH: Object.freeze({ title: '地球監測' }),
  ACTIVE_EVENTS: Object.freeze({ title: '即時事件' }),
});

/**
 * @param {string} [choice]
 * @returns {{title: string}} 取得對應常數所選取的標籤設定。
 */
export function environmentalLabel(choice = ENVIRONMENTAL_LABEL_CHOICE) {
  return ENVIRONMENTAL_LABELS[choice] || ENVIRONMENTAL_LABELS.ENVIRONMENTAL;
}

/** @type {Readonly<Record<string, object>>} */
export const FIRST_RUN_MISSIONS = Object.freeze({
  contacts: Object.freeze({
    kind: 'context',
    contextMode: 'contacts',
    busyText: '正在啟動即時目標追蹤…',
  }),
  'space-missions': Object.freeze({
    kind: 'context',
    contextMode: 'space-missions',
    busyText: '正在開啟太空任務動態…',
  }),
  environmental: Object.freeze({
    kind: 'globe',
    layerIds: Object.freeze(['earthquakes', 'local-firms']),
    busyText: '正在掃描全球即時事件…',
  }),
  explore: Object.freeze({ kind: 'none' }),
});

/**
 * 解析 Web Storage 儲存區，避免在隱私模式下拋出異常。
 * @param {'local'|'session'} kind
 * @param {object|null|undefined} injected
 * @returns {{getItem?: Function, setItem?: Function, removeItem?: Function}|null}
 */
function resolveStore(kind, injected) {
  if (injected !== undefined) return injected;
  try {
    return kind === 'session'
      ? globalThis.sessionStorage
      : globalThis.localStorage;
  } catch {
    return null;
  }
}

/** 讀取單一鍵值，將任何異常視為「未存儲」。 */
function readStored(kind, injected, key) {
  try {
    return resolveStore(kind, injected)?.getItem?.(key) ?? null;
  } catch {
    return null;
  }
}

/** 寫入單一鍵值，安全防護不中斷。 */
function writeStored(kind, injected, key, value) {
  try {
    const store = resolveStore(kind, injected);
    if (typeof store?.setItem !== 'function') return false;
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** 移除單一鍵值。 */
function removeStored(kind, injected, key) {
  try {
    const store = resolveStore(kind, injected);
    if (typeof store?.removeItem !== 'function') return false;
    store.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * 判斷當前頁面載入是否應顯示首次引導視窗。
 * @param {object} input
 * @returns {boolean}
 */
export function shouldShowFirstRun({
  hasShareState = false,
  storage,
  sessionStorageRef,
  location = globalThis.location,
} = {}) {
  if (hasShareState) return false;
  const params = new URLSearchParams(location?.search || '');
  if (params.get('welcome') === '0') return false;
  if (params.get('welcome') === '1') return true;
  if (readStored('local', storage, FIRST_RUN_STORAGE_KEY) === 'suppressed')
    return false;
  if (
    readStored('session', sessionStorageRef, FIRST_RUN_SESSION_KEY) ===
    'dismissed'
  )
    return false;
  return true;
}

/**
 * 寫入（或清除）長期的「不再顯示此引導」設定。
 * @param {boolean} suppressed
 * @param {{setItem: Function, removeItem?: Function}|null} [storage]
 * @returns {boolean}
 */
export function setFirstRunSuppressed(suppressed, storage) {
  return suppressed
    ? writeStored('local', storage, FIRST_RUN_STORAGE_KEY, 'suppressed')
    : removeStored('local', storage, FIRST_RUN_STORAGE_KEY);
}

/**
 * 記錄當前瀏覽器工作階段已關閉引導視窗。
 * @param {{setItem: Function}|null} [sessionStorageRef]
 * @returns {void}
 */
export function rememberFirstRunSessionDismissed(sessionStorageRef) {
  writeStored('session', sessionStorageRef, FIRST_RUN_SESSION_KEY, 'dismissed');
}

/**
 * 執行所選任務並配置系統狀態。
 * @param {string} choice
 * @param {object} deps
 * @returns {Promise<{ok: boolean, choice: string, result?: object, failedLayerIds?: string[]}>}
 */
export async function runFirstRunChoice(
  choice,
  { setContextMode, setLayerEnabled, flyToGlobe },
) {
  const mission = FIRST_RUN_MISSIONS[choice];
  if (!mission) return { ok: false, choice };
  if (mission.kind === 'none') return { ok: true, choice };
  if (mission.kind === 'context') {
    const result = await setContextMode(mission.contextMode);
    return { ok: Boolean(result?.ok), choice, result };
  }

  const flight = Promise.resolve()
    .then(() => flyToGlobe())
    .catch(() => null);
  const outcomes = await Promise.all(
    mission.layerIds.map(async (layerId) => {
      try {
        return { layerId, ok: (await setLayerEnabled(layerId)) !== false };
      } catch {
        return { layerId, ok: false };
      }
    }),
  );
  await flight;
  const failedLayerIds = outcomes
    .filter((entry) => !entry.ok)
    .map((entry) => entry.layerId);
  return { ok: failedLayerIds.length === 0, choice, failedLayerIds };
}

/** 獨佔畫面的 Class 名稱清單。 */
export const EXCLUSIVE_SURFACE_CLASSES = Object.freeze([
  'cockpit-mode',
  'scene-playback-mode',
  'recording-mode',
  'ui-clean-view',
]);

/**
 * 檢查是否有其他介面層正在獨佔畫面。
 * @param {Document} [documentRef]
 * @returns {boolean}
 */
export function exclusiveSurfaceActive(documentRef = globalThis.document) {
  const list = documentRef?.body?.classList;
  if (!list) return false;
  return EXCLUSIVE_SURFACE_CLASSES.some((name) => list.contains(name));
}

/**
 * 初始化並顯示任務引導視窗。
 * @param {object} input
 * @returns {null|{dismiss: Function}}
 */
export function initFirstRunExperience({
  styleManager,
  dataManager = styleManager?._dataManager,
  documentRef = globalThis.document,
  storage,
  sessionStorageRef,
  location = globalThis.location,
} = {}) {
  const root = documentRef?.getElementById?.('first-run-launcher');
  if (!root || root.dataset.initialized === 'true') return null;
  root.dataset.initialized = 'true';

  if (
    !shouldShowFirstRun({
      hasShareState: styleManager?.hasShareState,
      storage,
      sessionStorageRef,
      location,
    })
  ) {
    root.remove();
    return null;
  }

  const environmentalTitle = root.querySelector(
    '[data-first-run-environmental-title]',
  );
  if (environmentalTitle)
    environmentalTitle.textContent = environmentalLabel().title;

  const status = root.querySelector('[data-first-run-status]');
  const suppressBox = root.querySelector('[data-first-run-suppress]');
  const buttons = [...root.querySelectorAll('[data-first-run-choice]')];
  const defaultStatus = status?.textContent || '';
  let busy = false;
  let closing = false;

  const coveredByOverlay = () => {
    if (typeof documentRef.elementFromPoint !== 'function') return false;
    const rect = root.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    try {
      const hit = documentRef.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return Boolean(hit) && !root.contains(hit);
    } catch {
      return false;
    }
  };

  const isTopmost = () =>
    root.isConnected &&
    root.classList.contains('visible') &&
    root.getClientRects().length > 0 &&
    !coveredByOverlay();

  const dismiss = ({ restoreFocus = true } = {}) => {
    if (closing) return;
    closing = true;
    rememberFirstRunSessionDismissed(sessionStorageRef);
    root.classList.remove('visible');
    root.setAttribute('aria-hidden', 'true');
    globalThis.removeEventListener?.('resize', onViewportResize);
    surfaceObserver?.disconnect();
    const remove = () => root.remove();
    root.addEventListener('transitionend', remove, { once: true });
    globalThis.setTimeout?.(remove, 400);
    keyboard.deactivate({ restoreFocus });
  };

  const setBusy = (next, choice = '') => {
    busy = next;
    root.dataset.state = next ? 'loading' : 'ready';
    root.setAttribute('aria-busy', String(next));
    for (const button of buttons)
      button.setAttribute('aria-disabled', String(next));
    if (!status) return;
    if (next)
      status.textContent = FIRST_RUN_MISSIONS[choice]?.busyText || '處理中…';
    else if (status.dataset.sticky !== 'true')
      status.textContent = defaultStatus;
  };

  const onChoice = async (event) => {
    if (busy || closing) return;
    const choice = event.currentTarget?.dataset?.firstRunChoice;
    if (!FIRST_RUN_MISSIONS[choice]) return;
    if (status) delete status.dataset.sticky;
    setBusy(true, choice);
    let outcome = null;
    try {
      outcome = await runFirstRunChoice(choice, {
        setContextMode: async (mode) => {
          const result = await styleManager.setContextMode(mode);
          if (result?.ok) {
            styleManager.setPanelCollapsed?.('global-context-panel', false, {
              explicit: true,
            });
          }
          return result;
        },
        setLayerEnabled: (layerId) =>
          dataManager.setEnabled(layerId, true, { origin: 'user' }),
        flyToGlobe: () => styleManager.resetToGlobeView(),
      });
    } catch (error) {
      console.warn('[First run] 任務啟動失敗:', error);
    }
    if (closing) return;
    if (outcome?.ok) {
      dismiss();
      return;
    }
    const failed = outcome?.failedLayerIds?.length
      ? outcome.failedLayerIds
      : outcome?.result?.failedLayerIds;
    const detail =
      Array.isArray(failed) && failed.length ? ` (${failed.join(', ')})` : '';
    if (status) {
      status.dataset.sticky = 'true';
      status.textContent = `無法開啟該任務${detail}。請重試或改採手動探索。`;
    }
    setBusy(false);
  };

  const onSuppressChange = (event) => {
    const box = event.currentTarget;
    const wanted = Boolean(box?.checked);
    if (setFirstRunSuppressed(wanted, storage)) return;
    if (box) box.checked = !wanted;
    if (!status) return;
    status.dataset.sticky = 'true';
    status.textContent =
      '瀏覽器已封鎖本機儲存空間，因此無法保存偏好設定。';
  };

  const keyboard = createSurfaceKeyboard({
    root,
    documentRef,
    isActive: () => !closing && isTopmost(),
    onEscape: () => dismiss(),
    fallbackFocus: () => documentRef.body,
  });

  for (const button of buttons) button.addEventListener('click', onChoice);
  suppressBox?.addEventListener('change', onSuppressChange);
  keyboard.activate();

  const choiceList = root.querySelector('.first-run-choices');
  const syncScrollAffordance = () => {
    if (!choiceList) return;
    const overflows = choiceList.scrollHeight > choiceList.clientHeight + 1;
    choiceList.dataset.scrollable = String(overflows);
  };

  let revealed = false;
  const reveal = () => {
    if (revealed || closing) return;
    revealed = true;
    root.hidden = false;
    globalThis.requestAnimationFrame?.(() => {
      if (closing) return;
      root.classList.add('visible');
      syncScrollAffordance();
      buttons[0]?.focus?.({ preventScroll: true });
    });
  };

  const yieldToExclusiveSurface = () => {
    if (closing) return;
    dismiss({ restoreFocus: false });
  };

  const syncToExclusiveSurfaces = () => {
    if (closing) return;
    const blocked = exclusiveSurfaceActive(documentRef);
    if (revealed && blocked) yieldToExclusiveSurface();
    else if (!revealed && !blocked) reveal();
  };

  const onViewportResize = () => syncScrollAffordance();
  globalThis.addEventListener?.('resize', onViewportResize);

  const surfaceObserver =
    typeof globalThis.MutationObserver === 'function'
      ? new globalThis.MutationObserver(syncToExclusiveSurfaces)
      : null;
  if (documentRef.body) {
    surfaceObserver?.observe(documentRef.body, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
  syncToExclusiveSurfaces();

  const destroy = () => {
    closing = true;
    keyboard.destroy();
    globalThis.removeEventListener?.('resize', onViewportResize);
    surfaceObserver?.disconnect();
    root.remove();
  };
  return { dismiss, isTopmost, destroy };
}