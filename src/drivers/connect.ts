/**
 * One entry point for every driver-backed board: ask the browser for a
 * device, then hand it to the driver whose collection it exposes.
 */

import { isOpenHEDevice, OPENHE_HID_FILTER, OpenHEDriver } from './openhe/driver';
import {
  connectRongyuan,
  isRongyuanSettingsDevice,
  RY_HID_FILTERS,
  type FeatureHidDevice
} from './rongyuan/connect';
import { isSparklinkDevice, SL_HID_FILTERS, SparklinkDriver } from './sparklink/driver';
import type { HidDeviceLike } from './transport';
import { DriverError, type KeyboardDriver } from './types';

type NavigatorHid = {
  getDevices(): Promise<HidDeviceLike[]>;
  requestDevice(options: { filters: object[] }): Promise<HidDeviceLike[]>;
};

export function webHid(): NavigatorHid | null {
  const hid = (globalThis.navigator as { hid?: NavigatorHid } | undefined)?.hid;
  return hid ?? null;
}

export const DRIVER_HID_FILTERS: object[] = [
  OPENHE_HID_FILTER,
  ...RY_HID_FILTERS,
  ...SL_HID_FILTERS
];

export async function openDriver(
  device: HidDeviceLike,
  siblings: readonly HidDeviceLike[] = []
): Promise<KeyboardDriver> {
  if (isOpenHEDevice(device)) return OpenHEDriver.fromHidDevice(device);
  if (isRongyuanSettingsDevice(device))
    return connectRongyuan(device as FeatureHidDevice, siblings);
  if (isSparklinkDevice(device)) return SparklinkDriver.fromHidDevice(device);
  throw new DriverError(
    `${device.productName || 'This device'} is not a keyboard OpenHE can configure.`
  );
}

/** Pick the settings collection among the interfaces the browser returned. */
function pickSettings(devices: readonly HidDeviceLike[]): HidDeviceLike | null {
  return (
    devices.find(isOpenHEDevice) ??
    devices.find(isRongyuanSettingsDevice) ??
    devices.find(isSparklinkDevice) ??
    null
  );
}

/** Prompt for a keyboard and connect to it. */
export async function requestDriver(): Promise<KeyboardDriver | null> {
  const hid = webHid();
  if (!hid)
    throw new DriverError(
      'This browser has no WebHID. Use Chrome, Edge or another Chromium browser.'
    );
  const picked = await hid.requestDevice({ filters: DRIVER_HID_FILTERS });
  if (!picked.length) return null;
  const all = await hid.getDevices();
  const device = pickSettings(picked);
  if (!device) throw new DriverError('The selected device exposes no settings interface.');
  return openDriver(device, all);
}

/** Reconnect to a keyboard the user granted earlier, without a prompt. */
export async function restoreDriver(): Promise<KeyboardDriver | null> {
  const hid = webHid();
  if (!hid) return null;
  const all = await hid.getDevices();
  const device = pickSettings(all);
  return device ? openDriver(device, all) : null;
}
