/**
 * The settings that belong to this machine and never travel in the kept
 * backup, in either direction: main's own copy of the renderer's
 * `NON_TRANSFERABLE_SETTINGS` (store/modules/settings.js), which main cannot
 * import, plus what main alone keeps in the settings datastore.
 *
 * A renderer test (machineBound.test.js beside the settings store) fails when
 * this copy and upstream's list part ways, so an upstream sync that adds a
 * machine-bound setting is caught.
 */

/** In the settings datastore, never in the renderer's store */
export const MAIN_ONLY_SETTINGS = Object.freeze(['bounds'])

/** @type {ReadonlySet<string>} */
export const MACHINE_BOUND_SETTINGS = new Set([
  // ProxySettings
  'useProxy',
  'proxyProtocol',
  'proxyHostname',
  'proxyPort',
  'proxyUsername',
  'proxyPassword',
  // ExternalPlayerSettings
  'externalPlayer',
  'externalPlayerExecutable',
  'externalPlayerIgnoreWarnings',
  'externalPlayerIgnoreDefaultArgs',
  'externalPlayerCustomArgs',
  'showAddedExternalPlayerCustomArgs',
  // Others
  'disableSmoothScrolling',
  'framelessWindow',
  'fitWindowToVideo',
  'hideToTrayOnMinimize',
  'handleFreeTubeLinks',
  'screenshotAskPath',
  'screenshotFolderPath',
  // YtDlpSettings
  'ytDlpEnabled',
  'ytDlpDownloadFolder',
  'ytDlpExecutablePath',
  'ytDlpCustomArgs',
  // Backup
  'installationId',
  'backupFolder',
  // Local API
  'backendFallback',
  'backendPreference',
  'proxyVideos',
  ...MAIN_ONLY_SETTINGS,
])
