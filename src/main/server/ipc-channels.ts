/** IPC channel names for the Server Mode bridge (shared by main + preload). */
export const ServerIpc = {
  getWorkingFolderStatus: 'server:getWorkingFolderStatus',
  setWorkingFolderPath: 'server:setWorkingFolderPath',
  chooseWorkingFolder: 'server:chooseWorkingFolder',
  getRadminStatus: 'server:getRadminStatus',
  selectRadminInterface: 'server:selectRadminInterface',
  probeQbittorrent: 'server:probeQbittorrent',
  getVikingConfig: 'server:getVikingConfig',
  setVikingUserHash: 'server:setVikingUserHash',
  startServer: 'server:startServer',
  stopServer: 'server:stopServer',
  getHealth: 'server:getHealth',
  generatePairingCode: 'server:generatePairingCode',
  listPairedClients: 'server:listPairedClients',
  revokePairedClient: 'server:revokePairedClient',
  resetProfile: 'server:resetProfile',
  sendDirectJob: 'server:sendDirectJob',
  listDirectJobs: 'server:listDirectJobs',
  getActiveJob: 'server:getActiveJob',
  getHistory: 'server:getHistory',
  getArchivedHistory: 'server:getArchivedHistory',
  setJobArchived: 'server:setJobArchived',
  copyText: 'server:copyText',
  openExternal: 'server:openExternal',
  dismissInterruptedJob: 'server:dismissInterruptedJob',
  cleanJobData: 'server:cleanJobData',
  openQBittorrentWebUi: 'server:openQBittorrentWebUi',
  getSettings: 'server:getSettings',
  updateSettings: 'server:updateSettings',
  setQbitApiKey: 'server:setQbitApiKey',
  capabilities: 'server:capabilities',
  requestAppExit: 'server:requestAppExit'
} as const

export const ServerEvents = {
  channel: 'server:event'
} as const
