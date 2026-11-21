export enum SNET_STATUSES {
  DISCONNECTED = 0,
  CONNECTED,
}

export enum SNET_PRIORITIES {
  BYPASS = 0,
  LOW,
  MEDIUM,
  HIGH,
  SYSTEM,
}

/** @deprecated typo kept for v1 compatibility, use SNET_PRIORITIES */
export const SNET_PRIORITES = SNET_PRIORITIES;
/** @deprecated typo kept for v1 compatibility, use SNET_PRIORITIES */
export type SNET_PRIORITES = SNET_PRIORITIES;

/** service packet ids, same as Lua SNET */
export const
  SNET_CONFIRM_PRIORITY = 0xFFFFFFFF,
  SNET_BLOCK_PACKET = 0xFFFFFFFF - 1;

export const isServicePacket = (packetId: number) =>
  packetId === SNET_CONFIRM_PRIORITY || packetId === SNET_BLOCK_PACKET;

/** how many times a packet of given priority is re-sent before it is dropped (Lua SNET values) */
export const SNET_RESEND_LIMITS: Record<SNET_PRIORITIES, number> = {
  [SNET_PRIORITIES.BYPASS]: 0,
  [SNET_PRIORITIES.LOW]: 5,
  [SNET_PRIORITIES.MEDIUM]: 10,
  [SNET_PRIORITIES.HIGH]: 20,
  /** SYSTEM is re-sent until the remote side disconnects */
  [SNET_PRIORITIES.SYSTEM]: Infinity,
};

export type IpVersion = 'v4' | 'v6';

export type CamelToPascal<T extends string> =
  T extends `${infer FirstChar}${infer Rest}`
    ? `${Capitalize<FirstChar>}${Rest}`
    : never;

export type SupportedEventNames<T extends string> = T | `on${CamelToPascal<T>}`;
