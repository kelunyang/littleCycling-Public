/**
 * ANT+ USB stick connection manager.
 * Wraps incyclist-ant-plus AntDevice for open/close/channel operations.
 */

// incyclist-ant-plus is CJS; tsx handles ESM interop
import { AntDevice } from 'incyclist-ant-plus/lib/bindings';

export interface StickInfo {
  maxChannels: number;
  deviceNumber: number;
}

export interface AntConnectionOptions {
  /** Stick index when multiple sticks are connected (0 = first) */
  deviceNo?: number;
  /** Milliseconds to wait for stick startup */
  startupTimeout?: number;
  /** Enable debug logging from ANT+ library */
  debug?: boolean;
}

export class AntConnection {
  private ant: InstanceType<typeof AntDevice> | null = null;
  private deviceNo: number;
  private startupTimeout: number;
  private debug: boolean;

  constructor(options: AntConnectionOptions = {}) {
    this.deviceNo = options.deviceNo ?? 0;
    this.startupTimeout = options.startupTimeout ?? 5000;
    this.debug = options.debug ?? false;
  }

  /**
   * Open the ANT+ stick and return stick info.
   * Throws descriptive errors on failure.
   */
  async open(): Promise<StickInfo> {
    // Do NOT use detailedStartReport — it can cause open() to return undefined
    // and leave the channels array uninitialized.
    this.ant = new AntDevice({
      deviceNo: this.deviceNo,
      startupTimeout: this.startupTimeout,
      debug: this.debug,
    });

    let result: any;
    try {
      result = await this.ant.open();
    } catch (err: any) {
      throw new Error(
        `ANT+ stick open failed: ${err.message ?? err}\n` +
        'Make sure the stick is plugged in, no other app (Zwift, Garmin Express) is using it, ' +
        'and the correct driver is installed.\n' +
        'If using libusb0 driver, try switching to WinUSB via Zadig (https://zadig.akeo.ie/).'
      );
    }

    if (this.debug) {
      console.log(`      [debug] ant.open() returned: ${JSON.stringify(result)} (type: ${typeof result})`);
    }

    if (!result) {
      throw new Error(
        'ANT+ stick open failed (returned: ' + JSON.stringify(result) + ').\n' +
        'Possible causes:\n' +
        '  - The stick is not plugged in\n' +
        '  - Another app (Zwift, Garmin Express) is using the stick\n' +
        '  - Driver issue: try switching to WinUSB via Zadig (https://zadig.akeo.ie/)'
      );
    }

    let maxChannels: number;
    let deviceNumber: number;

    try {
      maxChannels = this.ant.getMaxChannels();
      deviceNumber = this.ant.getDeviceNumber();
    } catch (err: any) {
      throw new Error(
        `ANT+ stick opened but failed to query device info: ${err.message}\n` +
        'The stick may not have initialized properly. Try unplugging and re-plugging.'
      );
    }

    if (this.debug) {
      console.log(`      [debug] maxChannels: ${maxChannels}, deviceNumber: ${deviceNumber}`);
    }

    if (!maxChannels || maxChannels <= 0) {
      throw new Error(
        `ANT+ stick reports 0 channels (maxChannels: ${maxChannels}).\n` +
        'The ANT protocol startup handshake likely failed.\n' +
        'Fix: use Zadig (https://zadig.akeo.ie/) to switch the ANT+ stick driver to WinUSB.'
      );
    }

    return { maxChannels, deviceNumber };
  }

  /**
   * Reserve and return the next available ANT+ channel.
   */
  getChannel() {
    if (!this.ant) {
      throw new Error('ANT+ stick not opened. Call open() first.');
    }

    const channel = this.ant.getChannel();
    if (!channel) {
      throw new Error('No ANT+ channels available.');
    }

    return channel;
  }

  /**
   * Close the ANT+ stick and release all channels. Idempotent.
   */
  async close(): Promise<void> {
    if (this.ant) {
      try {
        await this.ant.close();
      } catch {
        // Ignore close errors during shutdown
      }
      this.ant = null;
    }
  }
}
