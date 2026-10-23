/* offline-download.js
   Progressive offline download manager for Shabdah.

   Allows users to selectively download category assets for offline use.
   Communicates with the service worker for actual caching, and tracks
   download state in localStorage.

   Usage:
     const manager = new OfflineDownloadManager();
     await manager.init();
     await manager.downloadCategory('nature_and_geography');
     const status = manager.getCategoryStatus('nature_and_geography');
*/

const PTW_DOWNLOAD_STATE_KEY = 'ptw_download_state';
const PTW_MANIFEST_URL = './data/offline-manifest.json';

class OfflineDownloadManager {
  constructor() {
    this.manifest = null;
    this.state = this._loadState();
    this.sw = null;
    this.downloadInProgress = null;
    this.listeners = new Set();
  }

  // ── Initialization ─────────────────────────────────────────────

  async init() {
    // Load the offline manifest
    try {
      const res = await fetch(PTW_MANIFEST_URL);
      if (res.ok) {
        this.manifest = await res.json();
        // Check if manifest version changed - invalidate stale state
        if (this.state.manifestVersion && this.state.manifestVersion !== this.manifest.version) {
          console.log('Manifest version changed, resetting download state');
          this.state = this._createFreshState();
          this._saveState();
        }
        this.state.manifestVersion = this.manifest.version;
        this._saveState();
      }
    } catch (err) {
      console.warn('Could not load offline manifest:', err.message);
    }

    // A category left in status 'downloading' at construction time is
    // guaranteed stale: this.downloadInProgress always starts out null (see
    // the constructor), so nothing in THIS instance is driving that
    // download forward, and the service worker has no resume protocol --
    // it only ever reports progress for a request the page just sent. Left
    // alone, the Offline panel showed that category stuck on its last
    // percentage forever (observed: interrupting a download by reloading
    // left it reporting 22% indefinitely, with no way to retry short of
    // manually clearing localStorage), because getCategoryStatus() has no
    // way to tell a genuinely active download from an abandoned one.
    // Resetting it here restores the normal "Download" button so the user
    // can simply start it again.
    let hadStaleDownload = false;
    for (const [categoryId, catState] of Object.entries(this.state.categories)) {
      if (catState.status === 'downloading') {
        delete this.state.categories[categoryId];
        hadStaleDownload = true;
      }
    }
    if (hadStaleDownload) {
      console.warn('Cleared stale in-progress offline download(s) left over from a previous session');
      this._saveState();
    }

    // Get service worker registration.
    // navigator.serviceWorker.ready never rejects -- it just stays pending
    // forever if no worker ever activates (private browsing, a blocked or
    // failed registration, an enterprise policy). Awaiting it bare meant the
    // Offline panel sat on "Loading offline status..." with no error and no
    // way out. Race it so the panel always finishes rendering; without a
    // worker the category list is still informative, the download buttons
    // just report that offline caching isn't available.
    if ('serviceWorker' in navigator) {
      try {
        const reg = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('service worker did not activate')), 5000)),
        ]);
        this.sw = reg.active;

        // Listen for messages from service worker
        navigator.serviceWorker.addEventListener('message', (event) => {
          this._handleSwMessage(event.data);
        });
      } catch (err) {
        console.warn('Service worker not available:', err.message);
      }
    }

    return this;
  }

  // ── Storage Quota Management ───────────────────────────────────

  async checkStorageQuota() {
    if (!navigator.storage?.estimate) {
      return { usage: 0, quota: 0, available: 0, percent: 0, supported: false };
    }

    try {
      const { usage, quota } = await navigator.storage.estimate();
      const available = quota - usage;
      const percent = quota > 0 ? Math.round((usage / quota) * 100) : 0;

      return {
        usage,
        quota,
        available,
        percent,
        supported: true,
        formattedUsage: this._formatBytes(usage),
        formattedQuota: this._formatBytes(quota),
        formattedAvailable: this._formatBytes(available)
      };
    } catch (err) {
      console.warn('Could not estimate storage:', err.message);
      return { usage: 0, quota: 0, available: 0, percent: 0, supported: false };
    }
  }

  async requestPersistentStorage() {
    if (!navigator.storage?.persist) {
      return { persisted: false, supported: false };
    }

    try {
      const persisted = await navigator.storage.persist();
      return { persisted, supported: true };
    } catch (err) {
      console.warn('Could not request persistent storage:', err.message);
      return { persisted: false, supported: true, error: err.message };
    }
  }

  async isPersisted() {
    if (!navigator.storage?.persisted) {
      return false;
    }
    try {
      return await navigator.storage.persisted();
    } catch {
      return false;
    }
  }

  // ── Category Download Operations ───────────────────────────────

  async downloadCategory(categoryId, onProgress) {
    if (!this.manifest) {
      throw new Error('Manifest not loaded');
    }
    if (!this.sw) {
      throw new Error('Service worker not available');
    }
    if (this.downloadInProgress) {
      throw new Error('Download already in progress');
    }

    const category = this.manifest.categories[categoryId];
    if (!category) {
      throw new Error(`Unknown category: ${categoryId}`);
    }

    // Check storage quota
    const quota = await this.checkStorageQuota();
    if (quota.supported && category.totalSize > quota.available) {
      throw new Error(`Insufficient storage: need ${this._formatBytes(category.totalSize)}, have ${quota.formattedAvailable}`);
    }

    // Request persistent storage on first download
    if (!await this.isPersisted()) {
      await this.requestPersistentStorage();
    }

    // Collect all URLs for this category
    const urls = [...category.images, ...category.audio];

    // Update state to downloading
    this.state.categories[categoryId] = {
      status: 'downloading',
      startedAt: new Date().toISOString(),
      progress: 0,
      total: urls.length,
      completed: 0,
      failed: 0
    };
    this._saveState();
    this._notify();

    // Set up progress tracking
    this.downloadInProgress = categoryId;
    this._progressCallback = onProgress;

    // Send download request to service worker
    this.sw.postMessage({
      type: 'PTW_DOWNLOAD_ASSETS',
      payload: { urls, categoryId }
    });
    this._armDownloadStallTimer(categoryId);

    // Return a promise that resolves when download completes
    return new Promise((resolve, reject) => {
      this._downloadResolve = resolve;
      this._downloadReject = reject;
    });
  }

  // If the service worker goes quiet mid-download -- its own fetch loop
  // throws somewhere it doesn't report, the message port gets dropped,
  // whatever -- nothing was ever watching for that, so the category sat on
  // its last-known percentage with the Download button gone and no error,
  // the exact stuck state init() now cleans up from a *previous* session.
  // This catches it live, in the *same* session, by timing out when no
  // PTW_DOWNLOAD_PROGRESS/COMPLETE message has arrived for a while, and
  // failing the download the same way a real error would.
  _armDownloadStallTimer(categoryId) {
    clearTimeout(this._downloadStallTimer);
    this._downloadStallTimer = setTimeout(() => {
      if (this.downloadInProgress === categoryId) {
        this._handleDownloadError({ error: 'Download stalled: no response from the service worker.' });
      }
    }, 20000);
  }

  async downloadAll(onProgress) {
    if (!this.manifest) {
      throw new Error('Manifest not loaded');
    }

    const categoryIds = Object.keys(this.manifest.categories);
    const results = [];

    for (const categoryId of categoryIds) {
      const status = this.getCategoryStatus(categoryId);
      if (status.status === 'downloaded') {
        results.push({ categoryId, skipped: true });
        continue;
      }

      try {
        await this.downloadCategory(categoryId, (progress) => {
          if (onProgress) {
            onProgress({
              categoryId,
              categoryLabel: this.manifest.categories[categoryId].label,
              ...progress
            });
          }
        });
        results.push({ categoryId, success: true });
      } catch (err) {
        results.push({ categoryId, error: err.message });
      }
    }

    return results;
  }

  async clearCategory(categoryId) {
    if (!this.manifest) {
      throw new Error('Manifest not loaded');
    }
    if (!this.sw) {
      throw new Error('Service worker not available');
    }

    const category = this.manifest.categories[categoryId];
    if (!category) {
      throw new Error(`Unknown category: ${categoryId}`);
    }

    const urls = [...category.images, ...category.audio];

    // Send clear request to service worker
    this.sw.postMessage({
      type: 'PTW_CLEAR_CATEGORY',
      payload: { urls, categoryId }
    });

    // Update state
    delete this.state.categories[categoryId];
    this._saveState();
    this._notify();

    // The state update above is already the complete, user-visible result
    // (the category reads as "not downloaded" the instant this returns);
    // this promise exists only so a caller can know the service worker has
    // actually finished evicting the cached files. If that message never
    // arrives -- the worker already went quiet, same failure mode the
    // download stall timer above guards against -- clearAll()'s sequential
    // "await clearCategory()" loop would otherwise hang on this one
    // category forever, with every category after it never getting
    // cleared either. Racing it against a timeout, the same pattern used
    // for navigator.serviceWorker.ready above, means a dead worker can
    // only ever delay "Clear All" by a few seconds, never freeze it.
    return Promise.race([
      new Promise((resolve) => { this._clearResolve = resolve; }),
      new Promise((resolve) => setTimeout(() => resolve({ categoryId, timedOut: true }), 8000)),
    ]);
  }

  async clearAll() {
    const categoryIds = Object.keys(this.state.categories);
    for (const categoryId of categoryIds) {
      await this.clearCategory(categoryId);
    }
  }

  // ── Status Queries ─────────────────────────────────────────────

  getCategoryStatus(categoryId) {
    const catState = this.state.categories[categoryId];

    if (!catState) {
      return {
        status: 'not_downloaded',
        progress: 0
      };
    }

    if (catState.status === 'downloading') {
      const progress = catState.total > 0
        ? Math.round((catState.completed / catState.total) * 100)
        : 0;
      return {
        status: 'downloading',
        progress,
        completed: catState.completed,
        total: catState.total,
        failed: catState.failed
      };
    }

    if (catState.status === 'downloaded') {
      return {
        status: 'downloaded',
        progress: 100,
        downloadedAt: catState.downloadedAt,
        totalFiles: catState.total,
        failedFiles: catState.failed
      };
    }

    return {
      status: catState.status || 'unknown',
      progress: 0
    };
  }

  getAllCategoryStatuses() {
    if (!this.manifest) return {};

    const statuses = {};
    for (const categoryId of Object.keys(this.manifest.categories)) {
      statuses[categoryId] = {
        ...this.getCategoryStatus(categoryId),
        label: this.manifest.categories[categoryId].label,
        totalSize: this.manifest.categories[categoryId].totalSize,
        formattedSize: this._formatBytes(this.manifest.categories[categoryId].totalSize)
      };
    }
    return statuses;
  }

  getOverallProgress() {
    if (!this.manifest) {
      return { downloaded: 0, total: 0, percent: 0 };
    }

    const categoryIds = Object.keys(this.manifest.categories);
    let downloaded = 0;

    for (const categoryId of categoryIds) {
      const status = this.getCategoryStatus(categoryId);
      if (status.status === 'downloaded') {
        downloaded++;
      }
    }

    return {
      downloaded,
      total: categoryIds.length,
      percent: categoryIds.length > 0 ? Math.round((downloaded / categoryIds.length) * 100) : 0
    };
  }

  getTotalDownloadSize() {
    if (!this.manifest) return { total: 0, formatted: '0 B' };

    let total = 0;
    let remaining = 0;

    for (const categoryId of Object.keys(this.manifest.categories)) {
      const cat = this.manifest.categories[categoryId];
      total += cat.totalSize;

      const status = this.getCategoryStatus(categoryId);
      if (status.status !== 'downloaded') {
        remaining += cat.totalSize;
      }
    }

    return {
      total,
      remaining,
      formattedTotal: this._formatBytes(total),
      formattedRemaining: this._formatBytes(remaining)
    };
  }

  // ── Event Listeners ────────────────────────────────────────────

  addListener(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  _notify() {
    const status = {
      categories: this.getAllCategoryStatuses(),
      overall: this.getOverallProgress(),
      downloading: this.downloadInProgress
    };
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (err) {
        console.warn('Listener error:', err);
      }
    }
  }

  // ── Service Worker Message Handling ────────────────────────────

  _handleSwMessage(data) {
    const { type } = data;

    switch (type) {
      case 'PTW_DOWNLOAD_PROGRESS':
        this._handleDownloadProgress(data);
        break;
      case 'PTW_DOWNLOAD_COMPLETE':
        this._handleDownloadComplete(data);
        break;
      case 'PTW_DOWNLOAD_ERROR':
        this._handleDownloadError(data);
        break;
      case 'PTW_CLEAR_COMPLETE':
        this._handleClearComplete(data);
        break;
      case 'PTW_CACHE_SIZE_RESULT':
        // Handled elsewhere if needed
        break;
    }
  }

  _handleDownloadProgress(data) {
    const { completed, total, failed, url, status } = data;
    const categoryId = this.downloadInProgress;

    if (categoryId && this.state.categories[categoryId]) {
      this.state.categories[categoryId].completed = completed;
      this.state.categories[categoryId].total = total;
      this.state.categories[categoryId].failed = failed;
      this._saveState();
      this._armDownloadStallTimer(categoryId);
    }

    if (this._progressCallback) {
      this._progressCallback({ completed, total, failed, url, status });
    }

    this._notify();
  }

  _handleDownloadComplete(data) {
    const { completed, total, failed, categoryId } = data;

    clearTimeout(this._downloadStallTimer);

    if (this.state.categories[categoryId]) {
      this.state.categories[categoryId].status = 'downloaded';
      this.state.categories[categoryId].downloadedAt = new Date().toISOString();
      this.state.categories[categoryId].completed = completed;
      this.state.categories[categoryId].total = total;
      this.state.categories[categoryId].failed = failed;
      this._saveState();
    }

    this.downloadInProgress = null;
    this._progressCallback = null;
    this._notify();

    if (this._downloadResolve) {
      this._downloadResolve({ completed, total, failed, categoryId });
      this._downloadResolve = null;
      this._downloadReject = null;
    }
  }

  _handleDownloadError(data) {
    const { error } = data;
    const categoryId = this.downloadInProgress;

    clearTimeout(this._downloadStallTimer);

    if (categoryId && this.state.categories[categoryId]) {
      this.state.categories[categoryId].status = 'error';
      this.state.categories[categoryId].error = error;
      this._saveState();
    }

    this.downloadInProgress = null;
    this._progressCallback = null;
    this._notify();

    if (this._downloadReject) {
      this._downloadReject(new Error(error));
      this._downloadResolve = null;
      this._downloadReject = null;
    }
  }

  _handleClearComplete(data) {
    const { categoryId } = data;
    this._notify();

    if (this._clearResolve) {
      this._clearResolve(data);
      this._clearResolve = null;
    }
  }

  // ── State Persistence ──────────────────────────────────────────

  _loadState() {
    try {
      const stored = localStorage.getItem(PTW_DOWNLOAD_STATE_KEY);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (err) {
      console.warn('Could not load download state:', err.message);
    }
    return this._createFreshState();
  }

  _createFreshState() {
    return {
      categories: {},
      manifestVersion: null
    };
  }

  _saveState() {
    try {
      localStorage.setItem(PTW_DOWNLOAD_STATE_KEY, JSON.stringify(this.state));
    } catch (err) {
      console.warn('Could not save download state:', err.message);
    }
  }

  // ── Utilities ──────────────────────────────────────────────────

  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // ── iOS Safari Considerations ──────────────────────────────────

  isIOSSafari() {
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
    return isIOS && isSafari;
  }

  getIOSWarning() {
    if (!this.isIOSSafari()) return null;

    return {
      title: 'iOS Safari Storage Limits',
      message: 'Safari on iOS has stricter storage limits (~1GB) and may clear cached data after 7 days of inactivity. For best results, download only the categories you need most.',
      suggestions: [
        'Download fewer categories at once',
        'Open the app at least once a week to prevent cache eviction',
        'Consider using Chrome on iOS for larger storage limits'
      ]
    };
  }
}

// Global instance
window.offlineDownloadManager = new OfflineDownloadManager();
