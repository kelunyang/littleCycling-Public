declare module 'incyclist-ant-plus/lib/bindings' {
  export class AntDevice {
    constructor(options?: Record<string, unknown>);
    open(): Promise<boolean>;
    close(): Promise<void>;
    getChannel(): any;
    getMaxChannels(): number;
    getDeviceNumber(): number;
  }
}

declare module '@stoprocent/noble' {
  import { EventEmitter } from 'events';

  interface Peripheral extends EventEmitter {
    id: string;
    uuid: string;
    address: string;
    advertisement: {
      localName?: string;
      serviceUuids?: string[];
    };
    connectAsync(): Promise<void>;
    disconnectAsync(): Promise<void>;
    discoverSomeServicesAndCharacteristicsAsync(
      serviceUuids: string[],
      characteristicUuids: string[]
    ): Promise<{ characteristics: Characteristic[] }>;
  }

  interface Characteristic extends EventEmitter {
    uuid: string;
    subscribeAsync(): Promise<void>;
    unsubscribeAsync(): Promise<void>;
  }

  interface Noble extends EventEmitter {
    state: string;
    waitForPoweredOn(timeout?: number): Promise<void>;
    startScanning(serviceUuids?: string[], allowDuplicates?: boolean, callback?: (err?: Error) => void): void;
    stopScanning(callback?: () => void): void;
    startScanningAsync(serviceUuids?: string[], allowDuplicates?: boolean): Promise<void>;
    stopScanningAsync(): Promise<void>;
    on(event: 'stateChange', listener: (state: string) => void): this;
    on(event: 'discover', listener: (peripheral: Peripheral) => void): this;
  }

  const noble: Noble;
  export default noble;
  export { Peripheral, Characteristic, Noble };
}
