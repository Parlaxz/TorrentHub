/** IPC channel names for the Client Mode bridge (shared by main + preload). */
export const ClientIpc = {
  getConnection: 'client:getConnection',
  pair: 'client:pair',
  forgetConnection: 'client:forgetConnection',
  connectionStatus: 'client:connectionStatus',
  createIntake: 'client:createIntake',
  getDraft: 'client:getDraft',
  cancelJob: 'client:cancelJob',
  confirmSelection: 'client:confirmSelection',
  startJob: 'client:startJob',
  getJob: 'client:getJob',
  retryPackaging: 'client:retryPackaging',
  retryUpload: 'client:retryUpload',
  retryStorageCheck: 'client:retryStorageCheck',
  listHistory: 'client:listHistory',
  copyText: 'client:copyText'
} as const
