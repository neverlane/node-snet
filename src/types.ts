export enum SNET_STATUSES {
  DISCONNECTED = 0,
  CONNECTED
}
export enum SNET_PRIORITES {
  BYPASS = 0,
  LOW,
  MEDIUM,
  HIGH,
  SYSTEM,
}
export const
  SNET_CONFIRM_PRIORITY = 0xFFFFFFFF,
  SNET_BLOCK_PACKET = 0xFFFFFFFF - 1;

export type IpVersion = 'v4' | 'v6';